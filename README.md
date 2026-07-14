# OpenWook

OpenWook now runs as a split-stack application:

- Go serves the HTTP API, auth/session handling, PostgreSQL access, Redis-backed queues/caches, and the built frontend.
- Python serves the internal AI/document-processing endpoints.
- Vite + React + HeroUI provide the browser frontend.
- `backend/db/*/*.sql` remains the schema authority.

## Tech stack

- Frontend: Vite, React 19, React Router, HeroUI v3, Tailwind CSS v4
- API/runtime: Go 1.26, Chi, pgxpool, go-redis
- AI service: Python 3.14, FastAPI, LangGraph, Pydantic, Mammoth, external MinerU
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

## OpenCode

The project-level `.opencode/opencode.json` configures the HeroUI React MCP server. Restart OpenCode after cloning or after changing this configuration; OpenCode starts the server on demand through `npx`.

Direct dependencies are kept on current stable releases in `frontend/package.json`, `backend/go.mod`, and `ai/pyproject.toml`. Tooling versions must also satisfy peer ranges; for example, TypeScript stays on the newest stable version supported by `typescript-eslint`.

## API/runtime notes

- Health endpoints: `/api/health`, `/api/health/ready`, `/api/health/live`
- Session cookie name: `session`
- Redis remains the queue backend; there is no separate RabbitMQ/NATS/Kafka service
- AI routes exposed to the browser stay under `/api/v1/ai/*`; Go talks to Python over `AI_SERVICE_URL`
- The Python AI service routes document parsing, answer generation, and learning reports through one compiled LangGraph workflow. Internal multipart routes are `/internal/ai/upload-text`, `/internal/ai/upload-document`, and `/internal/ai/upload-scan`; all use the existing `AI_SERVICE_TOKEN` bearer authentication.
- TXT is decoded locally because MinerU does not accept text files. DOCX, PDF, and images are sent to the MinerU `/file_parse` API configured by `MINERU_API_URL`; the scan route forces OCR mode.
- Multipart upload results are validated as `DocumentParseResult` and stored in `ai_artifacts`; `AI_SERVICE_TOKEN` and a restricted `AI_POSTGRES_URL` are required for these routes. The AI container does not receive the application database credential. Set `OPENAI_BASE_URL` and `OPENAI_MODEL` to use an OpenAI-compatible parsing agent; otherwise the existing deterministic fallback remains active.

## Podman stack

The full local stack can be built and managed with one script:

```bash
./scripts/podman-stack.sh build
./scripts/podman-stack.sh up
./scripts/podman-stack.sh status
./scripts/podman-stack.sh logs
./scripts/podman-stack.sh down
```

`up`/`restart` ensure the isolated `openwook_app` database exists before the API and worker start, and create `~/.config/openwook/openwook-stack.env` with random local `AUTH_SECRET`, `AI_SERVICE_TOKEN`, and restricted AI database credentials. You still need to run the schema/seed commands once per fresh database; schema application grants the AI role only the import-job reads and artifact inserts it needs. Edit that env file if you want to rotate the generated local secrets.

This manages five services:

- `openwook-postgres`
- `openwook-redis`
- `openwook-ai`
- `openwook-api`
- `openwook-worker`

## Environment variables

See `.env.example` for the full set. The most important groups are:

- Database/cache: `POSTGRES_URL`, optional restricted `AI_POSTGRES_URL`, `REDIS_URL`
- Host/origin: `OPENWOOK_HOST`, `PORT`, `APP_ORIGIN`
- Auth/session: `AUTH_SECRET`, `SESSION_TTL_MS`, `SESSION_RENEW_WINDOW_MS`
- AI service: `AI_SERVICE_URL`, `AI_SERVICE_TOKEN`, `OPENAI_*`, `MINERU_*`, `AI_AGENT_*`
- Billing: `PADDLE_*`
- Object storage: `OBJECT_STORAGE_MOUNT_DIR`, `OSS_PUBLIC_BASE_URL`, `OSS_URL_PREFIX`

## Schema and architecture

- Product schema lives in `backend/db/*/*.sql`
- Runtime/bootstrap helpers live in `backend/internal/db`
- Product/API design notes live in `docs/system-design.md`
- Static-analysis orphan warning review lives in `docs/shazam-orphan-review.md`

MinerU currently requires Python earlier than 3.14, so run `mineru-api` in a separate Python 3.10-3.13 environment or service and point `MINERU_API_URL` at it. Do not install MinerU into the OpenWook AI container.
