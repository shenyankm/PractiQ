// @vitest-environment jsdom

import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PricingPage from '@/app/pricing/page';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getBillingConfig: vi.fn()
}));

vi.mock('@/lib/openwook/auth', () => ({
  getCurrentUser: mocks.getCurrentUser
}));

vi.mock('@/lib/openwook/billing', () => ({
  getBillingConfig: mocks.getBillingConfig
}));

vi.mock('@/app/(openwook)/settings/billing-panel', () => ({
  BillingPanel: () => <div>Billing panel</div>
}));

describe('PricingPage', () => {
  beforeEach(() => {
    mocks.getCurrentUser.mockReset();
    mocks.getBillingConfig.mockReset();

    mocks.getCurrentUser.mockResolvedValue(null);
    mocks.getBillingConfig.mockReturnValue({
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

  it('renders Free, Plus, and Enterprise without loading billing config for signed-out visitors', async () => {
    render(await PricingPage());

    expect(screen.getByText('Free')).toBeTruthy();
    expect(screen.getByText('Plus')).toBeTruthy();
    expect(screen.getByText('Enterprise')).toBeTruthy();
    expect(mocks.getBillingConfig).not.toHaveBeenCalled();
  });
});
