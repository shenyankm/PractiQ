# Repository Guidelines

## Architecture

`web/` is the React 19 + Vite + strict TypeScript personal Web client. `backend/` is the Python FastAPI product API and worker: PostgreSQL CRUD, grading, imports, idempotency and AI task persistence. `server/src/practiq_ai/` is the private LangGraph AI service; it retains the sole document parser, extractors and generation workflows. `db/00_schema.sql` is the fresh single-user schema authority. `db/legacy/` is historical only and must never run against the personal database.

There is no user, login, membership, billing or study-group system. Do not reintroduce fixed user IDs or product authentication. Keep material-question groups distinct from removed study groups.

## Commands

- `make install`: install product Python dependencies into the existing interpreter and Web packages; no project `.venv`.
- `make backend-dev`, `make backend-worker`, `make server-dev`, `make web-dev`: run local processes.
- `make backend-test`: real disposable PostgreSQL integration tests (requires Docker, or explicitly set `TEST_DATABASE_URL`).
- `make test`: Web style policy, unit tests, TypeScript checking and production build.
- `make test-server`: existing AI tests without external model calls.
- `make verify`: all layers and schema boundary checks.

## Frontend constraints

Use HeroUI v3 for every available UI component and preserve its default appearance. Only standard Tailwind layout utilities are permitted: responsive breakpoints, display, arrangement, spacing, dimensions, position, overflow. No custom CSS/SCSS, CSS modules, inline `style`, CSS-in-JS, custom themes, CSS variable overrides, arbitrary values, or visual utility classes (color/type/border/radius/shadow/animation). The only stylesheet contains the two official imports. Run `npm --prefix web run styles`. Use native file/media elements only for capabilities not supplied by HeroUI. Never inject raw HTML from documents or model output.

## Backend and validation

Use strict Pydantic inputs, parameterized Psycopg SQL, explicit transactions, and focused modules. Do not add an ORM, generic repository framework or in-memory replacement for durable tasks. Preserve atomic idempotent writes, answer-version references, hidden exam feedback, task fencing, source checksums and per-call AI usage on success and failure. Model credentials remain server-side; the product service calls the private AI service with `AI_SERVICE_TOKEN`.

## Data and changes

Bind services to loopback. Initialize only a new personal database/volume; never reset an existing database or remove existing volumes. Preserve unrelated worktree changes. Update relevant docs and tests with behavior changes. Follow `CONTRIBUTING.md` for pull requests; do not commit `.env.local` or secrets.
