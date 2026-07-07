import { afterEach, describe, expect, it, vi } from 'vitest';

describe('session secret hardening', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('requires AUTH_SECRET in production', async () => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_SECRET', '');

    await expect(import('@/lib/openwook/session')).rejects.toThrow('AUTH_SECRET');
  });
});
