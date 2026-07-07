import { sql } from '@/lib/openwook/db';
import { errorToLog, logger } from '@/lib/openwook/logger';
import { withApiObservability } from '@/lib/openwook/observability';
import { pingRedis } from '@/lib/openwook/redis';
import { env } from '@/lib/openwook/env';

export const dynamic = 'force-dynamic';

type HealthService = {
  ok: boolean;
  latencyMs: number | null;
  configured?: boolean;
};

const healthTimeoutMs = Number(env.HEALTH_CHECK_TIMEOUT_MS || 1500);

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Health check timed out')), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function readinessResponse() {
  const started = Date.now();
  let postgres: HealthService = {
    ok: false,
    latencyMs: null
  };

  const pgStarted = Date.now();
  try {
    await withTimeout(sql`SELECT 1`, healthTimeoutMs);
    postgres = { ok: true, latencyMs: Date.now() - pgStarted };
  } catch (error) {
    logger.warn({ ...errorToLog(error), dependency: 'postgres', latencyMs: Date.now() - pgStarted }, 'health check failed for postgres');
    postgres = {
      ok: false,
      latencyMs: Date.now() - pgStarted
    };
  }

  const redis = await withTimeout(pingRedis(), healthTimeoutMs).catch((error) => {
    logger.warn({ ...errorToLog(error), dependency: 'redis' }, 'health check failed for redis');
    return { configured: true, ok: false, latencyMs: null as number | null };
  });
  const ok = postgres.ok && (!redis.configured || redis.ok);

  return Response.json(
    {
      ok,
      services: {
        postgres,
        redis: {
          configured: redis.configured,
          ok: redis.ok,
          latencyMs: redis.latencyMs
        }
      },
      uptimeSeconds: Math.round(process.uptime()),
      latencyMs: Date.now() - started
    },
    {
      status: ok ? 200 : 503,
      headers: {
        'Cache-Control': 'no-store'
      }
    }
  );
}

export async function GET(request: Request) {
  return withApiObservability(request, '/api/health', readinessResponse);
}
