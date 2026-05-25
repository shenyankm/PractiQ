import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  token: 'session-token',
  user: {
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
  }
}));

const mocks = vi.hoisted(() => ({
  verifySessionToken: vi.fn(),
  signSessionToken: vi.fn(),
  redisGetJson: vi.fn(),
  redisGetOrSetJson: vi.fn(),
  redisSetJson: vi.fn(),
  redisDel: vi.fn(),
  sql: vi.fn()
}));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');

  return {
    ...actual,
    cache: <T extends (...args: unknown[]) => unknown>(fn: T): T => {
      const values = new Map<string, unknown>();

      return ((...args: unknown[]) => {
        const key = JSON.stringify(args);
        if (!values.has(key)) values.set(key, fn(...args));
        return values.get(key);
      }) as T;
    }
  };
});

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => name === 'session' && state.token ? { value: state.token } : undefined,
    set: vi.fn(),
    delete: vi.fn()
  })
}));

vi.mock('@/lib/openwook/session', () => ({
  signSessionToken: mocks.signSessionToken,
  verifySessionToken: mocks.verifySessionToken
}));

vi.mock('@/lib/openwook/redis', () => ({
  redisDel: mocks.redisDel,
  redisGetJson: mocks.redisGetJson,
  redisGetOrSetJson: mocks.redisGetOrSetJson,
  redisKey: (...parts: Array<string | number>) => parts.join(':'),
  redisSetJson: mocks.redisSetJson
}));

vi.mock('@/lib/openwook/db', () => ({
  sql: mocks.sql
}));

describe('getCurrentUser request cache', () => {
  beforeEach(() => {
    vi.resetModules();
    state.token = `session-token-${Date.now()}`;
    mocks.verifySessionToken.mockReset();
    mocks.signSessionToken.mockReset();
    mocks.redisGetJson.mockReset();
    mocks.redisGetOrSetJson.mockReset();
    mocks.redisSetJson.mockReset();
    mocks.redisDel.mockReset();
    mocks.sql.mockReset();

    mocks.verifySessionToken.mockResolvedValue({
      user: { id: state.user.id },
      expires: new Date(Date.now() + 60_000).toISOString(),
      jti: 'session-jti'
    });
    mocks.redisGetJson.mockResolvedValue(null);
    mocks.redisGetOrSetJson.mockImplementation(async (_key, _ttl, loader) => loader());
    mocks.sql.mockResolvedValue([state.user]);
  });

  it('deduplicates user lookup work for the same session token', async () => {
    const { getCurrentUser } = await import('@/lib/openwook/auth');

    const [first, second] = await Promise.all([getCurrentUser(), getCurrentUser()]);

    expect(first).toEqual(state.user);
    expect(second).toEqual(state.user);
    expect(mocks.verifySessionToken).toHaveBeenCalledTimes(1);
    expect(mocks.sql).toHaveBeenCalledTimes(1);
  });
});
