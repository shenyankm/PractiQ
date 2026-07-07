import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signIn, signUp } from '@/app/(login)/actions';

const state = vi.hoisted(() => ({
  headers: new Headers()
}));

const mocks = vi.hoisted(() => ({
  assertSameOriginFromHeaders: vi.fn(),
  clearSession: vi.fn(),
  comparePasswords: vi.fn(),
  getUserPasswordByLogin: vi.fn(),
  hashPassword: vi.fn(),
  incrementRateLimit: vi.fn(),
  redirect: vi.fn(),
  setSession: vi.fn(),
  sql: vi.fn(),
  warn: vi.fn()
}));

vi.mock('next/headers', () => ({
  headers: async () => state.headers
}));

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect
}));

vi.mock('@/lib/openwook/auth', () => ({
  clearSession: mocks.clearSession,
  comparePasswords: mocks.comparePasswords,
  getUserPasswordByLogin: mocks.getUserPasswordByLogin,
  hashPassword: mocks.hashPassword,
  setSession: mocks.setSession
}));

vi.mock('@/lib/openwook/db', () => ({
  sql: mocks.sql
}));

vi.mock('@/lib/openwook/logger', () => ({
  errorToLog: (error: unknown) => ({ error }),
  logger: {
    warn: mocks.warn
  }
}));

vi.mock('@/lib/openwook/redis', () => ({
  incrementRateLimit: mocks.incrementRateLimit,
  redisKey: (...parts: Array<string | number>) => parts.join(':')
}));

vi.mock('@/lib/openwook/server-action-origin', () => ({
  assertSameOriginFromHeaders: mocks.assertSameOriginFromHeaders
}));

describe('auth server action hardening', () => {
  beforeEach(() => {
    state.headers = new Headers({
      origin: 'https://openwook.test',
      'x-forwarded-for': '203.0.113.10, 10.0.0.8',
      'x-forwarded-host': 'openwook.test',
      'x-forwarded-proto': 'https'
    });

    mocks.assertSameOriginFromHeaders.mockReset();
    mocks.clearSession.mockReset();
    mocks.comparePasswords.mockReset();
    mocks.getUserPasswordByLogin.mockReset();
    mocks.hashPassword.mockReset();
    mocks.incrementRateLimit.mockReset();
    mocks.redirect.mockReset();
    mocks.setSession.mockReset();
    mocks.sql.mockReset();
    mocks.warn.mockReset();

    mocks.assertSameOriginFromHeaders.mockResolvedValue(undefined);
    mocks.comparePasswords.mockResolvedValue(true);
    mocks.getUserPasswordByLogin.mockResolvedValue({ id: 7, password: '$2y$10$realUserHash' });
    mocks.hashPassword.mockResolvedValue('$2y$10$registeredHash');
    mocks.incrementRateLimit.mockResolvedValue({ allowed: true, count: 1, remaining: 9, resetSeconds: 300 });
    mocks.redirect.mockImplementation(() => undefined);
    mocks.setSession.mockResolvedValue(undefined);
    mocks.sql.mockResolvedValue([{ id: 7 }]);
  });

  it('applies the shared Redis rate limiter to login server actions', async () => {
    const form = new FormData();
    form.set('email', 'Alice@Example.com');
    form.set('password', 'password123');

    await signIn({}, form);

    expect(mocks.incrementRateLimit.mock.calls).toEqual([
      ['rate-limit:auth:login:ip:203.0.113.10', 20, 300],
      ['rate-limit:auth:login:alice@example.com', 10, 300]
    ]);
  });

  it('applies the shared Redis rate limiter to registration server actions', async () => {
    const form = new FormData();
    form.set('username', 'alice');
    form.set('email', 'alice@example.com');
    form.set('password', 'password123');

    await signUp({}, form);

    expect(mocks.incrementRateLimit).toHaveBeenCalledWith('rate-limit:auth:register:ip:203.0.113.10', 10, 3600);
  });

  it('still compares against a dummy hash when the login user is missing', async () => {
    mocks.getUserPasswordByLogin.mockResolvedValue(null);
    mocks.comparePasswords.mockResolvedValue(false);

    const form = new FormData();
    form.set('email', 'missing@example.com');
    form.set('password', 'password123');

    await expect(signIn({}, form)).resolves.toEqual({
      error: '用户名/邮箱或密码错误。',
      email: 'missing@example.com'
    });

    expect(mocks.comparePasswords).toHaveBeenCalledTimes(1);
    expect(mocks.comparePasswords).toHaveBeenCalledWith('password123', expect.any(String));
  });
});
