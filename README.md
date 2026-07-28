# PractiQ

PractiQ now runs as a split-stack application:

- Go serves the HTTP API, auth/session handling, PostgreSQL-backed import queue, Redis caches/events, and the built frontend.
- Python serves the internal AI/document-processing endpoints.
- Vite + React + HeroUI provide the browser frontend.
- Expo + React Native provide the PractiQ-branded Android/iOS client under `mobile/`.
- `backend/db/*/*.sql` remains the schema authority.

## Tech stack

- Frontend: Vite, React 19, React Router, HeroUI v3, Tailwind CSS v4
- Mobile: Expo SDK 57, React Native, Expo Router, HeroUI Native, SQLite offline cache/outbox
- API/runtime: Go 1.26, `net/http`, pgxpool, go-redis
- AI service: Python 3.14, FastAPI, Pydantic, AgentScope (DashScope models), Mammoth, pypdf, pypdfium2, Pillow, openpyxl
- Local infra: Podman Quadlet for Postgres and Redis

## Local setup

1. Install dependencies and toolchains:

```bash
make install
go version
python --version
python -m pip install -e 'ai[dev]'
```

1. Start the local Podman stack:

```bash
./scripts/podman-stack.sh up
```

The Podman helper script ensures the isolated `practiq_app` database exists inside the shared local PostgreSQL volume so an older `practiq` database does not collide with this stack.

1. Copy environment defaults:

```bash
cp .env.example .env.local
```

Set unique `AUTH_SECRET` and `AI_SERVICE_TOKEN` values in `.env.local` before starting the services. Keep `.env.local` uncommitted.

The development, database, and worker targets load the repository-root `.env.local`. Go commands use `config.Load`; `make ai-dev` exports the file before starting Uvicorn. Existing shell environment variables take precedence for Go commands.

1. Apply schema helpers to your local database:

```bash
make db-apply
make db-seed
```

## Development commands

```bash
make dev             # Vite frontend on 127.0.0.1:3000
make mobile-dev      # Expo development server
make mobile-android  # Android development build
make mobile-ios      # iOS development build (macOS only)
make api-dev         # Go API on 127.0.0.1:8080 by default
make ai-dev          # FastAPI AI service on 127.0.0.1:8001
make worker-imports  # Go import worker
```

Set `GO_API_URL=http://127.0.0.1:8080` when running `make dev` against a non-default API URL.
For mobile development, copy `mobile/.env.example` to `mobile/.env` and set `EXPO_PUBLIC_API_URL` to an API address reachable from the emulator or device.

## Test and verification commands

```bash
make lint
make test
make test-go
make test-ai
make test-e2e
make mobile-test
make build
make verify
```

`make lint` and `make test` cover both frontends; `make build` runs the browser TypeScript check before the Vite production build.

## OpenCode

The project-level `.opencode/opencode.json` configures the HeroUI React MCP server. Restart OpenCode after cloning or after changing this configuration; OpenCode starts the server on demand through `npx`.

Direct dependencies are kept on current stable releases in `frontend/package.json`, `backend/go.mod`, and `ai/pyproject.toml`. Tooling versions must also satisfy peer ranges; for example, TypeScript stays on the newest stable version supported by `typescript-eslint`.

## API/runtime notes

- Health endpoints: `/api/health`, `/api/health/ready`, `/api/health/live`
- Session cookie name: `session`
- `/api/health/ready` returns `503` until both PostgreSQL and Redis are configured and reachable; `/api/health` continues to return dependency status data.
- Redis is required for active-session revocation checks, logout revocation writes, and login/register rate limits. Cache reads and writes remain best-effort.
- PostgreSQL is the durable import queue and event history; Web and mobile poll job/event endpoints for progress.
- Mobile writes carry `Idempotency-Key`; Redis stores successful replays for 24 hours. Cached mobile reads remain available offline, and queued writes replay in order after reconnection.
- Media uploads currently accept content-sniffed PNG, JPEG, GIF, and WebP files up to 10 MiB under `OBJECT_STORAGE_MOUNT_DIR`.
- Fresh schema installs include `media_assets.created_by` ownership and the terminal import status `cancelled`; apply the current schema before running these flows.
- AI routes exposed to the browser stay under `/api/v1/ai/*`; Go talks to Python over `AI_SERVICE_URL`
- Internal AI routes are `/internal/ai/parse-document`, `/internal/ai/generate-answer`, and `/internal/ai/learning-report`; all require `AI_SERVICE_TOKEN` bearer authentication.
- TXT, DOCX, PDF, and XLSX preprocessing run locally. Set `DASHSCOPE_API_KEY` to enable AgentScope-backed parsing, answer generation, and learning reports (`AI_TEXT_MODEL`/`AI_VL_MODEL` override the default `qwen-max`/`qwen-vl-max`); otherwise the deterministic fallback remains active. Scanned PDF pages are rendered and OCR'd through the vision model, including figure detection with bounding-box crops.
- Membership tiers are admin-managed; billing checkout and webhook routes are not active.

## Podman stack

The full local stack can be built and managed with one script:

```bash
./scripts/podman-stack.sh build
./scripts/podman-stack.sh up
./scripts/podman-stack.sh status
./scripts/podman-stack.sh logs
./scripts/podman-stack.sh down
```

`up`/`restart` ensure the isolated `practiq_app` database exists before the API and worker start, and create `~/.config/practiq/practiq-stack.env` with random local `AUTH_SECRET` and `AI_SERVICE_TOKEN` values. You still need to run the schema/seed commands once per fresh database. Edit that env file if you want to rotate the generated local secrets.

This manages five services:

- `practiq-postgres`
- `practiq-redis`
- `practiq-ai`
- `practiq-api`
- `practiq-worker`

## Environment variables

See `.env.example` for the full set. The most important groups are:

- Database/cache: `POSTGRES_URL`, `REDIS_URL`
- Host/origin: `PRACTIQ_HOST`, `PORT`, `APP_ORIGIN`
- Mobile build-time API endpoint: `EXPO_PUBLIC_API_URL` in `mobile/.env`
- Auth/session: required `AUTH_SECRET`, `SESSION_TTL_MS`, optional `SEED_ADMIN_PASSWORD` (password for the seeded `admin` user; defaults to the local dev value, set it on any shared environment)
- AI service: `AI_SERVICE_URL`, `AI_SERVICE_TOKEN`, `AI_SERVICE_TIMEOUT`, `DASHSCOPE_API_KEY`, `AI_TEXT_MODEL`, `AI_VL_MODEL`, `AI_AGENT_*`, `AI_MAX_OCR_PAGES`
- Object storage: `OBJECT_STORAGE_MOUNT_DIR`, `OSS_PUBLIC_BASE_URL`, `OSS_URL_PREFIX`

`AUTH_SECRET` is required in every environment and must be an unpredictable value. `SESSION_TTL_MS` controls both the signed session expiry and cookie expiry; it defaults to seven days when omitted. Session renewal is not implemented, so there is no renewal-window setting.

## Schema and architecture

- Product schema lives in `backend/db/*/*.sql`
- Runtime/bootstrap helpers live in `backend/internal/db`
- Browser and mobile clients live in `frontend/` and `mobile/`; PostgreSQL remains authoritative for both.
- Product/API design notes live in `docs/system-design.md`
