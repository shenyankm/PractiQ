import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as getBillingSummary } from '@/app/api/v1/billing/summary/route';
import { POST as createCheckout } from '@/app/api/v1/billing/checkout/route';
import { POST as receiveWebhook } from '@/app/api/v1/billing/webhook/route';

const state = vi.hoisted(() => ({
  user: {
    id: 7,
    username: 'tester',
    email: 'tester@example.com',
    avatar_url: null,
    is_active: true,
    role: 'user' as const,
    membership: 'free' as const,
    plus_trial_ends_at: null,
    plus_expires_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z'
  }
}));

const mocks = vi.hoisted(() => ({
  assertSameOriginRequest: vi.fn(),
  createBillingCheckout: vi.fn(),
  created: vi.fn((body: unknown) => Response.json({ data: body }, { status: 201 })),
  getBillingSummary: vi.fn(),
  handleApiError: vi.fn((error: unknown) => Response.json({ error }, { status: 500 })),
  handleBillingWebhook: vi.fn(),
  ok: vi.fn((body: unknown) => Response.json({ data: body })),
  readJson: vi.fn(),
  requireUser: vi.fn(),
  withApiObservability: vi.fn((_request: Request, _name: string, handler: () => Promise<Response> | Response) => handler())
}));

vi.mock('@/lib/openwook/auth', () => ({
  requireUser: mocks.requireUser
}));

vi.mock('@/lib/openwook/api', () => ({
  created: mocks.created,
  handleApiError: mocks.handleApiError,
  ok: mocks.ok,
  readJson: mocks.readJson
}));

vi.mock('@/lib/openwook/billing', () => ({
  createBillingCheckout: mocks.createBillingCheckout,
  getBillingSummary: mocks.getBillingSummary,
  handleBillingWebhook: mocks.handleBillingWebhook
}));

vi.mock('@/lib/openwook/observability', () => ({
  withApiObservability: mocks.withApiObservability
}));

vi.mock('@/lib/openwook/request-origin', () => ({
  assertSameOriginRequest: mocks.assertSameOriginRequest
}));

describe('billing API routes', () => {
  beforeEach(() => {
    mocks.assertSameOriginRequest.mockReset();
    mocks.createBillingCheckout.mockReset();
    mocks.created.mockClear();
    mocks.getBillingSummary.mockReset();
    mocks.handleApiError.mockClear();
    mocks.handleBillingWebhook.mockReset();
    mocks.ok.mockClear();
    mocks.readJson.mockReset();
    mocks.requireUser.mockReset();
    mocks.withApiObservability.mockClear();

    mocks.requireUser.mockResolvedValue(state.user);
  });

  it('creates a checkout for the requested paid plan', async () => {
    const checkout = {
      transactionId: 'txn_123',
      clientToken: 'test_client_token',
      environment: 'sandbox' as const
    };
    mocks.readJson.mockResolvedValue({ planKey: 'enterprise' });
    mocks.createBillingCheckout.mockResolvedValue({ checkout });

    const response = await createCheckout(new Request('https://example.com/api/v1/billing/checkout', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://example.com'
      },
      body: JSON.stringify({ planKey: 'enterprise' })
    }));

    expect(mocks.assertSameOriginRequest).toHaveBeenCalledTimes(1);
    expect(mocks.createBillingCheckout).toHaveBeenCalledWith(state.user, 'enterprise');
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ data: { checkout } });
  });

  it('returns billing summary data under the billing key', async () => {
    const billing = {
      environment: 'sandbox' as const,
      configured: true,
      plans: [
        {
          planKey: 'plus' as const,
          label: 'Plus',
          priceId: 'pri_plus',
          amountCents: 1900,
          currencyCode: 'USD',
          interval: 'month' as const,
          trialDays: 7
        }
      ],
      subscription: {
        membership: 'free' as const,
        status: 'inactive' as const,
        source: 'free' as const,
        currentPeriodEndsAt: null,
        paddleSubscriptionId: null,
        paddleTransactionId: null,
        paddlePriceId: null
      }
    };
    mocks.getBillingSummary.mockResolvedValue({ billing });

    const response = await getBillingSummary(new Request('https://example.com/api/v1/billing/summary'));

    expect(mocks.getBillingSummary).toHaveBeenCalledWith(state.user);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { billing } });
  });

  it('verifies webhooks from the raw request body and signature header', async () => {
    mocks.handleBillingWebhook.mockResolvedValue(undefined);
    const rawBody = JSON.stringify({ event_type: 'subscription.updated' });

    const response = await receiveWebhook(new Request('https://example.com/api/v1/billing/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'paddle-signature': 'ts=123;h1=abc'
      },
      body: rawBody
    }));

    expect(mocks.handleBillingWebhook).toHaveBeenCalledWith(rawBody, 'ts=123;h1=abc');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });
});
