import { z } from 'zod';
import { hashPassword, setSession } from '@/lib/openwook/auth';
import { ApiError, created, handleApiError, readJson } from '@/lib/openwook/api';
import { sql } from '@/lib/openwook/db';
import { incrementRateLimit, redisKey } from '@/lib/openwook/redis';
import { assertSameOriginRequest } from '@/lib/openwook/request-origin';

export const dynamic = 'force-dynamic';

const registerSchema = z.object({
  username: z.string().trim().min(2).max(32),
  email: z.string().email().optional().nullable(),
  password: z.string().min(8).max(100)
});

export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    await enforceRateLimit(`auth:register:ip:${clientIp(request)}`, 10, 3600);
    const body = registerSchema.parse(await readJson(request));
    const passwordHash = await hashPassword(body.password);
    const rows = await sql`
      INSERT INTO users (username, email, password, role, membership, plus_trial_ends_at)
      VALUES (${body.username}, ${body.email ?? null}, ${passwordHash}, 'user', 'free', NOW() + INTERVAL '3 days')
      RETURNING id, username, email, avatar_url, is_active, role, membership, plus_trial_ends_at, plus_expires_at, created_at, updated_at
    `;
    await setSession(rows[0].id);
    return created(rows[0]);
  } catch (error) {
    return handleApiError(error);
  }
}

function clientIp(request: Request) {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown';
}

async function enforceRateLimit(key: string, limit: number, windowSeconds: number) {
  const result = await incrementRateLimit(redisKey('rate-limit', key), limit, windowSeconds);
  if (!result.allowed) {
    throw new ApiError(429, 'RATE_LIMITED', `Too many requests. Try again in ${result.resetSeconds}s`);
  }
}
