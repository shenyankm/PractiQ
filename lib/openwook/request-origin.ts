import 'server-only';

import { ApiError } from './api';

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

  const requestOrigin = forwardedOrigin(request);
  if (origin) return sameOrigin(origin, requestOrigin);
  return referer ? sameOrigin(referer, requestOrigin) : true;
}

function forwardedOrigin(request: Request) {
  const url = new URL(request.url);
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? url.host;
  const proto = request.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');

  return `${proto}://${host}`;
}

function sameOrigin(value: string, expectedOrigin: string) {
  try {
    return new URL(value).origin === new URL(expectedOrigin).origin;
  } catch {
    return false;
  }
}
