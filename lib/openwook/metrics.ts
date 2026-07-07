import 'server-only';

import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { env } from './env';

const globalForMetrics = globalThis as typeof globalThis & {
  __openwookMetrics?: OpenWookMetrics;
};

type HttpLabel = 'method' | 'route' | 'status';
type DependencyLabel = 'dependency' | 'operation' | 'status';
type CacheLabel = 'event';
type JobLabel = 'queue' | 'status';
type QueueLabel = 'queue' | 'state';

type HttpLabels = Record<HttpLabel, string>;
type DependencyLabels = Record<DependencyLabel, string>;

type OpenWookMetrics = ReturnType<typeof createMetrics>;

function createMetrics() {
  const registry = new Registry();
  const serviceName = env.OTEL_SERVICE_NAME || 'openwook';
  registry.setDefaultLabels({ service: serviceName });
  collectDefaultMetrics({ register: registry, prefix: 'openwook_' });

  const httpRequestsTotal = new Counter<HttpLabel>({
    name: 'openwook_http_requests_total',
    help: 'Total HTTP requests handled by OpenWook route handlers.',
    labelNames: ['method', 'route', 'status'],
    registers: [registry]
  });

  const httpRequestDurationSeconds = new Histogram<HttpLabel>({
    name: 'openwook_http_request_duration_seconds',
    help: 'HTTP request duration by method, route, and status.',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry]
  });

  const dependencyDurationSeconds = new Histogram<DependencyLabel>({
    name: 'openwook_dependency_duration_seconds',
    help: 'Dependency operation duration by dependency, operation, and status.',
    labelNames: ['dependency', 'operation', 'status'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry]
  });

  const dependencyErrorsTotal = new Counter<DependencyLabel>({
    name: 'openwook_dependency_errors_total',
    help: 'Dependency operation errors by dependency and operation.',
    labelNames: ['dependency', 'operation', 'status'],
    registers: [registry]
  });

  const redisCacheEventsTotal = new Counter<CacheLabel>({
    name: 'openwook_redis_cache_events_total',
    help: 'Redis cache hit, miss, disabled, and error events.',
    labelNames: ['event'],
    registers: [registry]
  });

  const importJobsTotal = new Counter<JobLabel>({
    name: 'openwook_import_jobs_total',
    help: 'Import job lifecycle events observed by the worker.',
    labelNames: ['queue', 'status'],
    registers: [registry]
  });

  const importJobDurationSeconds = new Histogram<JobLabel>({
    name: 'openwook_import_job_duration_seconds',
    help: 'Import worker job duration by queue and final status.',
    labelNames: ['queue', 'status'],
    buckets: [1, 5, 10, 30, 60, 120, 300, 600, 1200, 1800, 3600],
    registers: [registry]
  });

  const importQueueJobs = new Gauge<QueueLabel>({
    name: 'openwook_import_queue_jobs',
    help: 'BullMQ import queue job counts by state.',
    labelNames: ['queue', 'state'],
    registers: [registry]
  });

  return {
    registry,
    httpRequestsTotal,
    httpRequestDurationSeconds,
    dependencyDurationSeconds,
    dependencyErrorsTotal,
    redisCacheEventsTotal,
    importJobsTotal,
    importJobDurationSeconds,
    importQueueJobs
  };
}

export const metrics = globalForMetrics.__openwookMetrics ??= createMetrics();

export function recordHttpRequest(labels: HttpLabels, durationMs: number) {
  metrics.httpRequestsTotal.inc(labels);
  metrics.httpRequestDurationSeconds.observe(labels, durationMs / 1000);
}

export function recordDependencyDuration(labels: DependencyLabels, durationMs: number) {
  metrics.dependencyDurationSeconds.observe(labels, durationMs / 1000);
  if (labels.status !== 'ok') metrics.dependencyErrorsTotal.inc(labels);
}

export function recordRedisCacheEvent(event: 'hit' | 'miss' | 'disabled' | 'error' | 'set_error') {
  metrics.redisCacheEventsTotal.inc({ event });
}

export function recordImportJobEvent(queue: string, status: 'active' | 'completed' | 'failed') {
  metrics.importJobsTotal.inc({ queue, status });
}

export function recordImportJobDuration(queue: string, status: 'completed' | 'failed', durationMs: number) {
  metrics.importJobDurationSeconds.observe({ queue, status }, durationMs / 1000);
}

export function setImportQueueCounts(queue: string, counts: Record<string, number | undefined>) {
  for (const [state, count] of Object.entries(counts)) {
    metrics.importQueueJobs.set({ queue, state }, Number(count ?? 0));
  }
}

