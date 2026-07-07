# OpenWook - Full-Stack Next.js Application

A complete full-stack application built with Next.js, PostgreSQL, HeroUI, and Tailwind CSS.

## Product Design

The question-bank product design based on the split PostgreSQL schema files in `db/*/*.sql` is documented in [docs/system-design.md](docs/system-design.md). It covers the REST API surface, frontend pages, core modules, data flows, validation, errors, and implementation roadmap.

## Tech Stack

- **Framework**: Next.js 15.6.0-canary.59 (App Router)
- **Language**: TypeScript
- **Database**: PostgreSQL (via `postgres` driver)
- **UI**: HeroUI + Tailwind CSS v4
- **Styling**: CSS Variables + oklch color system

## Quick Start

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Set Up Database and Redis

Start the local PostgreSQL and Redis containers with Podman + Quadlet:

```bash
./scripts/podman-db.sh up
./scripts/podman-redis.sh up
```

Create a `.env.local` file (or copy `.env.example`):

```env
DATABASE_URL=postgres://openwook:openwook@localhost:54322/openwook
POSTGRES_URL=postgres://openwook:openwook@localhost:54322/openwook
REDIS_URL=redis://localhost:6379
```

Apply migrations:

```bash
pnpm db:migrate
```

### 3. Run Development Server

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000)

## Application Surface

OpenWook uses the App Router under `app/`, API routes under `app/api`, HeroUI components directly in app screens, domain services under `lib/openwook`, and Drizzle schema/migrations under `lib/db`. See `docs/system-design.md` for the current product/API design.

## Database Configuration

Local PostgreSQL is managed by rootless Podman Quadlet units in `containers/quadlet/`:

```bash
./scripts/podman-db.sh up       # install/update Quadlet files and start Postgres
./scripts/podman-db.sh status   # show systemd and container status
./scripts/podman-db.sh down     # stop the database service
./scripts/podman-db.sh logs     # follow database logs
```

The container publishes Postgres on `127.0.0.1:54322` to avoid conflicts with a host Postgres on `5432`.

The database connection uses connection pooling configured by `POSTGRES_POOL_MAX`, `POSTGRES_IDLE_TIMEOUT_SECONDS`, and `POSTGRES_CONNECT_TIMEOUT_SECONDS`.

## Redis, Caching, and Import Workers

OpenWook uses PostgreSQL as the source of truth and Redis as an optional acceleration and coordination layer.

Redis-backed features:

- Short-TTL cache for reference data, user profiles, bank lists/items, question detail, answer keys, and analytics summaries.
- JWT session revocation on logout through `jti` blacklist keys.
- Login/register rate limiting.
- Stable practice-session question queues and duplicate answer submission protection.
- BullMQ import queue for long-running document parsing jobs.
- Redis Pub/Sub + SSE for live import progress events.
- AI result de-duplication cache, bank leaderboard cache, and analytics snapshot cache.

Local Redis is managed by rootless Podman Quadlet units in `containers/quadlet/`, matching PostgreSQL:

```bash
./scripts/podman-redis.sh up       # install/update Quadlet files and start Redis
./scripts/podman-redis.sh status   # show systemd and container status
./scripts/podman-redis.sh down     # stop the Redis service
./scripts/podman-redis.sh logs     # follow Redis logs
```

The Redis container publishes on `127.0.0.1:6379`. BullMQ uses this same Redis service as its queue backend, so there is no separate local broker container to run.

Set environment variables:

```env
REDIS_URL=redis://localhost:6379
REDIS_KEY_PREFIX=openwook
IMPORT_WORKER_CONCURRENCY=2
IMPORT_QUEUE_ATTEMPTS=3
AI_CACHE_TTL_SECONDS=86400
LEADERBOARD_CACHE_TTL_SECONDS=60
```

AI model calls use the Mastra OpenAI-compatible client. Configure at least one provider; the runtime fallback order is Kimi/Moonshot, then DeepSeek, then an OpenAI-compatible fallback:

```env
MOONSHOT_API_KEY=sk-...
# Optional, defaults to https://api.moonshot.cn/v1 and kimi-k2.6
MOONSHOT_BASE_URL=https://api.moonshot.cn/v1

# Tried when Kimi is not configured or the primary provider call fails.
DEEPSEEK_API_KEY=sk-...
# Optional, defaults to https://api.deepseek.com and deepseek-v4-flash
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash

# Optional generic OpenAI-compatible fallback.
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
MASTRA_MODEL=
MASTRA_TEMPERATURE=
MASTRA_MAX_TOKENS=
```

Run the Next.js app and the import worker in separate processes:

```bash
pnpm dev
pnpm worker:imports
```

Health check:

```text
GET /api/health
```

Redis cache failures degrade to PostgreSQL reads. Queue, lock, and live-progress features require `REDIS_URL`.

## Object Storage

OpenWook stores uploaded avatars and import source files through a mounted object-storage directory. PostgreSQL keeps the object URL, while the mounted path is used only by the server to write or read the original file.

Set environment variables:

```env
OBJECT_STORAGE_MOUNT_DIR=/lhcos-data
OSS_PUBLIC_BASE_URL=https://<bucket>.cos.<region>.myqcloud.com
OSS_URL_PREFIX=oss://openwook
AVATAR_MAX_BYTES=5242880
IMPORT_SOURCE_MAX_BYTES=26214400
```

