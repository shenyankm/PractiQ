// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsPage from '@/app/(openwook)/settings/page';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  getCurrentUser: vi.fn(),
  getAnalyticsSummary: vi.fn()
}));

const originalFetch = globalThis.fetch;

vi.mock('@/lib/openwook/auth', () => ({
  getCurrentUser: mocks.getCurrentUser
}));

vi.mock('@/lib/openwook/services', () => ({
  getAnalyticsSummary: mocks.getAnalyticsSummary
}));

vi.mock('@/lib/openwook/remote-images', () => ({
  isConfiguredRemoteImageUrl: () => false
}));

vi.mock('@/app/(openwook)/settings/settings-forms', () => ({
  ProfileSettingsCard: () => <div>资料表单</div>,
  PasswordSettingsCard: () => <div>密码表单</div>
}));

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('Settings billing surface', () => {
  beforeEach(() => {
    mocks.getCurrentUser.mockReset();
    mocks.getAnalyticsSummary.mockReset();
    mocks.fetch.mockReset();

    mocks.getCurrentUser.mockResolvedValue({
      username: 'tester',
      email: 'tester@example.test',
      avatar_url: null,
      role: 'user',
      membership: 'free',
      plus_trial_ends_at: null,
      plus_expires_at: null,
      is_active: true
    });
    mocks.getAnalyticsSummary.mockResolvedValue({
      owned_banks: 3,
      attempts: 18,
      accuracy: 94
    });
    mocks.fetch.mockResolvedValue(
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
    );

    globalThis.fetch = mocks.fetch as typeof fetch;
  });

  it('shows Free, Plus, and Enterprise pricing in the membership tab', async () => {
    render(await SettingsPage());

    fireEvent.click(screen.getByRole('tab', { name: '会员' }));

    expect(await screen.findByText('Free')).toBeTruthy();
    expect(screen.getByText('Plus')).toBeTruthy();
    expect(screen.getByText('Enterprise')).toBeTruthy();
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});
