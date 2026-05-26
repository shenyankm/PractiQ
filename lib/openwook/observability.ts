import 'server-only';

import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { trace } from '@opentelemetry/api';
import { NextResponse } from 'next/server';
import { childLogger } from './logger';
import { recordHttpRequest } from './metrics';

const requestIdHeader = 'x-request-id';
const tracer = trace.getTracer('openwook-route-handlers');
const requestContext = new AsyncLocalStorage<ObservabilityContext>();

export type ObservabilityContext = {
  requestId: string;
  route: string;
  method: string;
  startedAt: number;
};

export function getOrCreateRequestId(request?: Request) {
  const incoming = request?.headers.get(requestIdHeader)?.trim();
  if (incoming && incoming.length <= 128) return incoming;
  return randomUUID();
}

export function getCurrentRequestId() {
  return requestContext.getStore()?.requestId;
}

export function appendRequestMetadata(response: Response, requestId: string) {
  response.headers.set(requestIdHeader, requestId);
  response.headers.set('Cache-Control', response.headers.get('Cache-Control') ?? 'no-store');
  return response;
}

export async function withApiObservability(
  request: Request,
  route: string,
  handler: (ctx: ObservabilityContext) => Promise<Response> | Response
) {
  const requestId = getOrCreateRequestId(request);
  const method = request.method || 'GET';
  const startedAt = Date.now();
  const log = childLogger({ requestId, route, method });

  return requestContext.run({ requestId, route, method, startedAt }, () =>
    tracer.startActiveSpan(`HTTP ${method} ${route}`, async (span) => {
      try {
        span.setAttributes({
          'http.request.method': method,
          'http.route': route,
          'openwook.request_id': requestId
        });
        const response = await handler({ requestId, route, method, startedAt });
        const durationMs = Date.now() - startedAt;
        const status = String(response.status || 200);
        span.setAttribute('http.response.status_code', response.status || 200);
        recordHttpRequest({ method, route, status }, durationMs);
        log.info({ status: response.status, durationMs }, 'api request completed');
        span.end();
        return appendRequestMetadata(response, requestId);
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        recordHttpRequest({ method, route, status: '500' }, durationMs);
        span.recordException(error as Error);
        span.setAttribute('http.response.status_code', 500);
        span.end();
        throw error;
      }
    })
  );
}

export function jsonWithRequestId(data: unknown, init: ResponseInit | undefined, requestId: string) {
  const response = NextResponse.json(data, init);
  return appendRequestMetadata(response, requestId);
}

