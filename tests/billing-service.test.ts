import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBillingCheckout, getBillingSummary, handleBillingWebhook } from '@/lib/openwook/billing';

const sqlState = vi.hoisted(() => ({
  queryResults: [] as unknown[][],
  queries: [] as string[],
  txQueries: [] as string[]
}));

function normalizeSql(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

function renderSql(strings: TemplateStringsArray, values: unknown[]) {
  return strings.reduce(
    (query, chunk, index) => query + chunk + (index < values.length ? `__value_${index}__` : ''),
    ''
  );
}

const paddleMocks = vi.hoisted(() => ({
  transactionCreate: vi.fn(),
  webhookUnmarshal: vi.fn()
}));

const authMocks = vi.hoisted(() => ({
  invalidateUserCache: vi.fn()
}));

const sqlMock = vi.hoisted(() => {
  const fn = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlState.queries.push(normalizeSql(renderSql(strings, values)));
    return Promise.resolve(sqlState.queryResults.shift() ?? []);
  }) as unknown as {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
    begin: (handler: (tx: typeof fn) => Promise<unknown>) => Promise<unknown>;
    json: (value: unknown) => unknown;
  };

  fn.begin = async (handler: (tx: typeof fn) => Promise<unknown>) => {
    const tx = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      sqlState.txQueries.push(normalizeSql(renderSql(strings, values)));
      return Promise.resolve([]);
    }) as unknown as typeof fn;
    tx.json = (value: unknown) => value as never;
    return handler(tx);
  };
  fn.json = (value: unknown) => value as never;

  return fn;
});

vi.mock('@paddle/paddle-node-sdk', () => ({
  Environment: {
    production: 'production',
    sandbox: 'sandbox'
  },
  Paddle: vi.fn(function PaddleMock() {
    return {
      transactions: {
        create: paddleMocks.transactionCreate
      },
      webhooks: {
        unmarshal: paddleMocks.webhookUnmarshal
      }
    };
  })
}));

vi.mock('@/lib/openwook/auth', () => ({
  invalidateUserCache: authMocks.invalidateUserCache
}));

vi.mock('@/lib/openwook/db', () => ({
  sql: sqlMock
}));

