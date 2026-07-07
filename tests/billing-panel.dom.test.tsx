// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingPanel } from '@/app/(openwook)/settings/billing-panel';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  initializePaddle: vi.fn(),
  checkoutOpen: vi.fn()
}));

const originalFetch = globalThis.fetch;

vi.mock('@paddle/paddle-js', () => ({
  initializePaddle: mocks.initializePaddle
}));

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify(data), {
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
    mocks.fetch.mockReset();
    mocks.initializePaddle.mockReset();
    mocks.checkoutOpen.mockReset();

    mocks.initializePaddle.mockResolvedValue({
      Checkout: {
        open: mocks.checkoutOpen
      }
    });
    mocks.fetch
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
          data: {
            checkout: {
              transactionId: 'txn_plus',
              clientToken: 'ctkn_plus',
              environment: 'sandbox'
            }
          }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            checkout: {
              transactionId: 'txn_enterprise',
              clientToken: 'ctkn_enterprise',
              environment: 'sandbox'
            }
          }
        })
      );

    globalThis.fetch = mocks.fetch as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('fetches billing summary, only posts paid plan keys, and opens Paddle checkout', async () => {
    render(<BillingPanel />);

    expect((await screen.findAllByText('Free')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Plus').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Enterprise').length).toBeGreaterThan(0);
    expect(requestPath(mocks.fetch.mock.calls[0][0] as RequestInfo | URL)).toBe('/api/v1/billing/summary');

    const plusButton = screen.getByRole('button', { name: /plus/i });
    const enterpriseButton = screen.getByRole('button', { name: /enterprise/i });

    expect(screen.queryByRole('button', { name: /free/i })).toBeNull();

    fireEvent.click(plusButton);

    const plusCall = mocks.fetch.mock.calls[1];
    expect(requestPath(plusCall[0] as RequestInfo | URL)).toBe('/api/v1/billing/checkout');
    expect(plusCall[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String((plusCall[1] as RequestInit).body))).toEqual({ planKey: 'plus' });

    await waitFor(() => {
      expect(mocks.initializePaddle).toHaveBeenCalledWith({
        token: 'ctkn_plus',
        environment: 'sandbox'
      });
      expect(mocks.checkoutOpen).toHaveBeenCalledWith({ transactionId: 'txn_plus' });
    });

    fireEvent.click(enterpriseButton);

    const enterpriseCall = mocks.fetch.mock.calls[2];
    expect(requestPath(enterpriseCall[0] as RequestInfo | URL)).toBe('/api/v1/billing/checkout');
    expect(enterpriseCall[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String((enterpriseCall[1] as RequestInit).body))).toEqual({ planKey: 'enterprise' });

    await waitFor(() => {
      expect(mocks.checkoutOpen).toHaveBeenLastCalledWith({ transactionId: 'txn_enterprise' });
    });

    expect(mocks.fetch).toHaveBeenCalledTimes(3);
  });
});
