# PractiQ

PractiQ runs as a unified-stack application:

- A single Python FastAPI service (`server/`) serves the HTTP API, auth/session handling, PostgreSQL-backed import queue, Redis caches/events, and AI/document processing (agentscope, in-process).
- Expo + React Native provide the PractiQ-branded Android/iOS client under `mobile/`.
- `db/*/*.sql` remains the schema authority.

## Tech stack

- Mobile: Expo SDK 57, React Native, Expo Router, HeroUI Native, SQLite offline cache/outbox
- Server: Python 3.14, FastAPI, Pydantic, psycopg (async pool), redis-py, AgentScope (DashScope models), pypdfium2, Pillow, openpyxl
- Local infra: Podman Quadlet for Postgres and Redis

## Local setup

1. Install dependencies and toolchains:

```bash
make install
python --version  # 3.14+
cd server && uv sync --extra dev
```

1. Start the local Podman stack (Postgres and Redis run as Quadlet units):

```bash
cp containers/quadlet/* ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start practiq-postgres practiq-redis
```

The `practiq-postgres` unit creates the isolated `practiq_app` database on first start so an older `practiq` database does not collide with this stack.

1. Copy environment defaults:

```bash
cp .env.example .env.local
```

Set a unique `AUTH_SECRET` value in `.env.local` before starting the service. Keep `.env.local` uncommitted.

The development, database, and worker targets load the repository-root `.env.local` (via `server/config.py`); existing shell environment variables take precedence.

1. Apply schema helpers to your local database:

```bash
make db-apply
make db-seed
```

## Development commands

```bash
make mobile-dev      # Expo development server
make mobile-android  # Android development build
make mobile-ios      # iOS development build (macOS only)
make server-dev      # unified FastAPI server on 127.0.0.1:8080 by default
make worker-imports  # import queue worker (python -m server.worker)
```

For mobile development, copy `mobile/.env.example` to `mobile/.env` and set `EXPO_PUBLIC_API_URL` to an API address reachable from the emulator or device.

## Test and verification commands

```bash
make lint
make test
make test-server
make mobile-test
make verify
```

`make lint` and `make test` cover the mobile client; `make test-server` runs the Python server suite.

## OpenCode

The project-level `.opencode/opencode.json` configures the HeroUI React MCP server. Restart OpenCode after cloning or after changing this configuration; OpenCode starts the server on demand through `npx`.

Direct dependencies are kept on current stable releases in `mobile/package.json` and `server/pyproject.toml`. Tooling versions must also satisfy peer ranges; for example, TypeScript stays on the newest stable version supported by `typescript-eslint`.

## API/runtime notes

- Health endpoints: `/api/health`, `/api/health/ready`, `/api/health/live`
- Session cookie name: `session`
- Registration requires a 6-digit email verification code from `POST /api/v1/auth/email-code` (stored in Redis for 10 minutes, single-use). Codes are emailed through SMTP; with `SMTP_HOST` unset the code is logged instead (local development only).
- Google sign-in: `GET /api/v1/auth/google/start` + `GET /api/v1/auth/google/callback` (browser authorization-code flow) and `POST /api/v1/auth/google/token` (mobile ID-token exchange). All three return 404 until `GOOGLE_CLIENT_ID` is configured. Accounts match by Google subject, then link by verified email, then a new user is created without a password.
- `/api/health/ready` returns `503` until both PostgreSQL and Redis are configured and reachable; `/api/health` continues to return dependency status data.
- Redis is required for active-session revocation checks, logout revocation writes, and login/register rate limits. Cache reads and writes remain best-effort.
- PostgreSQL is the durable import queue and event history; Web and mobile poll job/event endpoints for progress.
- Mobile writes carry `Idempotency-Key`; Redis stores successful replays for 24 hours. Cached mobile reads remain available offline, and queued writes replay in order after reconnection.
- Media uploads currently accept content-sniffed PNG, JPEG, GIF, and WebP files up to 10 MiB under `OBJECT_STORAGE_MOUNT_DIR`.
- Fresh schema installs include `media_assets.created_by` ownership, the terminal import status `cancelled`, and `users.google_sub`; apply the current schema before running these flows. Existing databases need `ALTER TABLE users ADD COLUMN google_sub TEXT;` and `CREATE UNIQUE INDEX uq_users_google_sub ON users (google_sub) WHERE google_sub IS NOT NULL;`.
- AI routes stay under `/api/v1/ai/*`; the server calls agentscope in-process (no internal HTTP hop).
- TXT, DOCX, PDF, and XLSX preprocessing run locally. Set `DASHSCOPE_API_KEY` to enable AgentScope-backed parsing, answer generation, and learning reports (`AI_TEXT_MODEL`/`AI_VL_MODEL` override the default `qwen-max`/`qwen-vl-max`); without it AI routes return 503. Scanned PDF pages are rendered and OCR'd through the vision model, including figure detection with bounding-box crops.
- Membership tiers are managed with direct SQL updates (the admin back-office was removed); billing checkout and webhook routes are not active.

## Podman stack

The full local stack runs as Podman Quadlet units from `containers/quadlet/`:

```bash
podman build -f Containerfile.server -t localhost/practiq-server:latest .
cp containers/quadlet/* ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start practiq-postgres practiq-redis practiq-server practiq-worker
```

The server and worker units read optional secrets from `~/.config/practiq/practiq-stack.env`; create it with a random local `AUTH_SECRET` value (edit the same file to rotate local secrets). The `practiq-postgres` unit creates the isolated `practiq_app` database on first start, and you still need to run the schema/seed commands once per fresh database.

This manages four services:

- `practiq-postgres`
- `practiq-redis`
- `practiq-server`
- `practiq-worker`

## Environment variables

See `.env.example` for the full set. The most important groups are:

- Database/cache: `POSTGRES_URL`, `REDIS_URL`
- Host/origin: `PRACTIQ_HOST`, `PORT`, `APP_ORIGIN`
- Mobile build-time API endpoint: `EXPO_PUBLIC_API_URL` in `mobile/.env`
- Auth/session: required `AUTH_SECRET`, `SESSION_TTL_MS`, optional `SEED_ADMIN_PASSWORD` (password for the seeded `admin` user; defaults to the local dev value, set it on any shared environment)
- Registration email codes: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM`
- Google sign-in: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_MOBILE_CLIENT_IDS`; mobile builds also need `EXPO_PUBLIC_GOOGLE_CLIENT_ID` (plus optional Android/iOS client IDs) in `mobile/.env`. The OAuth redirect URI is `{APP_ORIGIN}/api/v1/auth/google/callback`.
- AI providers: `DASHSCOPE_API_KEY`, `AI_TEXT_MODEL`, `AI_VL_MODEL`, `AI_AGENT_*`, `AI_MAX_OCR_PAGES`, `AI_APPLY_MIN_CONFIDENCE`
- Object storage: `OBJECT_STORAGE_MOUNT_DIR`, `OSS_PUBLIC_BASE_URL`, `OSS_URL_PREFIX`

`AUTH_SECRET` is required in every environment and must be an unpredictable value. `SESSION_TTL_MS` controls both the signed session expiry and cookie expiry; it defaults to seven days when omitted. Session renewal is not implemented, so there is no renewal-window setting.

## Schema and architecture

- Product schema lives in `db/*/*.sql`
- The unified server lives in `server/` (API + AI + worker + admin CLI)
- The mobile client lives in `mobile/`; PostgreSQL remains authoritative.
- Product/API design notes live in `docs/system-design.md`
