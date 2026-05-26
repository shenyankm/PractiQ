# OpenWook Observability Runbook

This runbook defines the production baseline for monitoring, logging, metrics, tracing, and health checks.

## Endpoints

| Endpoint | Purpose | Access |
| --- | --- | --- |
| `/api/health/live` | Liveness: process is running | Public or load balancer |
| `/api/health` | Readiness: PostgreSQL and Redis status | Load balancer/internal |
| `/api/health/ready` | Alias for readiness | Load balancer/internal |
| `/api/metrics` | Prometheus metrics | Internal or `Authorization: Bearer $METRICS_TOKEN` |

Health responses intentionally expose only sanitized dependency status and latency. Raw dependency errors must remain in structured logs.

## Logs

OpenWook logs JSON through `pino` to stdout/stderr. The systemd units send logs to journald. Ship both journald output and Caddy access logs to a centralized store such as Loki, Elastic, CloudWatch, or Datadog. Use `ops/observability/journald.conf.example` as the retention baseline.

Minimum labels/fields to preserve:

- `service`
- `env`
- `level`
- `time`
- `requestId`
- `route`
- `method`
- `status`
- `durationMs`
- `jobId` / `importJobId` for worker events

Redaction is configured for passwords, hashes, cookies, authorization headers, tokens, API keys, private keys, and uploaded base64 file content. Do not log raw request bodies unless they have been explicitly sanitized.

## Metrics

The app exposes these metric families:

- `openwook_http_requests_total`
- `openwook_http_request_duration_seconds`
- `openwook_dependency_duration_seconds`
- `openwook_dependency_errors_total`
- `openwook_redis_cache_events_total`
- `openwook_import_jobs_total`
- `openwook_import_job_duration_seconds`
- `openwook_import_queue_jobs`
- default Node.js process metrics with the `openwook_` prefix

Recommended exporters:

- `node_exporter` for host CPU, memory, disk, and network
- `postgres_exporter` with `pg_stat_statements` enabled; see `ops/observability/postgresql.conf.example` and `postgres-observability.sql`
- `redis_exporter` for Redis memory, clients, evictions, command stats, and latency
- Caddy access-log ingestion or a Caddy Prometheus build if required

## Tracing / APM

`instrumentation.ts` registers `@vercel/otel` when the Next.js server starts. Configure an OpenTelemetry Collector with:

```env
OTEL_SERVICE_NAME=openwook-web
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

Route handlers and the import worker create application spans for API requests and import job processing. Export traces to Tempo, Jaeger, Honeycomb, Datadog, or another backend.

## Alerts

Start with these alerts:

- readiness health check failure for 2 consecutive checks
- HTTP 5xx rate > 1% for 5 minutes
- p95 HTTP latency above the product SLO
- PostgreSQL dependency error rate > 0 or slow query count spike
- Redis error count spike or cache hit ratio collapse
- import queue failed/stalled jobs > 0
- queue waiting depth continuously increasing
- worker process restart loop
- host disk > 80%, memory pressure, or sustained CPU saturation

## Local agent state

`.omx/` is Codex/OMX runtime state, not OpenWook application telemetry. It may contain prompt snippets, command lines, or local paths and is ignored by git.
