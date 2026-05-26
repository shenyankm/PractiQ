# Observability Config Samples

These files are deployable starting points, not secrets-bearing production manifests.

- `prometheus.yml`: scrapes OpenWook `/api/metrics`, node exporter, postgres exporter, and redis exporter.
- `alerts.yml`: starter alert rules for 5xx rate, p95 latency, dependency errors, import failures, and queue backlog.
- `otel-collector.yml`: OTLP receiver and Tempo/logging exporters for Next.js `@vercel/otel` traces.
- `fluent-bit.conf`: example journald + Caddy access log collection. Replace the stdout output with Loki, Elastic, CloudWatch, or Datadog in production.

Set `METRICS_TOKEN` in Prometheus and `.env.local`; keep it out of source control.

- `docker-compose.yml`: optional local stack for Prometheus, OpenTelemetry Collector, node exporter, Redis exporter, and Postgres exporter.
- `journald.conf.example`: retention and persistent-storage baseline for systemd app/worker logs.
- `postgresql.conf.example` and `postgres-observability.sql`: PostgreSQL slow-query logging and `pg_stat_statements` enablement.
