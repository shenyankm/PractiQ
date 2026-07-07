import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string) {
  return readFileSync(path, 'utf8');
}

describe('observability baseline', () => {
  it('registers structured logging with sensitive-field redaction', () => {
    const loggerSource = source('lib/openwook/logger.ts');

    expect(loggerSource).toContain('pino');
    expect(loggerSource).toContain('env.LOG_LEVEL');
    for (const sensitiveField of ['password', 'passwordHash', 'headers.authorization', 'headers.cookie', 'fileBase64', 'apiKey', 'privateKey']) {
      expect(loggerSource).toContain(sensitiveField);
    }
  });

  it('adds request correlation and metrics around API route handlers', () => {
    const apiSource = source('lib/openwook/api.ts');
    const routeSource = source('app/api/v1/[[...path]]/route.ts');
    const observabilitySource = source('lib/openwook/observability.ts');

    expect(apiSource).toContain('getCurrentRequestId');
    expect(apiSource).toContain('requestId');
    expect(routeSource).toContain('withApiObservability');
    expect(source('app/api/health/route.ts')).toContain('withApiObservability');
    expect(source('app/api/metrics/route.ts')).toContain('withApiObservability');
    expect(observabilitySource).toContain('x-request-id');
    expect(observabilitySource).toContain('recordHttpRequest');
  });

  it('hardens health checks and exposes a protected Prometheus endpoint', () => {
    const healthSource = source('app/api/health/route.ts');
    const metricsSource = source('app/api/metrics/route.ts');

    expect(healthSource).toContain('HEALTH_CHECK_TIMEOUT_MS');
    expect(healthSource).toContain('Cache-Control');
    expect(healthSource).not.toContain('error.message');
    expect(metricsSource).toContain('METRICS_TOKEN');
    expect(metricsSource).toContain('registry.metrics');
    expect(metricsSource).toContain('Authorization');
  });

  it('collects app, dependency, cache, and import-worker metrics', () => {
    const metricsSource = source('lib/openwook/metrics.ts');
    const dbSource = source('lib/openwook/db.ts');
    const redisSource = source('lib/openwook/redis.ts');
    const workerSource = source('lib/openwook/import-worker.ts');

    for (const metric of [
      'openwook_http_requests_total',
      'openwook_http_request_duration_seconds',
      'openwook_dependency_duration_seconds',
      'openwook_redis_cache_events_total',
      'openwook_import_jobs_total',
      'openwook_import_queue_jobs'
    ]) {
      expect(metricsSource).toContain(metric);
    }
    expect(dbSource).toContain('SLOW_QUERY_MS');
    expect(dbSource).toContain('trace.getTracer');
    expect(redisSource).toContain('recordRedisCacheEvent');
    expect(redisSource).toContain('trace.getTracer');
    expect(workerSource).toContain('recordImportJobDuration');
  });
});