describe('billing service', () => {
  beforeEach(() => {
    sqlState.queryResults = [];
    sqlState.queries = [];
    sqlState.txQueries = [];
    paddleMocks.transactionCreate.mockReset();
    paddleMocks.webhookUnmarshal.mockReset();
    authMocks.invalidateUserCache.mockReset();

    process.env.PADDLE_API_KEY = 'pdl_test_key';
    process.env.PADDLE_CLIENT_TOKEN = 'test_client_token';
    process.env.PADDLE_WEBHOOK_SECRET = 'pdl_ntf_secret';
    process.env.PADDLE_ENVIRONMENT = 'sandbox';
    process.env.PADDLE_PLUS_PRICE_ID = 'pri_plus';
    process.env.PADDLE_PLUS_LABEL = 'Plus';
    process.env.PADDLE_PLUS_AMOUNT_CENTS = '1900';
    process.env.PADDLE_PLUS_CURRENCY_CODE = 'USD';
    process.env.PADDLE_PLUS_INTERVAL = 'month';
    process.env.PADDLE_ENTERPRISE_PRICE_ID = 'pri_enterprise';
    process.env.PADDLE_ENTERPRISE_LABEL = 'Enterprise';
    process.env.PADDLE_ENTERPRISE_AMOUNT_CENTS = '9900';
    process.env.PADDLE_ENTERPRISE_CURRENCY_CODE = 'USD';
    process.env.PADDLE_ENTERPRISE_INTERVAL = 'year';
  });

  afterEach(() => {
    delete process.env.PADDLE_API_KEY;
    delete process.env.PADDLE_CLIENT_TOKEN;
    delete process.env.PADDLE_WEBHOOK_SECRET;
    delete process.env.PADDLE_ENVIRONMENT;
    delete process.env.PADDLE_PLUS_PRICE_ID;
    delete process.env.PADDLE_PLUS_LABEL;
    delete process.env.PADDLE_PLUS_AMOUNT_CENTS;
    delete process.env.PADDLE_PLUS_CURRENCY_CODE;
    delete process.env.PADDLE_PLUS_INTERVAL;
    delete process.env.PADDLE_ENTERPRISE_PRICE_ID;
    delete process.env.PADDLE_ENTERPRISE_LABEL;
    delete process.env.PADDLE_ENTERPRISE_AMOUNT_CENTS;
    delete process.env.PADDLE_ENTERPRISE_CURRENCY_CODE;
    delete process.env.PADDLE_ENTERPRISE_INTERVAL;
  });

  it('creates a Paddle checkout transaction and stores the latest transaction id', async () => {
    paddleMocks.transactionCreate.mockResolvedValue({
      id: 'txn_123',
      customerId: 'ctm_123'
    });

    const result = await createBillingCheckout({
      id: 7,
      username: 'tester',
      email: 'tester@example.com',
      avatar_url: null,
      is_active: true,
      role: 'user',
      membership: 'free',
      plus_trial_ends_at: null,
      plus_expires_at: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z'
    }, 'enterprise');

    expect(paddleMocks.transactionCreate).toHaveBeenCalledWith({
      items: [{ priceId: 'pri_enterprise', quantity: 1 }],
      collectionMode: 'automatic',
      customData: { userId: 7, planKey: 'enterprise' }
    });
    expect(sqlState.txQueries.some((query) => query.includes('INSERT INTO billing_subscriptions'))).toBe(true);
    expect(authMocks.invalidateUserCache).toHaveBeenCalledWith(7);
    expect(result).toEqual({
      checkout: {
        transactionId: 'txn_123',
        clientToken: 'test_client_token',
        environment: 'sandbox'
      }
    });
  });

  it('verifies a Paddle webhook and syncs enterprise membership state', async () => {
    paddleMocks.webhookUnmarshal.mockResolvedValue({
      eventType: 'subscription.updated',
      data: {
        id: 'sub_123',
        customerId: 'ctm_123',
        status: 'active',
        items: [{ priceId: 'pri_enterprise', quantity: 1 }],
        currentBillingPeriod: {
          startsAt: '2026-01-01T00:00:00.000Z',
          endsAt: '2027-01-01T00:00:00.000Z'
        },
        customData: {
          userId: 7,
          planKey: 'enterprise'
        }
      }
    });

    await handleBillingWebhook('{"event_type":"subscription.updated"}', 'ts=123;h1=abc');

    expect(paddleMocks.webhookUnmarshal).toHaveBeenCalledWith('{"event_type":"subscription.updated"}', 'pdl_ntf_secret', 'ts=123;h1=abc');
    expect(sqlState.txQueries.some((query) => query.includes('INSERT INTO billing_subscriptions'))).toBe(true);
    expect(sqlState.txQueries.some((query) => query.includes('UPDATE users SET membership'))).toBe(true);
    expect(authMocks.invalidateUserCache).toHaveBeenCalledWith(7);
  });

  it('returns billing summary data from the synced subscription row', async () => {
    sqlState.queryResults.push([
      {
        membership: 'enterprise',
        status: 'active',
        source: 'paddle',
        paddle_subscription_id: 'sub_123',
        paddle_transaction_id: 'txn_123',
        paddle_price_id: 'pri_enterprise',
        current_period_ends_at: '2027-01-01T00:00:00.000Z'
      }
    ]);

    const summary = await getBillingSummary({
      id: 7,
      username: 'tester',
      email: 'tester@example.com',
      avatar_url: null,
      is_active: true,
      role: 'user',
      membership: 'enterprise',
      plus_trial_ends_at: null,
      plus_expires_at: '2027-01-01T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z'
    });

    expect(sqlState.queries.some((query) => query.includes('FROM billing_subscriptions'))).toBe(true);
    expect(summary).toEqual({
      billing: {
        configured: true,
        environment: 'sandbox',
        plans: [
          {
            planKey: 'plus',
            label: 'Plus',
            priceId: 'pri_plus',
            amountCents: 1900,
            currencyCode: 'USD',
            interval: 'month',
            trialDays: 7
          },
          {
            planKey: 'enterprise',
            label: 'Enterprise',
            priceId: 'pri_enterprise',
            amountCents: 9900,
            currencyCode: 'USD',
            interval: 'year',
            trialDays: 14
          }
        ],
        subscription: {
          membership: 'enterprise',
          status: 'active',
          source: 'paddle',
          currentPeriodEndsAt: '2027-01-01T00:00:00.000Z',
          paddleSubscriptionId: 'sub_123',
          paddleTransactionId: 'txn_123',
          paddlePriceId: 'pri_enterprise'
        }
      }
    });
  });
});
