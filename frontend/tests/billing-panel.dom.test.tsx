// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingPanel } from '@/pages/settings/BillingPanel';

const fetchMock = vi.hoisted(() => vi.fn());
const originalFetch = globalThis.fetch;

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function requestPath(input: RequestInfo | URL) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.pathname;

  return new URL(input.url).pathname;
}

describe('BillingPanel', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            billing: {
              environment: 'sandbox',
              configured: true,
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
                membership: 'free',
                status: 'inactive',
                source: 'free',
                currentPeriodEndsAt: null,
                paddleSubscriptionId: null,
                paddleTransactionId: null,
                paddlePriceId: null
              }
            }
          }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          error: {
            message: 'checkout unavailable'
          }
        }, 500)
      );

    globalThis.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('fetches billing summary and posts the selected paid plan key to checkout', async () => {
    render(<BillingPanel />);

    expect(await screen.findByRole('button', { name: /plus/i })).toBeTruthy();
    expect(requestPath(fetchMock.mock.calls[0][0] as RequestInfo | URL)).toBe('/api/v1/billing/summary');

    fireEvent.click(screen.getByRole('button', { name: /plus/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const checkoutCall = fetchMock.mock.calls[1] as [RequestInfo | URL, RequestInit];
    expect(requestPath(checkoutCall[0])).toBe('/api/v1/billing/checkout');
    expect(checkoutCall[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(checkoutCall[1].body))).toEqual({ planKey: 'plus' });
  });
});
