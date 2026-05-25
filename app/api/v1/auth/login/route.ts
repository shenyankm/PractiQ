import { z } from 'zod';
import { comparePasswords, getCurrentUser, getUserPasswordByLogin, setSession } from '@/lib/openwook/auth';
import { ApiError, handleApiError, ok, readJson } from '@/lib/openwook/api';
import { incrementRateLimit, redisKey } from '@/lib/openwook/redis';
import { assertSameOriginRequest } from '@/lib/openwook/request-origin';

export const dynamic = 'force-dynamic';

const loginSchema = z.object({
  login: z.string().min(1),
  password: z.string().min(1)
});

export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    const body = loginSchema.parse(await readJson(request));
    await enforceRateLimit(`auth:login:ip:${clientIp(request)}`, 20, 300);
    await enforceRateLimit(`auth:login:${body.login.toLowerCase()}`, 10, 300);
    const found = await getUserPasswordByLogin(body.login);
    if (!found?.password || !(await comparePasswords(body.password, found.password))) {
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid login or password');
    }
    await setSession(found.id);
    return ok(await getCurrentUser());
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
