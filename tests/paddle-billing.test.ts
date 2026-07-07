import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BillingSubscriptionRow } from '@/lib/openwook/billing';
import { getBillingConfig, normalizeBillingSubscription, planKeyForPriceId } from '@/lib/openwook/billing';
import { hasPlusEntitlement } from '@/lib/openwook/permissions';

const originalEnv = { ...process.env };

function applyBillingEnv() {
  process.env.PADDLE_API_KEY = 'pdl_test_key';
  process.env.PADDLE_CLIENT_TOKEN = 'test_client_token';
  process.env.PADDLE_WEBHOOK_SECRET = 'pdl_ntf_test_secret';
  process.env.PADDLE_ENVIRONMENT = 'sandbox';

  process.env.PADDLE_PLUS_PRICE_ID = 'pri_plus';
  process.env.PADDLE_PLUS_LABEL = 'Plus';
  process.env.PADDLE_PLUS_AMOUNT_CENTS = '1900';
  process.env.PADDLE_PLUS_CURRENCY_CODE = 'USD';
  process.env.PADDLE_PLUS_INTERVAL = 'month';
  process.env.PADDLE_PLUS_TRIAL_DAYS = '7';

  process.env.PADDLE_ENTERPRISE_PRICE_ID = 'pri_enterprise';
  process.env.PADDLE_ENTERPRISE_LABEL = 'Enterprise';
  process.env.PADDLE_ENTERPRISE_AMOUNT_CENTS = '9900';
  process.env.PADDLE_ENTERPRISE_CURRENCY_CODE = 'USD';
  process.env.PADDLE_ENTERPRISE_INTERVAL = 'year';
  process.env.PADDLE_ENTERPRISE_TRIAL_DAYS = '14';
}

describe('Paddle billing catalog', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    applyBillingEnv();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns env-driven paid plans and configuration', () => {
    expect(getBillingConfig()).toEqual({
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
      ]
    });
  });

  it('normalizes a missing paid subscription row to the free tier', () => {
    expect(normalizeBillingSubscription('free', null)).toEqual({
      membership: 'free',
      status: 'inactive',
      source: 'free',
      currentPeriodEndsAt: null,
      paddleSubscriptionId: null,
      paddleTransactionId: null,
      paddlePriceId: null
    });
  });

  it('maps Paddle price ids back to plan keys and preserves synced subscription state', () => {
    const row: BillingSubscriptionRow = {
      membership: 'enterprise',
      status: 'active',
      source: 'paddle',
      paddle_subscription_id: 'sub_123',
      paddle_transaction_id: 'txn_123',
      paddle_price_id: 'pri_enterprise',
      current_period_ends_at: '2027-01-01T00:00:00.000Z'
    };

    expect(planKeyForPriceId('pri_plus')).toBe('plus');
    expect(planKeyForPriceId('pri_enterprise')).toBe('enterprise');
    expect(normalizeBillingSubscription('free', row)).toEqual({
      membership: 'enterprise',
      status: 'active',
      source: 'paddle',
      currentPeriodEndsAt: '2027-01-01T00:00:00.000Z',
      paddleSubscriptionId: 'sub_123',
      paddleTransactionId: 'txn_123',
      paddlePriceId: 'pri_enterprise'
    });
  });

  it('treats enterprise access as satisfying Plus-gated checks while active', () => {
    expect(hasPlusEntitlement({
      role: 'user',
      membership: 'enterprise',
      plus_trial_ends_at: null,
      plus_expires_at: '2099-01-01T00:00:00.000Z'
    })).toBe(true);

    expect(hasPlusEntitlement({
      role: 'user',
      membership: 'enterprise',
      plus_trial_ends_at: null,
      plus_expires_at: '2000-01-01T00:00:00.000Z'
    })).toBe(false);
  });
});
