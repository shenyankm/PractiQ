import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getBankAnalytics } from '@/lib/openwook/services/analytics';

const mocks = vi.hoisted(() => ({
  cacheVersion: vi.fn(),
  getBank: vi.fn(),
  redisGetOrSetJson: vi.fn(),
  sql: vi.fn()
}));

vi.mock('@/lib/openwook/db', () => ({
  sql: mocks.sql
}));

vi.mock('@/lib/openwook/env', () => ({
  env: {
    ANALYTICS_CACHE_TTL_SECONDS: '45'
  }
}));

vi.mock('@/lib/openwook/redis', () => ({
  hashKey: (value: unknown) => JSON.stringify(value),
  redisGetOrSetJson: mocks.redisGetOrSetJson,
  redisKey: (...parts: Array<string | number>) => parts.join(':')
}));

vi.mock('@/lib/openwook/services/internal', () => ({
  cacheVersion: mocks.cacheVersion
}));

vi.mock('@/lib/openwook/services/banks', () => ({
  getBank: mocks.getBank
}));

vi.mock('@/lib/openwook/services/imports', () => ({
  getImportJob: vi.fn()
}));

describe('analytics hot paths', () => {
  beforeEach(() => {
    mocks.cacheVersion.mockReset();
    mocks.getBank.mockReset();
    mocks.redisGetOrSetJson.mockReset();
    mocks.sql.mockReset();

    mocks.cacheVersion.mockResolvedValue('7');
    mocks.getBank.mockResolvedValue({ id: 42 });
    mocks.redisGetOrSetJson.mockImplementation(async (_key, _ttl, loader) => loader());
    mocks.sql.mockResolvedValue([
      { completed_count: 12, wrong_count: 3, practiced_users: 4, answer_count: 18 }
    ]);
  });

  it('caches bank analytics behind a versioned redis key', async () => {
    const user = { id: 9 };

    await expect(getBankAnalytics(user as never, 42)).resolves.toEqual({
      completed_count: 12,
      wrong_count: 3,
      practiced_users: 4,
      answer_count: 18
    });

    expect(mocks.getBank).toHaveBeenCalledWith(user, 42);
    expect(mocks.cacheVersion).toHaveBeenCalledWith('bank-analytics', 42);
    expect(mocks.redisGetOrSetJson).toHaveBeenCalledTimes(1);
    expect(mocks.redisGetOrSetJson).toHaveBeenCalledWith(
      'cache:bank-analytics:bank:42:7',
      45,
      expect.any(Function)
    );
    expect(mocks.sql).toHaveBeenCalledTimes(1);
  });

  it('bumps the bank analytics cache version when an answer is recorded', () => {
    const internalSource = readFileSync('lib/openwook/services/internal.ts', 'utf8');
    const practiceSource = readFileSync('lib/openwook/services/practice.ts', 'utf8');

    expect(internalSource).toContain('export async function invalidateBankAnalytics');
    expect(internalSource).toContain("redisIncr(redisKey('cache-version', 'bank-analytics', bankId))");
    expect(practiceSource).toContain('invalidateBankAnalytics');
    expect(practiceSource).toContain('await invalidateBankAnalytics(session.bank_id)');
  });
});
