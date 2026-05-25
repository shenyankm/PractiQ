import 'server-only';

import { headers } from 'next/headers';
import { assertSameOriginRequest } from './request-origin';

export async function assertSameOriginFromHeaders() {
  const requestHeaders = await headers();
  const host = requestHeaders.get('x-forwarded-host') ?? requestHeaders.get('host') ?? 'localhost';
  const proto = requestHeaders.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');

  assertSameOriginRequest(new Request(`${proto}://${host}/__server_action`, {
    method: 'POST',
    headers: requestHeaders
  }));
}
