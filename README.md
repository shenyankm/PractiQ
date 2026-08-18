# PractiQ

PractiQ runs as a unified-stack application:

- A single Python FastAPI service (`server/`) serves the HTTP API, auth/session handling, PostgreSQL-backed import queue and events, Redis caches/guards, and in-process LangGraph AI/document workflows.
- Taro under `taro/` is the current WeChat Mini Program frontend baseline; business flows are being restored incrementally.
- `db/*/*.sql` remains the schema authority.

## Tech stack

- Frontend: Taro 4.2, React 18, WeChat Mini Program
- Server: Python 3.14, FastAPI, Pydantic, psycopg (async pool), redis-py, LangGraph + LangChain OpenAI-compatible models (DashScope, DeepSeek, Moonshot), pypdfium2, Pillow, openpyxl
- Local infra: Docker Engine + Docker Compose for Postgres and Redis

## Local setup

1. Install dependencies and toolchains:

```bash
make install
python --version  # 3.14+
cd server && uv sync --extra dev
```

1. Install Docker Engine and the Compose plugin (Ubuntu), then sign out and back in once so group membership applies:

```bash
sudo apt update
sudo apt install docker.io docker-compose-v2 docker-buildx
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

1. Start PostgreSQL and Redis:

```bash
docker compose up -d postgres redis
```

The PostgreSQL container creates the isolated `practiq_app` database on first start so an older `practiq` database does not collide with this stack.

1. Copy environment defaults:

```bash
cp .env.example .env.local
```

Set a unique `AUTH_SECRET` value in `.env.local` before starting the service. Keep `.env.local` uncommitted.

Taro, development, database, and worker commands read the repository-root `.env.local`; existing shell environment variables take precedence.

1. Apply schema helpers to your local database:

```bash
make db-apply
make db-seed
```

## Development commands

```bash
make taro-weapp       # WeChat mini-program watcher
make server-dev      # unified FastAPI server on 127.0.0.1:8080 by default
make worker-imports  # import queue worker (python -m server.worker)
```

The frontend uses the same root `.env.local`; set `TARO_APP_API_URL` there. See `docs/taro-migration.md` before adding business APIs or persistent sessions.

## Test and verification commands

```bash
make test
make test-server
make verify
```

`make test` type-checks and builds the WeChat Mini Program; `make test-server` runs the Python server suite. Server coverage:

```bash
cd server && uv run --extra dev pytest tests --cov=server --cov-report=term
```

Server dependencies live in `server/pyproject.toml`; frontend dependencies live in `taro/package.json`.

## API/runtime notes

- Health endpoints: `/api/health`, `/api/health/ready`, `/api/health/live`
- Session cookies use a short-lived `session` access token plus HttpOnly `refresh_token`; the Mini Program may instead receive tokens through login/refresh JSON responses after secure storage is implemented.
- Registration requires a 6-digit email verification code from `POST /api/v1/auth/email-code` (stored in Redis for 10 minutes, single-use). Codes are emailed through SMTP; with `SMTP_HOST` unset the code is logged instead (local development only).
- `/api/health/ready` returns `503` until both PostgreSQL and Redis are configured and reachable; `/api/health` continues to return dependency status data.
- PostgreSQL stores active sessions, hashed refresh tokens, and revocations. Redis is required for email verification codes and login/register rate limits; cache reads and writes remain best-effort.
- PostgreSQL is the durable import queue, LangGraph checkpoint store, and event history. Import progress supports authenticated SSE with polling fallback.
- Client writes may carry `Idempotency-Key`; Redis stores successful replays for 24 hours.
- Media uploads currently accept content-sniffed PNG, JPEG, GIF, and WebP files up to 10 MiB under `OBJECT_STORAGE_MOUNT_DIR`.
- `db/*/*.sql` contains bootstrap schema fragments for fresh or reset environments, not a versioned production migration history. For a fresh local database, run `make db-apply` and `make db-seed`; the schema includes RevenueCat identities, `free`/`pro`/`organization` membership with a 3-day Pro trial, study groups, encrypted per-user LLM configuration, LangGraph checkpoints, media ownership, and the terminal import status `cancelled`.
- AI routes stay under `/api/v1/ai/*`; the server runs LangGraph workflows in-process with no internal HTTP hop. Import workers checkpoint only the AI phase and retain the existing non-retryable persistence boundary.
- Free users retain basic learning features and see an internal upgrade promotion. Effective Pro-or-higher membership, including the 3-day trial, removes the promotion and permits encrypted LLM-key storage and cloud AI. Supported providers are DashScope, DeepSeek, and Moonshot; DeepSeek is text-only.
- Membership has three tiers (`free`/`pro`/`organization`) plus a 3-day Pro trial for new users; see `docs/membership-design.md`. Effective Pro-or-higher users may clone public banks via `POST /api/v1/banks/{bankId}/clone`; organization users manage study groups under `/api/v1/study-groups/*` (members, linked banks, member stats).
- The authenticated `/api/v1/billing/sync` route and RevenueCat webhook re-read current v2 active entitlements before updating server authorization; purchase UI is not yet restored in Taro.
- TXT, Markdown, CSV, DOCX, PDF, XLSX, and PNG/JPEG/GIF/WebP image preprocessing run in-process. Users with effective Pro-or-higher membership select their own text model and, for DashScope or Moonshot, an optional vision model. Image imports and image-only documents require a vision model. `AI_AGENT_*` bounds tokens, timeouts, and per-worker graph concurrency; `AI_MAX_OCR_PAGES`, `AI_MAX_VISION_BYTES`, and `AI_MAX_VISION_PAGE_PIXELS` bound scanned-PDF/embedded-image work and checkpoint size.

For an existing database, apply `db/users/11_supported_llm_providers.sql`, `db/users/12_remove_google_auth.sql`, and `db/imports/45_langgraph_checkpoints.sql` before deployment. The Google-removal migration revokes active sessions for passwordless legacy accounts before dropping `google_sub`; the provider migration clears unsupported stored keys and DeepSeek vision settings by design.

## Docker stack

The full local stack is defined in `compose.yaml`:

```bash
docker compose up -d --build
docker compose ps
```

The server and worker read repository-root `.env.local` when present. Set its required values, including a random local `AUTH_SECRET`, before starting the full stack. PostgreSQL creates the isolated `practiq_app` database on first start, and you still need to run the schema/seed commands once per fresh database.

Docker Compose manages four services: `postgres`, `redis`, `server`, and `worker`. Stop them with `docker compose down`; named PostgreSQL and Redis volumes remain until explicitly removed.

## Environment variables

See `.env.example` for the full set. The most important groups are:

- Database/cache: `POSTGRES_URL`, `REDIS_URL`
- Host/origin: `PRACTIQ_HOST`, `PORT`, `APP_ORIGIN`
- Taro build-time API endpoint: `TARO_APP_API_URL` in root `.env.local`
- Auth/session: required `AUTH_SECRET`, `ACCESS_TOKEN_TTL_MS`, `REFRESH_TOKEN_TTL_MS`, `SESSION_ABSOLUTE_TTL_MS`, optional `SEED_ADMIN_PASSWORD` (password for the seeded `admin` user; defaults to the local dev value, set it on any shared environment)
- Registration email codes: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM`
- RevenueCat server: required `REVENUECAT_PROJECT_ID`, v2 `REVENUECAT_SECRET_API_KEY`, internal `REVENUECAT_PRO_ENTITLEMENT_ID`, organization-tier `REVENUECAT_ORGANIZATION_ENTITLEMENT_ID` (defaults to `organization`), and exact `REVENUECAT_WEBHOOK_AUTHORIZATION` header value
- AI: required `LLM_KEY_ENCRYPTION_SECRET`, plus `AI_AGENT_*`, `AI_MAX_OCR_PAGES`, and `AI_APPLY_MIN_CONFIDENCE`
- Object storage: `OBJECT_STORAGE_MOUNT_DIR`, `OSS_PUBLIC_BASE_URL`, `OSS_URL_PREFIX`

`AUTH_SECRET` is required in every environment and must be an unpredictable value. Access JWTs default to 10 minutes; refresh tokens default to 30 days and rotate after each use; the device session has a 90-day absolute limit. Refresh tokens are stored only as SHA-256 hashes in PostgreSQL. `POST /api/v1/auth/refresh` accepts the mobile JSON refresh token or the HttpOnly refresh cookie. Changing a password revokes all of that user's sessions.

In RevenueCat, create the `pro` and `organization` entitlements, attach store products to offerings/paywalls, and use a v2 secret key with `customer_information:customers:read`. Configure the webhook URL as `{APP_ORIGIN}/api/v1/billing/revenuecat/webhook`, set its Authorization header to the exact server value, and choose **Keep with original App User ID** for restore behavior. Server entitlement variables use RevenueCat's internal `entl…` resource IDs; any future client purchase flow must use the public lookup key. Keep `LLM_KEY_ENCRYPTION_SECRET` stable: changing it makes stored user keys unreadable.

## Schema and architecture

- Product schema lives in `db/*/*.sql`
- The unified server lives in `server/` (API + AI + worker + admin CLI)
- The WeChat Mini Program lives in `taro/`; PostgreSQL remains authoritative.
- The Taro rollout plan and parity gates live in `docs/taro-migration.md`.
- Product/API design notes live in `docs/system-design.md`
