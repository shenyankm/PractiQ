import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

const loadSessionModule = () => {
  // Static import cannot work here because this file verifies env-sensitive module initialization.
  return import('@/lib/openwook/session');
};

async function signArbitrarySessionToken(payload: Record<string, unknown>) {
  const secret = new TextEncoder().encode(process.env.AUTH_SECRET || 'test-auth-secret-for-vitest-only');

  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1 hour')
    .sign(secret);
}

describe('session secret hardening', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('requires AUTH_SECRET in production', async () => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_SECRET', '');

    await expect(loadSessionModule()).rejects.toThrow('AUTH_SECRET');
  });
});

describe('session payload validation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each([
    ['missing numeric user id', { user: {}, expires: new Date(Date.now() + 60_000).toISOString() }],
    ['string user id', { user: { id: '7' }, expires: new Date(Date.now() + 60_000).toISOString() }],
    ['missing expires string', { user: { id: 7 } }]
  ])('rejects %s', async (_case, payload) => {
    const token = await signArbitrarySessionToken(payload);
    const { verifySessionToken } = await loadSessionModule();

    await expect(verifySessionToken(token)).rejects.toThrow();
  });
});
