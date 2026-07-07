import { existsSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  createBank: vi.fn(),
  created: vi.fn((body: unknown) => Response.json({ data: body }, { status: 201 })),
  handleApiError: vi.fn((error: unknown) => Response.json({ error }, { status: 500 })),
  listBanks: vi.fn(),
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

vi.mock('@/lib/openwook/observability', () => ({
  withApiObservability: mocks.withApiObservability
}));

vi.mock('@/lib/openwook/request-origin', () => ({
  assertSameOriginRequest: mocks.assertSameOriginRequest
}));

vi.mock('@/lib/openwook/services', () => ({
  createBank: mocks.createBank,
  listBanks: mocks.listBanks
}));

async function loadBanksRoute() {
  expect(existsSync('app/api/v1/banks/route.ts')).toBe(true);
  return import('@/app/api/v1/banks/route');
}

describe('banks API routes', () => {
  beforeEach(() => {
    mocks.assertSameOriginRequest.mockReset();
    mocks.createBank.mockReset();
    mocks.created.mockClear();
    mocks.handleApiError.mockClear();
    mocks.listBanks.mockReset();
    mocks.ok.mockClear();
    mocks.readJson.mockReset();
    mocks.requireUser.mockReset();
    mocks.withApiObservability.mockClear();

    mocks.requireUser.mockResolvedValue(state.user);
  });

  it('lists banks through the dedicated banks route', async () => {
    const banks = [{ id: 11, name: 'Biology 101' }];
    mocks.listBanks.mockResolvedValue({ banks });
    const { GET } = await loadBanksRoute();

    const response = await GET(new Request('https://example.com/api/v1/banks?subject=biology'));

    expect(mocks.withApiObservability).toHaveBeenCalledWith(expect.any(Request), '/api/v1/banks', expect.any(Function));
    expect(mocks.listBanks).toHaveBeenCalledTimes(1);
    expect(mocks.listBanks.mock.calls[0]?.[0]).toBe(state.user);
    expect(mocks.listBanks.mock.calls[0]?.[1]).toBeInstanceOf(URLSearchParams);
    expect(mocks.listBanks.mock.calls[0]?.[1].get('subject')).toBe('biology');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { banks } });
  });

  it('creates banks through the dedicated banks route', async () => {
    const payload = {
      name: 'Biology 101',
      description: 'Cell structures',
      subject: 'biology',
      isPublic: true
    };
    const createdBank = { bank: { id: 11, ...payload } };
    mocks.readJson.mockResolvedValue(payload);
    mocks.createBank.mockResolvedValue(createdBank);
    const { POST } = await loadBanksRoute();

    const response = await POST(new Request('https://example.com/api/v1/banks', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://example.com'
      },
      body: JSON.stringify(payload)
    }));

    expect(mocks.withApiObservability).toHaveBeenCalledWith(expect.any(Request), '/api/v1/banks', expect.any(Function));
    expect(mocks.assertSameOriginRequest).toHaveBeenCalledTimes(1);
    expect(mocks.createBank).toHaveBeenCalledWith(state.user, payload);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ data: createdBank });
  });
});
