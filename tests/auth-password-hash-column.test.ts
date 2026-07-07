import type { User } from '@/lib/openwook/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

function normalizeSql(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

function renderSql(strings: TemplateStringsArray, values: unknown[]) {
  return strings.reduce(
    (query, chunk, index) => query + chunk + (index < values.length ? `__value_${index}__` : ''),
    ''
  );
}

function createSqlRecorder(rows: unknown[] = []) {
  const queries: string[] = [];
  const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push(normalizeSql(renderSql(strings, values)));
    return Promise.resolve(rows);
  });

  return { queries, sql };
}

function expectPasswordHashQuery(query: string, operation: string) {
  expect(query, `${operation} must target users.password_hash`).toContain('password_hash');
  expect(query, `${operation} must not target the removed users.password column`).not.toMatch(/\bpassword\b(?!_hash)/);
}

const importAuthModule = () => {
  // Static import cannot work here because this regression test reloads each touchpoint under a different mocked sql boundary.
  return import('@/lib/openwook/auth');
};

const importLoginActionsModule = () => {
  // Static import cannot work here because this regression test reloads each touchpoint under a different mocked sql boundary.
  return import('@/app/(login)/actions');
};

const importRegisterRouteModule = () => {
  // Static import cannot work here because this regression test reloads each touchpoint under a different mocked sql boundary.
  return import('@/app/api/v1/auth/register/route');
};

