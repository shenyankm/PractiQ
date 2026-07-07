import { createHash, randomUUID } from 'node:crypto';
import Redis, { type RedisOptions } from 'ioredis';
import { trace } from '@opentelemetry/api';
import { errorToLog, logger } from './logger';
import { recordDependencyDuration, recordRedisCacheEvent } from './metrics';
import { env } from './env';

const redisUrl = env.REDIS_URL;
const keyPrefix = env.REDIS_KEY_PREFIX || 'openwook';

const redisTracer = trace.getTracer('openwook-redis');

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
    logger.warn({ ...errorToLog(error), dependency: 'redis', role }, 'redis connection error');
  });
  return redis;
}

export function getRedis() {
  if (!redisUrl) return null;
  if (sharedRedis === undefined) {
    sharedRedis = new Redis(redisUrl, cacheRedisOptions('app'));
    sharedRedis.on('error', (error) => {
      logger.warn({ ...errorToLog(error), dependency: 'redis', role: 'app' }, 'redis connection error');
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

async function observeRedisOperation<T>(operation: string, run: () => Promise<T>): Promise<T> {
  const span = redisTracer.startSpan(`redis ${operation}`);
  span.setAttributes({ 'db.system': 'redis', 'db.operation': operation });
  try {
    const value = await run();
    span.setAttribute('openwook.status', 'ok');
    return value;
  } catch (error) {
    span.setAttribute('openwook.status', 'error');
    span.recordException(error as Error);
    throw error;
  } finally {
    span.end();
  }
}

export async function pingRedis() {
  const redis = getRedis();
  if (!redis) {
    return { configured: false, ok: false, latencyMs: null as number | null };
  }
  const started = Date.now();
  try {
    const pong = await observeRedisOperation('ping', () => redis.ping());
    const latencyMs = Date.now() - started;
    recordDependencyDuration({ dependency: 'redis', operation: 'ping', status: pong === 'PONG' ? 'ok' : 'error' }, latencyMs);
    return { configured: true, ok: pong === 'PONG', latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - started;
    recordDependencyDuration({ dependency: 'redis', operation: 'ping', status: 'error' }, latencyMs);
    logger.warn({ ...errorToLog(error), dependency: 'redis', operation: 'ping', latencyMs }, 'redis ping failed');
    return {
      configured: true,
      ok: false,
      latencyMs
    };
  }
}

export async function redisGetJson<T>(key: string): Promise<T | null> {
  const redis = getRedis();
  if (!redis) {
    recordRedisCacheEvent('disabled');
    return null;
  }
  const started = Date.now();
  try {
    const value = await observeRedisOperation('get', () => redis.get(key));
    recordDependencyDuration({ dependency: 'redis', operation: 'get_json', status: 'ok' }, Date.now() - started);
    recordRedisCacheEvent(value ? 'hit' : 'miss');
    return value ? JSON.parse(value) as T : null;
  } catch (error) {
    recordDependencyDuration({ dependency: 'redis', operation: 'get_json', status: 'error' }, Date.now() - started);
    recordRedisCacheEvent('error');
    logger.warn({ ...errorToLog(error), dependency: 'redis', operation: 'get_json' }, 'redis get json failed');
    return null;
  }
}

export async function redisSetJson(key: string, value: unknown, ttlSeconds: number) {
  const redis = getRedis();
  if (!redis) return false;
  const started = Date.now();
  try {
    await observeRedisOperation('set', () => redis.set(key, JSON.stringify(value), 'EX', ttlSeconds));
    recordDependencyDuration({ dependency: 'redis', operation: 'set_json', status: 'ok' }, Date.now() - started);
    return true;
  } catch (error) {
    recordDependencyDuration({ dependency: 'redis', operation: 'set_json', status: 'error' }, Date.now() - started);
    recordRedisCacheEvent('set_error');
    logger.warn({ ...errorToLog(error), dependency: 'redis', operation: 'set_json' }, 'redis set json failed');
    return false;
  }
}

export async function redisGetText(key: string): Promise<string | null> {
  const redis = getRedis();
  if (!redis) {
    recordRedisCacheEvent('disabled');
    return null;
  }
  const started = Date.now();
  try {
    const value = await observeRedisOperation('get', () => redis.get(key));
    recordDependencyDuration({ dependency: 'redis', operation: 'get_text', status: 'ok' }, Date.now() - started);
    recordRedisCacheEvent(value ? 'hit' : 'miss');
    return value;
  } catch (error) {
    recordDependencyDuration({ dependency: 'redis', operation: 'get_text', status: 'error' }, Date.now() - started);
    recordRedisCacheEvent('error');
    logger.warn({ ...errorToLog(error), dependency: 'redis', operation: 'get_text' }, 'redis get text failed');
    return null;
  }
}

export async function redisIncr(key: string) {
  const redis = getRedis();
  if (!redis) return 0;
  const started = Date.now();
  try {
    const value = await observeRedisOperation('incr', () => redis.incr(key));
    recordDependencyDuration({ dependency: 'redis', operation: 'incr', status: 'ok' }, Date.now() - started);
    return value;
  } catch (error) {
    recordDependencyDuration({ dependency: 'redis', operation: 'incr', status: 'error' }, Date.now() - started);
    logger.warn({ ...errorToLog(error), dependency: 'redis', operation: 'incr' }, 'redis incr failed');
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
  const started = Date.now();
  try {
    const deleted = await observeRedisOperation('unlink', () => redis.unlink(...keys));
    recordDependencyDuration({ dependency: 'redis', operation: 'del', status: 'ok' }, Date.now() - started);
    return deleted;
  } catch (error) {
    recordDependencyDuration({ dependency: 'redis', operation: 'del', status: 'error' }, Date.now() - started);
    logger.warn({ ...errorToLog(error), dependency: 'redis', operation: 'del' }, 'redis del failed');
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
      const [nextCursor, keys] = await observeRedisOperation('scan', () => redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100));
      cursor = nextCursor;
      if (keys.length) deleted += await observeRedisOperation('unlink', () => redis.unlink(...keys));
    } while (cursor !== '0');
  } catch (error) {
    logger.warn({ ...errorToLog(error), dependency: 'redis', operation: 'del_pattern' }, 'redis delete by pattern failed');
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
    const result = await observeRedisOperation('set_lock', () => redis.set(key, token, 'PX', ttlMs, 'NX'));
    const release = async () => {
      try {
        const released = await observeRedisOperation('release_lock', () => redis.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          1,
          key,
          token
        ));
        return released === 1;
      } catch {
        return false;
      }
    };
    return { acquired: result === 'OK', key, token, release };
  } catch (error) {
    logger.warn({ ...errorToLog(error), dependency: 'redis', operation: 'acquire_lock' }, 'redis lock failed open');
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
    const count = await observeRedisOperation('rate_limit_incr', () => redis.incr(key));
    if (count === 1) await observeRedisOperation('expire', () => redis.expire(key, windowSeconds));
    const ttl = await observeRedisOperation('ttl', () => redis.ttl(key));
    return {
      allowed: count <= limit,
      count,
      remaining: Math.max(limit - count, 0),
      resetSeconds: ttl > 0 ? ttl : windowSeconds
    };
  } catch (error) {
    logger.warn({ ...errorToLog(error), dependency: 'redis', operation: 'rate_limit' }, 'redis rate limit failed open');
    return { allowed: true, count: 0, remaining: limit, resetSeconds: windowSeconds };
  }
}

export async function publishJson(channel: string, payload: unknown) {
  const redis = getRedis();
  if (!redis) return false;
  const started = Date.now();
  try {
    await observeRedisOperation('publish', () => redis.publish(channel, JSON.stringify(payload)));
    recordDependencyDuration({ dependency: 'redis', operation: 'publish', status: 'ok' }, Date.now() - started);
    return true;
  } catch (error) {
    recordDependencyDuration({ dependency: 'redis', operation: 'publish', status: 'error' }, Date.now() - started);
    logger.warn({ ...errorToLog(error), dependency: 'redis', operation: 'publish' }, 'redis publish failed');
    return false;
  }
}

export async function appendStreamJson(streamKey: string, payload: unknown, maxLen = 500) {
  const redis = getRedis();
  if (!redis) return false;
  const started = Date.now();
  try {
    await observeRedisOperation('xadd', () => redis.xadd(streamKey, 'MAXLEN', '~', maxLen, '*', 'payload', JSON.stringify(payload)));
    recordDependencyDuration({ dependency: 'redis', operation: 'xadd', status: 'ok' }, Date.now() - started);
    return true;
  } catch (error) {
    recordDependencyDuration({ dependency: 'redis', operation: 'xadd', status: 'error' }, Date.now() - started);
    logger.warn({ ...errorToLog(error), dependency: 'redis', operation: 'xadd' }, 'redis stream append failed');
    return false;
  }
}
