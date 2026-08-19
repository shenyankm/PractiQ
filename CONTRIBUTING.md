# Contributing to PractiQ

Thanks for contributing to PractiQ. This guide explains the project boundaries, local setup, validation commands, and pull request requirements.

## Before you start

Read these files before changing code:

- [`AGENTS.md`](./AGENTS.md) for repository rules and service boundaries
- [`README.md`](./README.md) for local setup
- [`docs/PRD.md`](./docs/PRD.md) for product behavior
- [`docs/weapp-migration.md`](./docs/weapp-migration.md) for the Mini Program migration order
- [`docs/system-design.md`](./docs/system-design.md) for the private AI service contract

Open an issue before starting a feature, architecture change, new dependency, or cross-service change. Small bug fixes and documentation corrections can go directly to a pull request when the scope is clear.

Keep each pull request focused on one concern. Use a draft pull request when you need early feedback.

## Understand the architecture

PractiQ has three application boundaries and one schema authority:

| Path | Responsibility |
| --- | --- |
| `backend/` | Public Java product API, authentication, billing, product rules, persistence, retries, and API contracts |
| `server/` | Private FastAPI service for document parsing and AI generation |
| `weapp/` | WeChat Mini Program |
| `db/` | PostgreSQL schema authority |

Preserve these boundaries:

- Keep product authentication, authorization, billing, imports, and persistence in `backend/`
- Keep `server/` stateless and AI-only
- Do not send user, bank, question, session, or import resource IDs to the AI service
- Keep semantic keys such as `questionTypeId` when the AI workflow needs classification context
- Keep WeChat-specific APIs at backend integration boundaries
- Do not expose the private AI service to public traffic

Reuse existing code and installed dependencies before adding an abstraction or package. Add dependencies only when the pull request demonstrates a concrete need.

## Set up the repository

### Prerequisites

Install the tools required by the area you plan to change:

- Git
- Java 21 and Maven
- Python 3.14 and [`uv`](https://docs.astral.sh/uv/)
- Node.js 24.18.0 or later and npm 11.16.0
- Docker with Docker Compose
- WeChat Developer Tools for Mini Program behavior

### Install dependencies

Clone your fork and configure the local environment:

```bash
git clone https://github.com/your_username_here/PractiQ.git
cd PractiQ
cp .env.example .env.local
uv sync --project server --extra dev
```

Set only the variables required by the component you run:

- Set `AUTH_SECRET` for the Java API
- Set `AI_SERVICE_TOKEN`, `LLM_PROVIDER`, `LLM_API_KEY`, and `LLM_TEXT_MODEL` for the AI service
- Set `WEAPP_API_URL` for the Mini Program API target

Never commit `.env.local`, credentials, tokens, private keys, or production data.

Start PostgreSQL and Redis:

```bash
docker compose up -d postgres redis
```

Docker Compose does not apply the SQL files under `db/`. Confirm the expected schema setup before testing database-backed changes.

## Run each application

Run the component you are changing from the repository root.

### Java product API

```bash
make backend-dev
```

### Private AI service

```bash
make server-dev
```

### WeChat Mini Program

Open `weapp/` in WeChat Developer Tools for platform testing. Do not commit generated output from `backend/target/`.

## Follow coding conventions

### Java product API

- Follow Java 21 and Spring conventions
- Keep HTTP validation in controllers and product behavior in the Java service layer
- Preserve the standard success and error envelopes
- Enforce authorization before reading or changing product resources
- Add focused tests for authentication, money, permissions, retries, and transaction behavior

### Python AI service

- Use strict Pydantic request and response models
- Keep HTTP mapping in `server/routes/`
- Keep orchestration in `server/services/ai.py`
- Keep workflows in `server/agents/`
- Keep document handling in `server/extractors/`
- Do not add product persistence or Java business rules

### WeChat Mini Program

- Use plain CSS
- Follow [`docs/visual-style-guide.md`](./docs/visual-style-guide.md)
- Keep platform APIs behind the smallest practical boundary
- Include loading, empty, error, expired-session, and offline states where applicable
- Test WeChat authorization, storage, upload, and payment behavior in WeChat Developer Tools or on a real device

### PostgreSQL

- Treat `db/` as the schema authority
- Place SQL in the owning domain directory and follow the existing numeric naming pattern
- Add constraints and indexes for correctness and observed access paths
- State whether a change targets a fresh database, an existing database, or both
- Include safe migration and rollback notes when existing data can be affected
- Do not assume Docker Compose runs migrations

The repository does not yet include a production migration runner. Do not introduce Flyway, Liquibase, or another migration framework without an approved issue.

## Validate your change

Run the checks for every area you changed:

| Changed area | Required command |
| --- | --- |
| `backend/` | `make backend-test` |
| `server/` | `make test-server` |
| `weapp/` | `make test` |
| Multiple application layers | `make verify` |

`make test` validates only the WeChat Mini Program. Use `make verify` for cross-layer changes.

Add the smallest test that fails before your fix and passes after it. For database changes, also exercise the affected query or workflow against PostgreSQL.

## Update documentation

Update documentation in the same pull request when you change:

- API behavior or response contracts
- Environment variables
- Database schema or rollout requirements
- User-visible Mini Program behavior
- AI service boundaries or supported providers
- Setup, build, or test commands

Keep `docs/PRD.md` and `docs/weapp-migration.md` aligned with implemented product status. Do not mark a feature complete until its end-to-end flow and error states are testable.

## Write commits

Use focused [Conventional Commit](https://www.conventionalcommits.org/) subjects:

```text
feat(backend): add WeChat login exchange
fix(server): reject oversized image payloads
docs: clarify database setup
refactor(weapp): isolate API request handling
```

Avoid mixing formatting, refactoring, generated files, and product behavior in one commit.

## Open a pull request

Your pull request description should include:

- The problem and why it needs a change
- The chosen approach and important tradeoffs
- The affected application boundaries
- Commands you ran and their results
- Schema, configuration, security, or deployment impact
- Screenshots or a short recording for Mini Program changes
- The linked issue, using `Fixes #123` when appropriate

Before requesting review, confirm:

- [ ] The pull request addresses one concern
- [ ] The diff contains no unrelated or generated files
- [ ] Required tests pass
- [ ] Cross-layer changes pass `make verify`
- [ ] New behavior has focused test coverage
- [ ] Documentation and `.env.example` reflect configuration changes
- [ ] Database changes include rollout notes
- [ ] Mini Program changes include visual or device evidence
- [ ] Logs, fixtures, screenshots, and commits contain no secrets or personal data
- [ ] Production traffic still uses HTTPS
- [ ] The AI service remains private and stateless

All changes require review before merge.

## Report security issues

Do not publish credentials, personal data, or working exploit details in a public issue. Use GitHub private vulnerability reporting when available, or contact a maintainer privately before disclosure.
