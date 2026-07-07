import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const sharedClient = { kind: 'shared-postgres-client' };

  return {
    db: { kind: 'drizzle-db' },
    dotenvConfig: vi.fn(),
    drizzle: vi.fn(() => ({ kind: 'drizzle-db' })),
    postgres: vi.fn(() => ({ kind: 'local-postgres-client' })),
    sharedClient
  };
});

vi.mock('dotenv', () => ({
  default: {
    config: mocks.dotenvConfig
  }
}));

vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: mocks.drizzle
}));

vi.mock('postgres', () => ({
  default: mocks.postgres
}));

vi.mock('@/lib/openwook/db', () => ({
  postgresClient: mocks.sharedClient
}));

describe('drizzle postgres client wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.dotenvConfig.mockReset();
    mocks.drizzle.mockReset();
    mocks.postgres.mockReset();
    mocks.drizzle.mockReturnValue(mocks.db);
    mocks.postgres.mockReturnValue({ kind: 'local-postgres-client' });
  });

  it('reuses the shared OpenWook postgres client for the exported drizzle bindings', async () => {
    // Static import cannot work here because this regression test verifies lib/db/drizzle module initialization under mocked boundaries.
    const drizzleModule = await import('@/lib/db/drizzle');

    expect(mocks.dotenvConfig).not.toHaveBeenCalled();
    expect(mocks.postgres).not.toHaveBeenCalled();
    expect(drizzleModule.client).toBe(mocks.sharedClient);
    expect(mocks.drizzle).toHaveBeenCalledWith(
      mocks.sharedClient,
      expect.objectContaining({ schema: expect.any(Object) })
    );
    expect(drizzleModule.db).toBe(mocks.db);
  });
});
