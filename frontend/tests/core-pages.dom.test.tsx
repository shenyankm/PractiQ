// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import BanksPage from '@/pages/BanksPage';

const mocks = vi.hoisted(() => ({ apiRequest: vi.fn() }));

vi.mock('@/lib/api', () => ({
  apiRequest: mocks.apiRequest,
  apiRequestPage: async (...args: unknown[]) => ({
    data: await mocks.apiRequest(...args),
    cursor: '',
    hasMore: false,
    limit: 0
  })
}));

beforeEach(() => {
  mocks.apiRequest.mockReset();
});

it('loads and renders the signed-in user bank list', async () => {
  mocks.apiRequest.mockResolvedValueOnce([{
    id: 7,
    name: '代数基础',
    subject: 'math',
    total_count: 12,
    is_public: false
  }]);

  render(<BanksPage />);

  expect(await screen.findByText('代数基础')).toBeTruthy();
  expect(mocks.apiRequest.mock.calls[0]?.[0]).toBe('/api/v1/banks?scope=mine&q=');
});
