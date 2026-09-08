# PractiQ

PractiQ is a question-bank and smart-practice platform: teachers build question banks and import questions manually or via AI; students practice or take exams and get learning analytics. The frontend is a WeChat Mini Program; the backend splits product and AI responsibilities.

## Repository layout

- `backend/` — Java product API: users, authorization, billing, question banks, import orchestration, persistence, retries, and audit records.
- `server/` — Private LangGraph Agent Server: OSS-backed document parsing plus the existing answer/learning-report operations. It accepts no user, bank, question, session, or import resource IDs and persists no product data; `questionTypeId` remains a semantic parsing classification key.
- `taro/` — Taro 4 + React 18 + TypeScript + Vite frontend, targeting only the WeChat Mini Program.

## AI service contract

The Java product API still calls `/api/v1/ai/{parse-document,generate-answer,learning-report}` with `Authorization: Bearer $AI_SERVICE_TOKEN`. Java owns import queues, product persistence, billing, retries and authorization. Integration DTOs and the small inline-to-OSS facade live in `server/src/practiq_ai/product/`; the **only document parser** is `practiq_ai.graphs.document`.

The same service exposes five native graph IDs, `POST /api/uploads` (managed OSS reference / signed PUT), and private `POST /api/artifacts/read` (verified download). Native results retain `confidenceScore`, `status`, `processing` and `usage`; the Java facade maps answer keys and `qualityScore`, retains partial metadata and inline image previews, and reports model usage even on failure. See [server README](server/README.md) and [migration contract](server/docs/migration.md).

DashScope, DeepSeek and existing Moonshot configuration are supported; choose vision-capable models for scanned documents. Java product imports accept TXT, DOCX, PDF and XLSX; native graphs additionally accept CSV and images. Text can contain Markdown. `/ok` is the public Agent Server probe and `/api/health/live` retains its public Java liveness envelope; AI APIs must remain private.

## Java runtime

The product API uses Java 21, Spring Boot 4.1.1 and MyBatis-Plus 3.5.17 (Boot 4 starter). Jackson 3 handles application JSON; `spring.jackson.use-jackson2-defaults` preserves existing wire/storage defaults alongside strict unknown-field rejection and null omission. The Jackson migration itself needs no Jackson 2 compatibility module or database migration; the separate P1 security schema upgrade is described below.

After dependency upgrades, run `mvn -f backend/pom.xml clean test package`, `make schema-check`, and `make api-schema-smoke`. The latter creates and removes its own PostgreSQL container and runs the conditional persistence tests; ordinary `make backend-test` skips them without `POSTGRES_URL`. Only point these tests at disposable databases. `BootJsonContractTest` verifies the application context, real MVC/filter JSON behavior, existing signed token claims and authentication before idempotent writes; `InternalAiMigrationTest` checks real AI HTTP serialization and success/failure usage. `P1HttpSchemaTest` checks current content permissions, answer hiding, and durable write replay against the disposable schema.

Before deployment, validate the packaged JAR's `/api/health/ready` against isolated PostgreSQL and Redis, then run staging login/payment/import flows with the real integrations. Preserve the previous image for rollback. The P1 security changes add an owner management-read route and Java-side AI-result provenance schema; see [P1 backend contracts and client handoff](docs/P1-backend-contract.md) before deployment. Existing databases use the non-destructive [ordered migration instructions](db/migrations/README.md), not schema reinitialization. The Mini Program now uses owner management reads, online visibility checks, account-scoped retry attempts and cache cleanup; see [P1 frontend security and platform limitations](docs/P1-frontend-security.md).

## Local setup

```bash
test -f .env.local || cp .env.example .env.local
test -f server/.env || cp server/.env.example server/.env
# Set AUTH_SECRET, WECHAT_APP_ID, WECHAT_APP_SECRET, AI_SERVICE_TOKEN, LLM_PROVIDER, LLM_API_KEY, and LLM_TEXT_MODEL.
# To accept payments also set WECHAT_MCH_ID, WECHAT_MERCHANT_SERIAL_NUMBER, WECHAT_MERCHANT_PRIVATE_KEY_PATH, WECHAT_API_V3_KEY, WECHAT_PAYMENT_NOTIFY_URL, and WECHAT_REFUND_NOTIFY_URL.
# Set SECURE_COOKIES=false only for local HTTP cookie testing.
source /home/sheny/miniconda3/etc/profile.d/conda.sh
# Only on a new machine, if this environment does not exist:
# conda create -n langgragh python=3.14 -y
conda activate langgragh  # Reuse the existing environment; no project .venv
make server-install
npm --prefix taro ci
docker compose up -d --wait postgres redis # single PostgreSQL instance + Redis
# Set server/.env OSS/model settings and the same AI_SERVICE_TOKEN as .env.local.
make backend-dev          # Java API
make server-dev           # local native + Java AI APIs, 127.0.0.1:8090
make taro-dev             # watch-build the WeChat client into taro/dist/
```

`make server-dev` uses the existing Conda interpreter and `server/langgraph.json`; the editable install points inside this repository. Keep Java `AI_SERVICE_URL=http://127.0.0.1:8090`. Root `.env.local` is loaded before the Agent Server's `server/.env`; keep shared token/model settings consistent. Neither file is committed or included in Docker images.

Compose contains only PostgreSQL (`127.0.0.1:54322`, database `practiq_app`) and Redis (`127.0.0.1:6379`), with persistent volumes. AI runs on the host in Conda, not Docker. `langgraph dev` requires no production license and does not use `DATABASE_URI`/`REDIS_URI` for production PostgreSQL-backed persistence; do not assume durable task/checkpoint recovery. No separate AI PostgreSQL instance is needed for this development mode. Existing containers/volumes from older setups are not removed or migrated automatically. The standalone production reference remains in `server/docs/operations.md`; it is not the local startup path. Keep the AI port private.

### WeChat Mini Program

Set `TARO_APP_ID` and `TARO_APP_API_URL` in `.env.local`. Development may use the local HTTP API URL from `.env.example`; production builds fail unless `TARO_APP_API_URL` uses HTTPS. Build and import the generated directory directly in WeChat DevTools:

```bash
npm --prefix taro run build:weapp
# Import taro/dist/ in WeChat DevTools.
```

The current client implements explicit WeChat login, the learning snapshot, and read-only mine/favorites bank lists. Access and refresh tokens live only in memory, so a cold start returns to the login page. Real login requires matching `WECHAT_APP_ID`/`WECHAT_APP_SECRET` on the Java API and a valid Mini Program AppID; `touristappid` remains suitable for build and layout validation only. See [`taro/README.md`](./taro/README.md) for page behavior, validation commands, and the recorded upstream dependency audit.

### First administrator bootstrap

After the trusted WeChat identity has logged in once, run this once from the server (never through HTTP):

```bash
java -jar backend/target/practiq-backend-0.2.0.jar --spring.main.web-application-type=none --practiq.bootstrap-first-admin-openid='trusted-openid'
```

The command refuses inactive or unknown identities and refuses to run after an admin exists. Set `WECHAT_APP_ID`, `WECHAT_APP_SECRET`, and `SECURE_COOKIES=false` only for local HTTP cookie testing; production cookies must remain secure.

## Testing

```bash
make test           # Taro tests, typecheck, and WeChat build
make backend-test   # Java API
make test-server    # Python AI service
make schema-check   # PostgreSQL 16 schema and critical constraints
make api-schema-smoke # Java/API checks against a disposable PostgreSQL schema
make verify         # everything
```
