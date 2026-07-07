import 'server-only';

import { headers } from 'next/headers';
import { ApiError } from './api';
import { incrementRateLimit, redisKey } from './redis';

export function clientIpFromHeaders(requestHeaders: Headers) {
  return requestHeaders.get('x-forwarded-for')?.split(',')[0]?.trim()
    || requestHeaders.get('x-real-ip')
    || 'unknown';
}

export function clientIpFromRequest(request: Request) {
  return clientIpFromHeaders(request.headers);
}

export async function enforceLoginRateLimit(login: string, clientIp: string) {
  await enforceRateLimit(redisKey('rate-limit', 'auth:login:ip', clientIp), 20, 300);
  await enforceRateLimit(redisKey('rate-limit', 'auth:login', login.toLowerCase()), 10, 300);
}

export async function enforceRegisterRateLimit(clientIp: string) {
  await enforceRateLimit(redisKey('rate-limit', 'auth:register:ip', clientIp), 10, 3600);
}

export async function enforceLoginRateLimitFromHeaders(login: string) {
  await enforceLoginRateLimit(login, clientIpFromHeaders(await headers()));
}

export async function enforceRegisterRateLimitFromHeaders() {
  await enforceRegisterRateLimit(clientIpFromHeaders(await headers()));
}

async function enforceRateLimit(key: string, limit: number, windowSeconds: number) {
  const result = await incrementRateLimit(key, limit, windowSeconds);
  if (!result.allowed) {
    throw new ApiError(429, 'RATE_LIMITED', `请求过于频繁，请 ${result.resetSeconds} 秒后再试。`);
  }
}
