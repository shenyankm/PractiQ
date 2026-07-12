# OpenWook

OpenWook now runs as a split-stack application:

- Go serves the HTTP API, auth/session handling, PostgreSQL access, Redis-backed queues/caches, and the built frontend.
- Python serves the internal AI/document-processing endpoints.
- Vite + React + HeroUI provide the browser frontend.
- `backend/db/*/*.sql` remains the schema authority.

## Tech stack

- Frontend: Vite, React 19, React Router, HeroUI v3, Tailwind CSS v4
- API/runtime: Go 1.26, Chi, pgxpool, go-redis
- AI service: Python 3.14, FastAPI, LangGraph, Pydantic, Mammoth
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

The Podman helper script ensures the isolated `openwook_app` database exists inside the shared local PostgreSQL volume so an older `openwook` database does not collide with this stack.

1. Copy environment defaults:

```bash
cp .env.example .env.local
```

1. Apply schema helpers to your local database:

```bash
make db-apply
make db-ensure
make db-seed
```

## Development commands

```bash
make dev             # Vite frontend on 127.0.0.1:3000
make api-dev         # Go API on 127.0.0.1:8080 by default
make ai-dev          # FastAPI AI service on 127.0.0.1:8001
make worker-imports  # Go import worker
```

Set `GO_API_URL=http://127.0.0.1:8080` when running `make dev` against a non-default API URL.

## Test and verification commands

```bash
make lint
make test
make test-go
make test-ai
make test-e2e
make build
make verify
```

`make build` runs the frontend TypeScript check before the Vite production build.

Direct dependencies are kept on current stable releases in `frontend/package.json`, `backend/go.mod`, and `ai/pyproject.toml`. Tooling versions must also satisfy peer ranges; for example, TypeScript stays on the newest stable version supported by `typescript-eslint`.

## API/runtime notes

- Health endpoints: `/api/health`, `/api/health/ready`, `/api/health/live`
- Session cookie name: `session`
- Redis remains the queue backend; there is no separate RabbitMQ/NATS/Kafka service
- AI routes exposed to the browser stay under `/api/v1/ai/*`; Go talks to Python over `AI_SERVICE_URL`
- The Python AI service routes document parsing, answer generation, and learning reports through one compiled LangGraph workflow.

## Podman stack

The full local stack can be built and managed with one script:

```bash
./scripts/podman-stack.sh build
./scripts/podman-stack.sh up
./scripts/podman-stack.sh status
./scripts/podman-stack.sh logs
./scripts/podman-stack.sh down
```

`up`/`restart` ensure the isolated `openwook_app` database exists before the API and worker start, and create `~/.config/openwook/openwook-stack.env` with random local `AUTH_SECRET` and `AI_SERVICE_TOKEN` values on first use. You still need to run the schema/seed commands once per fresh database. Edit that env file if you want to rotate the generated local secrets.

This manages five services:

- `openwook-postgres`
- `openwook-redis`
- `openwook-ai`
- `openwook-api`
- `openwook-worker`

## Environment variables

See `.env.example` for the full set. The most important groups are:

- Database/cache: `POSTGRES_URL`, `REDIS_URL`
- Host/origin: `OPENWOOK_HOST`, `PORT`, `APP_ORIGIN`
- Auth/session: `AUTH_SECRET`, `SESSION_TTL_MS`, `SESSION_RENEW_WINDOW_MS`
- AI service: `AI_SERVICE_URL`, `AI_SERVICE_TOKEN`
- Billing: `PADDLE_*`
- Object storage: `OBJECT_STORAGE_MOUNT_DIR`, `OSS_PUBLIC_BASE_URL`, `OSS_URL_PREFIX`

## Schema and architecture

- Product schema lives in `backend/db/*/*.sql`
- Runtime/bootstrap helpers live in `backend/internal/db`
- Product/API design notes live in `docs/system-design.md`
- Static-analysis orphan warning review lives in `docs/shazam-orphan-review.md`
