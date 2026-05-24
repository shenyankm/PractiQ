import { createHash, randomUUID } from 'node:crypto';
import Redis, { type RedisOptions } from 'ioredis';

const redisUrl = process.env.REDIS_URL;
const keyPrefix = process.env.REDIS_KEY_PREFIX || 'openwook';

let sharedRedis: Redis | null | undefined;
const jsonLoadInflight = new Map<string, Promise<unknown>>();

function cacheRedisOptions(role: string): RedisOptions {
  return {
    connectionName: `openwook:${role}`,
    connectTimeout: 800,
    enableOfflineQueue: true,
    maxRetriesPerRequest: 1,
    retryStrategy(times) {
      return times > 2 ? null : Math.min(times * 100, 500);
    }
  };
}

function queueRedisOptions(role: string): RedisOptions {
  return {
    connectionName: `openwook:${role}`,
    connectTimeout: 2000,
    maxRetriesPerRequest: null,
    retryStrategy(times) {
      return Math.min(times * 200, 5000);
    }
  };
}

export function isRedisConfigured() {
  return Boolean(redisUrl);
}

export function createRedisConnection(role: string, options?: RedisOptions) {
  if (!redisUrl) return null;
  const redis = new Redis(redisUrl, {
    ...queueRedisOptions(role),
    ...options
  });
  redis.on('error', (error) => {
    console.error(`[redis:${role}]`, error.message);
  });
  return redis;
}

export function getRedis() {
  if (!redisUrl) return null;
  if (sharedRedis === undefined) {
    sharedRedis = new Redis(redisUrl, cacheRedisOptions('app'));
    sharedRedis.on('error', (error) => {
      console.error('[redis:app]', error.message);
    });
  }
  return sharedRedis;
}

export function redisKey(...parts: Array<string | number | boolean | null | undefined>) {
  return [keyPrefix, ...parts.filter((part) => part !== null && part !== undefined).map(String)].join(':');
}

export function hashKey(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

export async function pingRedis() {
  const redis = getRedis();
  if (!redis) {
    return { configured: false, ok: false, latencyMs: null as number | null };
  }
  const started = Date.now();
  try {
    const pong = await redis.ping();
    return { configured: true, ok: pong === 'PONG', latencyMs: Date.now() - started };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function redisGetJson<T>(key: string): Promise<T | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const value = await redis.get(key);
    return value ? JSON.parse(value) as T : null;
  } catch {
    return null;
  }
}

export async function redisSetJson(key: string, value: unknown, ttlSeconds: number) {
  const redis = getRedis();
  if (!redis) return false;
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    return true;
  } catch {
    return false;
  }
}

export async function redisGetText(key: string): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    return await redis.get(key);
  } catch {
    return null;
  }
}

export async function redisIncr(key: string) {
  const redis = getRedis();
  if (!redis) return 0;
  try {
    return await redis.incr(key);
  } catch {
    return 0;
  }
}

export async function redisGetOrSetJson<T>(
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>
): Promise<T> {
  const cached = await redisGetJson<T>(key);
  if (cached !== null) return cached;

  const inflight = jsonLoadInflight.get(key) as Promise<T> | undefined;
  if (inflight) return inflight;

  const request = (async () => {
    const rechecked = await redisGetJson<T>(key);
    if (rechecked !== null) return rechecked;

    const value = await load();
    await redisSetJson(key, value, ttlSeconds);
    return value;
  })();

  jsonLoadInflight.set(key, request);
  try {
    return await request;
  } finally {
    if (jsonLoadInflight.get(key) === request) {
      jsonLoadInflight.delete(key);
    }
  }
}

export async function redisDel(...keys: string[]) {
  const redis = getRedis();
  if (!redis || keys.length === 0) return 0;
  try {
    return await redis.unlink(...keys);
  } catch {
    return 0;
  }
}

export async function redisDelByPattern(pattern: string) {
  const redis = getRedis();
  if (!redis) return 0;
  let cursor = '0';
  let deleted = 0;
  try {
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length) deleted += await redis.unlink(...keys);
    } while (cursor !== '0');
  } catch {
    return deleted;
  }
  return deleted;
}

export type RedisLock = {
  acquired: boolean;
  key: string;
  token: string;
  release: () => Promise<boolean>;
};

export async function acquireRedisLock(key: string, ttlMs: number): Promise<RedisLock> {
  const redis = getRedis();
  const token = randomUUID();
  if (!redis) {
    return {
      acquired: true,
      key,
      token,
      release: async () => true
    };
  }

  try {
    const result = await redis.set(key, token, 'PX', ttlMs, 'NX');
    const release = async () => {
      try {
        const released = await redis.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          1,
          key,
          token
        );
        return released === 1;
      } catch {
        return false;
      }
    };
    return { acquired: result === 'OK', key, token, release };
  } catch {
    return {
      acquired: true,
      key,
      token,
      release: async () => true
    };
  }
}

export async function withRedisLock<T>(key: string, ttlMs: number, run: () => Promise<T>) {
  const lock = await acquireRedisLock(key, ttlMs);
  if (!lock.acquired) return { acquired: false as const };
  try {
    const value = await run();
    return { acquired: true as const, value };
  } finally {
    await lock.release();
  }
}

export async function incrementRateLimit(key: string, limit: number, windowSeconds: number) {
  const redis = getRedis();
  if (!redis) {
    return { allowed: true, count: 0, remaining: limit, resetSeconds: windowSeconds };
  }

  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSeconds);
    const ttl = await redis.ttl(key);
    return {
      allowed: count <= limit,
      count,
      remaining: Math.max(limit - count, 0),
      resetSeconds: ttl > 0 ? ttl : windowSeconds
    };
  } catch {
    return { allowed: true, count: 0, remaining: limit, resetSeconds: windowSeconds };
  }
}

export async function publishJson(channel: string, payload: unknown) {
  const redis = getRedis();
  if (!redis) return false;
  try {
    await redis.publish(channel, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export async function appendStreamJson(streamKey: string, payload: unknown, maxLen = 500) {
  const redis = getRedis();
  if (!redis) return false;
  try {
    await redis.xadd(streamKey, 'MAXLEN', '~', maxLen, '*', 'payload', JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}
