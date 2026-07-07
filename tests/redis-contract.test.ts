import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { getRedis, incrementRateLimit, pingRedis, redisDel, redisGetOrSetJson, redisKey } from '@/lib/openwook/redis';

const redisLaneEnabled = process.env.OPENWOOK_REDIS_TESTS === '1';

if (redisLaneEnabled && !process.env.REDIS_URL) {
  throw new Error('OPENWOOK_REDIS_TESTS=1 requires REDIS_URL; tests/setup.ts must preserve it for Redis-backed tests.');
}

const describeRedis = redisLaneEnabled ? describe : describe.skip;

describeRedis('redis-backed contracts', () => {
  const rateLimitKey = redisKey('test', 'redis-contract', 'rate-limit', randomUUID());
  const cacheKey = redisKey('test', 'redis-contract', 'cache', randomUUID());

  afterAll(async () => {
    await redisDel(rateLimitKey, cacheKey);
    await getRedis()?.quit();
  });

  it('pings redis and enforces rate limits against the real backend', async () => {
    const ping = await pingRedis();

    expect(ping.configured).toBe(true);
    expect(ping.ok).toBe(true);
    expect(ping.latencyMs).toEqual(expect.any(Number));

    const first = await incrementRateLimit(rateLimitKey, 2, 30);
    const second = await incrementRateLimit(rateLimitKey, 2, 30);
    const third = await incrementRateLimit(rateLimitKey, 2, 30);

    expect(first).toMatchObject({ allowed: true, count: 1, remaining: 1 });
    expect(second).toMatchObject({ allowed: true, count: 2, remaining: 0 });
    expect(third).toMatchObject({ allowed: false, count: 3, remaining: 0 });
    expect(first.resetSeconds).toBeGreaterThan(0);
  });

  it('stores and reuses cached JSON values from redis', async () => {
    let loads = 0;

    const first = await redisGetOrSetJson(cacheKey, 30, async () => {
      loads += 1;
      return { value: 'cached' };
    });
    const second = await redisGetOrSetJson(cacheKey, 30, async () => {
      loads += 1;
      return { value: 'new' };
    });

    expect(first).toEqual({ value: 'cached' });
    expect(second).toEqual({ value: 'cached' });
    expect(loads).toBe(1);
  });
});