If `OSS_PUBLIC_BASE_URL` is set, user avatars are stored in PostgreSQL as browser-usable HTTPS object URLs. If it is omitted, OpenWook stores `OSS_URL_PREFIX` URLs such as `oss://openwook/avatars/...`.

## Environment Variables

Copy `.env.example` to `.env.local` for local development and replace all placeholder secrets before deployment.

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `POSTGRES_POOL_MAX` | Maximum PostgreSQL connections per Next.js or worker process; tune lower when running multiple web instances |
| `POSTGRES_IDLE_TIMEOUT_SECONDS` | Idle timeout for postgres.js connections |
| `POSTGRES_CONNECT_TIMEOUT_SECONDS` | Connection timeout for postgres.js connections |
| `REDIS_URL` | Redis connection string for cache, rate limits, queue, locks, and SSE |
| `REDIS_KEY_PREFIX` | Optional Redis key namespace prefix |
| `IMPORT_WORKER_CONCURRENCY` | Number of import jobs processed per worker |
| `IMPORT_QUEUE_ATTEMPTS` | BullMQ retry attempts for import jobs |
| `AI_CACHE_TTL_SECONDS` | TTL for repeated AI parse/answer cache entries |
| `MOONSHOT_API_KEY` | Kimi/Moonshot API key; primary Mastra model provider |
| `MOONSHOT_BASE_URL` | Optional Kimi-compatible base URL; defaults to `https://api.moonshot.cn/v1` |
| `DEEPSEEK_API_KEY` | DeepSeek API key; fallback after Kimi or primary provider failure |
| `DEEPSEEK_BASE_URL` | Optional DeepSeek OpenAI-compatible base URL; defaults to `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | Optional DeepSeek model override; defaults to `deepseek-v4-flash` |
| `OPENAI_API_KEY` | Optional OpenAI-compatible fallback API key |
| `OPENAI_BASE_URL` | Optional OpenAI-compatible fallback base URL |
| `OPENAI_MODEL` | Optional OpenAI-compatible fallback model |
| `MASTRA_MODEL` | Optional global model override for the selected provider |
| `MASTRA_TEMPERATURE` | Optional global model temperature override |
| `MASTRA_MAX_TOKENS` | Optional global max token override |
| `LEADERBOARD_CACHE_TTL_SECONDS` | TTL for bank leaderboard cache entries |
| `OBJECT_STORAGE_MOUNT_DIR` | Local mount path for the object-storage bucket |
| `OSS_PUBLIC_BASE_URL` | Public bucket URL used for persisted avatar and source-file URLs |
| `OSS_URL_PREFIX` | Fallback object URL prefix when no public bucket URL is configured |
| `AVATAR_MAX_BYTES` | Max uploaded avatar size in bytes |
| `IMPORT_SOURCE_MAX_BYTES` | Max uploaded TXT/DOCX source size in bytes |
| `NEXT_PUBLIC_APP_URL` | Public app URL |
| `LOG_LEVEL` | Structured application log level; defaults to `info` in production |
| `SLOW_QUERY_MS` | PostgreSQL slow-operation warning threshold in milliseconds |
| `HEALTH_CHECK_TIMEOUT_MS` | Per-dependency health-check timeout in milliseconds |
| `METRICS_TOKEN` | Bearer token required for `/api/metrics` in production |
| `OTEL_SERVICE_NAME` | OpenTelemetry service name used by `instrumentation.ts` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP collector endpoint for traces/metrics export |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | OTLP protocol, for example `http/protobuf` |
| `OPENWOOK_SHORT_CACHE_TTL_SECONDS` | TTL for short-lived hot-path caches such as bank item pages |
| `OPENWOOK_REFERENCE_CACHE_TTL_SECONDS` | TTL for reference data caches |
| `PRACTICE_MAX_QUESTIONS` | Upper bound for questions selected in one practice session |
| `PRACTICE_PROGRESS_FULL_LIMIT` | Full progress-grid render limit; larger sessions return a windowed progress grid |
| `PRACTICE_PROGRESS_WINDOW_RADIUS` | Number of nearby questions kept on each side of the current practice question |

## Observability and Operations

OpenWook includes a production observability baseline:

- Structured JSON application logs through `pino`, with redaction for passwords, cookies, authorization headers, tokens, API keys, private keys, and uploaded `fileBase64` payloads.
- Request correlation with `x-request-id`; API JSON envelopes include `meta.requestId` or `error.requestId`.
- Hardened health checks: `/api/health` and `/api/health/ready` verify PostgreSQL and Redis with sanitized dependency status, while `/api/health/live` only verifies process liveness.
- Prometheus metrics at `/api/metrics`; production scrapes must send `Authorization: Bearer $METRICS_TOKEN`.
- OpenTelemetry startup in `instrumentation.ts` using `@vercel/otel`. Configure an OTLP collector with `OTEL_EXPORTER_OTLP_ENDPOINT`.
- Database, Redis, HTTP route, and import-worker metrics for latency, errors, cache hit/miss, queue depth, job lifecycle, and slow query warnings.

App and worker logs go to stdout. `.omx/` is local agent runtime state and is ignored by git; do not use it as application monitoring data.

## Features

- **Server Components**: Data fetching on the server
- **Client Components**: Interactive UI with React hooks
- **API Routes**: RESTful endpoints with proper error handling
- **Type Safety**: Full TypeScript coverage
- **Health Checks**: Real-time system status monitoring
- **Database Pooling**: Efficient connection management
- **CORS Headers**: Configured for API routes
- **HeroUI Theme**: Light/dark mode support

## License

MIT
