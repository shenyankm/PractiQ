import { sql } from '@/lib/openwook/db';
import { pingRedis } from '@/lib/openwook/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
  const started = Date.now();
  let postgres: { ok: boolean; latencyMs: number | null; error?: string } = {
    ok: false,
    latencyMs: null
  };

  const pgStarted = Date.now();
  try {
    await sql`SELECT 1`;
    postgres = { ok: true, latencyMs: Date.now() - pgStarted };
  } catch (error) {
    postgres = {
      ok: false,
      latencyMs: Date.now() - pgStarted,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  const redis = await pingRedis();
  const ok = postgres.ok && (!redis.configured || redis.ok);

  return Response.json(
    {
      ok,
      services: {
        postgres,
        redis
      },
      latencyMs: Date.now() - started
    },
    { status: ok ? 200 : 503 }
  );
}
