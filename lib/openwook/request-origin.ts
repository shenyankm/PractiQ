import 'server-only';

import { ApiError } from './api';
import { env } from './env';

const protectedMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function assertSameOriginRequest(request: Request) {
  if (isSameOriginRequest(request)) return;

  throw new ApiError(403, 'INVALID_ORIGIN', 'Cross-site requests are not allowed');
}

export function isSameOriginRequest(request: Request) {
  if (!protectedMethods.has(request.method.toUpperCase())) return true;

  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');

  if (!origin && !referer) return true;

  const requestOrigin = normalizedOrigin(env.NEXT_PUBLIC_APP_URL)
    ?? normalizedOrigin(env.BASE_URL)
    ?? new URL(request.url).origin;

  if (origin) return sameOrigin(origin, requestOrigin);
  return referer ? sameOrigin(referer, requestOrigin) : true;
}

function normalizedOrigin(value: string | undefined) {
  if (!value) return undefined;

  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function sameOrigin(value: string, expectedOrigin: string) {
  try {
    return new URL(value).origin === new URL(expectedOrigin).origin;
  } catch {
    return false;
  }
}