const importServicesModule = () => {
  // Static import cannot work here because this regression test reloads each touchpoint under a different mocked sql boundary.
  return import('@/lib/openwook/services');
};

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('password hash SQL contract', () => {
  it('uses users.password_hash across auth lookups, sign-up inserts, register inserts, and password updates', async () => {
    const authDb = createSqlRecorder();
    vi.doMock('@/lib/openwook/db', () => ({ sql: authDb.sql }));
    vi.doMock('next/headers', () => ({ cookies: vi.fn() }));
    vi.doMock('@/lib/openwook/session', () => ({
      signSessionToken: vi.fn(),
      verifySessionToken: vi.fn()
    }));
    vi.doMock('@/lib/openwook/redis', () => ({
      redisDel: vi.fn(),
      redisGetJson: vi.fn(),
      redisGetOrSetJson: vi.fn(),
      redisKey: (...parts: Array<string | number>) => parts.join(':'),
      redisSetJson: vi.fn()
    }));
    vi.doMock('@/lib/openwook/env', () => ({
      env: {
        NODE_ENV: 'test',
        USER_CACHE_TTL_SECONDS: '60'
      }
    }));

    const { getUserPasswordById, getUserPasswordByLogin } = await importAuthModule();
    await getUserPasswordByLogin('alice@example.com');
    await getUserPasswordById(7);

    expect(authDb.queries).toHaveLength(2);
    expectPasswordHashQuery(authDb.queries[0], 'getUserPasswordByLogin');
    expectPasswordHashQuery(authDb.queries[1], 'getUserPasswordById');

    vi.resetModules();

    const signUpDb = createSqlRecorder([{ id: 42 }]);
    const signUpAuth = {
      clearSession: vi.fn(),
      comparePasswords: vi.fn(),
      getUserPasswordByLogin: vi.fn(),
      hashPassword: vi.fn().mockResolvedValue('$2y$10$signupHash'),
      setSession: vi.fn()
    };

    vi.doMock('@/lib/openwook/auth', () => signUpAuth);
    vi.doMock('@/lib/openwook/db', () => ({ sql: signUpDb.sql }));
    vi.doMock('next/navigation', () => ({ redirect: vi.fn() }));
    vi.doMock('@/lib/openwook/auth-rate-limit', () => ({
      enforceLoginRateLimitFromHeaders: vi.fn(),
      enforceRegisterRateLimitFromHeaders: vi.fn()
    }));
    vi.doMock('@/lib/openwook/logger', () => ({
      errorToLog: vi.fn(() => ({})),
      logger: { warn: vi.fn() }
    }));
    vi.doMock('@/lib/openwook/server-action-origin', () => ({
      assertSameOriginFromHeaders: vi.fn()
    }));

    const { signUp } = await importLoginActionsModule();
    const signUpForm = new FormData();
    signUpForm.set('username', 'alice');
    signUpForm.set('email', 'alice@example.com');
    signUpForm.set('password', 'password123');
    await signUp({}, signUpForm);

    expect(signUpDb.queries).toHaveLength(1);
    expectPasswordHashQuery(signUpDb.queries[0], 'signUp');

    vi.resetModules();

    const registerDb = createSqlRecorder([
      {
        id: 43,
        username: 'alice',
        email: 'alice@example.com',
        avatar_url: null,
        is_active: true,
        role: 'user',
        membership: 'free',
        plus_trial_ends_at: null,
        plus_expires_at: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z'
      }
    ]);
    const registerAuth = {
      hashPassword: vi.fn().mockResolvedValue('$2y$10$registerHash'),
      setSession: vi.fn()
    };

    vi.doMock('@/lib/openwook/auth', () => registerAuth);
    vi.doMock('@/lib/openwook/db', () => ({ sql: registerDb.sql }));
    vi.doMock('@/lib/openwook/api', () => ({
      created: vi.fn((body: unknown) => body),
      handleApiError: vi.fn((error: unknown) => error),
      readJson: vi.fn((request: Request) => request.json())
    }));
    vi.doMock('@/lib/openwook/auth-rate-limit', () => ({
      clientIpFromRequest: vi.fn(() => '127.0.0.1'),
      enforceRegisterRateLimit: vi.fn()
    }));
    vi.doMock('@/lib/openwook/observability', () => ({
      withApiObservability: vi.fn((_request: Request, _name: string, handler: () => Promise<unknown>) => handler())
    }));
    vi.doMock('@/lib/openwook/request-origin', () => ({
      assertSameOriginRequest: vi.fn()
    }));

    const { POST } = await importRegisterRouteModule();
    await POST(new Request('https://example.com/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'alice', email: 'alice@example.com', password: 'password123' }),
      headers: { 'content-type': 'application/json', origin: 'https://example.com' }
    }));

    expect(registerDb.queries).toHaveLength(1);
    expectPasswordHashQuery(registerDb.queries[0], 'auth register route');

    vi.resetModules();

    const updateDb = createSqlRecorder([
      {
        id: 9,
        username: 'alice',
        email: 'alice@example.com',
        avatar_url: null,
        is_active: true,
        role: 'user',
        membership: 'free',
        plus_trial_ends_at: null,
        plus_expires_at: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z'
      }
    ]);
    vi.doMock('@/lib/openwook/db', () => ({ sql: updateDb.sql }));
    vi.doMock('@/lib/openwook/auth', () => ({
      invalidateUserCache: vi.fn()
    }));
    vi.doMock('@/lib/openwook/logger', () => ({
      errorToLog: vi.fn(() => ({})),
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
    }));
    vi.doMock('@/lib/openwook/import-events', () => ({
      publishImportEvent: vi.fn()
    }));
    vi.doMock('@/lib/openwook/permissions', () => ({
      requireAdminRole: vi.fn(),
      requireImportSourceType: vi.fn(),
      requirePlusEntitlement: vi.fn()
    }));
    vi.doMock('@/lib/openwook/redis', () => ({
      acquireRedisLock: vi.fn(),
      hashKey: vi.fn(),
      redisDel: vi.fn(),
      redisGetText: vi.fn(),
      redisGetJson: vi.fn(),
      redisGetOrSetJson: vi.fn(),
      redisIncr: vi.fn(),
      redisKey: (...parts: Array<string | number>) => parts.join(':'),
      redisSetJson: vi.fn()
    }));
    vi.doMock('@/lib/openwook/env', () => ({
      env: {
        OPENWOOK_SHORT_CACHE_TTL_SECONDS: '60',
        OPENWOOK_REFERENCE_CACHE_TTL_SECONDS: '3600',
        PRACTICE_QUEUE_TTL_SECONDS: '604800',
        PRACTICE_MAX_QUESTIONS: '500',
        PRACTICE_PROGRESS_FULL_LIMIT: '120',
        PRACTICE_PROGRESS_WINDOW_RADIUS: '30'
      }
    }));

    const { updateCurrentUser } = await importServicesModule();
    const user: User = {
      id: 9,
      username: 'alice',
      email: 'alice@example.com',
      avatar_url: null,
      is_active: true,
      role: 'user',
      membership: 'free',
      plus_trial_ends_at: null,
      plus_expires_at: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z'
    };

    await updateCurrentUser(user, { passwordHash: '$2y$10$updatedHash' });

    expect(updateDb.queries).toHaveLength(1);
    expectPasswordHashQuery(updateDb.queries[0], 'updateCurrentUser');
  });
});
