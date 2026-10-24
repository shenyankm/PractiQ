# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read first

`AGENTS.md` is the authoritative repository guideline and is already loaded into context. Keep it in sync with changes to boundaries, workflows, or data formats; do not restate it here. This file adds the operational detail that is easy to get wrong: exact commands, single-test invocations, and the cross-file mental model.

## Commands

The service, contract generation, and app package preparation need an existing Python **3.14+** interpreter. Do not create a project `.venv`; select the interpreter with `AI_PYTHON` (for example `AI_PYTHON=$(uv python find 3.14)`). Python 3.13 cannot even import several modules because they rely on PEP 649 deferred annotations.

```sh
# service (from repo root; needs .env for dev)
make install-locked AI_PYTHON=…     # locked runtime + dev deps
make server-dev AI_PYTHON=…         # uvicorn on loopback, PostgreSQL + RabbitMQ
make test / make test-server        # entire pytest suite
make verify                         # lockfile, ruff, pyright, eval fixtures, coverage ≥90%, recovery probes, build
make upgrade-db AI_PYTHON=…         # offline schema 1–4 → 5

# run one service test (pytest-asyncio auto mode, pythonpath=src)
cd server && PYTHONPATH=src "$AI_PYTHON" -m pytest tests/test_chunking.py -q
cd server && PYTHONPATH=src "$AI_PYTHON" -m pytest tests/test_chunking.py::test_name -q

# web frontend
make web-install / make web-dev / make web-check / make web-build
cd web && npx vitest run src/api.test.ts        # one unit test file

# practice app
make app-install / make app-dev / make app-check / make app-build
cd app && npx vitest run src/paper.test.ts      # one frontend test file
cd app/src-tauri && cargo test <name>           # one Rust test
cd app && npm run check:ui                      # tsc + lint + vitest coverage (no Rust)
cd app && npm run test:browser                  # Playwright (install chromium first, see README)

# cross-component
make test-e2e
```

Notes:

- `make test` starts disposable PostgreSQL (16) and RabbitMQ containers for tests that request `disposable_databases`/broker fixtures. Pure tests must not start Docker. Set `TEST_DATABASE_URI` and `TEST_RABBITMQ_URI` + `TEST_RABBITMQ_MANAGEMENT_URL` to reuse external instances.
- `make verify` does not cover Web, app, dependency audits, or the image. Run `make web-check web-build`, `make app-check`, `make audit` / `make audit-rust`, or `make image-check` for those. Reports go to `server/reports/checks/`, including on failure.
- `make app-check` verifies generated contracts, fixtures, TS types/lint/tests, Rust fmt/tests/clippy; it does not run Playwright or collect frontend coverage.
- The practice app supports macOS only; Linux remains a service/CI host.
- Server tests must never call real model or Tencent services; reuse the fakes in `server/tests/support.py`.

## Architecture (the parts that span files)

Three independently built components share one contract:

| Component | Role |
| --- | --- |
| `server/` | Python 3.14 + LangGraph document-import and grading service |
| `web/` | React/Vite import frontend served by the service |
| `app/` | Offline Tauri 2 practice app (React + Rust + SQLite), macOS |
| `shared/` | TypeScript UI used by both Web and App |

**Service request flow.** `webapp.py` exposes Bearer-authenticated routes; `task_api.py` commits a task, run, outbox row, and replay receipt in one PostgreSQL transaction (`requestId` + fingerprint identity). `runtime.py` publishes outbox rows to RabbitMQ and consumes deliveries; it executes the LangGraph graph with `durability='sync'`, one active run per thread, and enforces run deadlines and model-call budgets through the PostgreSQL Store. Resume replays checkpoints with `Command`; an uncertain paid submission is never replayed automatically (`TENCENT_SUBMISSION_UNKNOWN`, `MODEL_RESULT_UNKNOWN`). Visible state and allowed actions are derived in `task_api._task_state` from the latest checkpoint plus run flags.

**Graph pipeline.** `graphs/document.py` runs `_prepare` (verify source hash, split oversized inputs via `tencent_inputs.py`, submit/poll Tencent through `tencent.py`, or normalize Office through `office.py`/`office_service.py`, decode bundles with `tencent_bundle.py`) → per-unit vision or chunk model calls → `_merge` (in `graphs/chunking.py`, including `finalize_question_ids` and duplicate detection) → status/result assembly. `bank_export.py` packages a completed checkpoint as the desktop bank ZIP. Parsing extracts supplied answers/rubrics but never solves questions; partial results keep review flags and resumability.

**Storage.** `storage.py` is a local, content-addressed object store (`practiq-agent/sources/…`, `practiq-agent/artifacts/<source-sha>/<kind>/<index>-<sha>.<ext>`): every read re-verifies size and SHA-256, writes are atomic, and keys are path/symlink validated. PostgreSQL owns task/run/receipt rows, LangGraph checkpoints/Store, and grading receipts; relative `AI_STORAGE_DIR` resolves under `server/` and wheel installs require an absolute path.

**Contracts are generated, never hand-written.** `server/src/practiq_ai/contracts.py` is the single source. `app/scripts/export-contracts.py` writes `app/src-tauri/contracts.json`, `app/src-tauri/src/question_metadata.rs`, `app/src/contracts.generated.ts`, and `web/src/contracts.generated.ts`; `--check` (run by `make app-check`) enforces parity. Regenerate and commit all four when API shapes change.

**Practice app.** TypeScript calls typed commands (`app/src/api.ts` → `request` / `ai_request` / `read_asset` in `app/src-tauri/src/lib.rs`), and Rust owns all SQLite/file/keychain work behind a single store mutex. Relevant modules: `store.rs` (schema 11, `v4/` data dir, asset GC), `questions.rs` (freeze/thaw, snapshots, trees), `exams.rs`/`sessions.rs` (papers, scoring, grading receipts), `bank_zip.rs` (service-compatible bank ZIPs), `backup.rs` (versioned full backups/restore), `settings.rs` (grading connection + versioned `v4/service-settings-v1.sqlite` sidecar), `ai.rs`/`model_grading.rs` (one bounded direct Chat Completions call per explicit action), `credentials.rs`. The bank ZIP contract is shared with the service: `server/src/practiq_ai/bank_export.py` and `app/src-tauri/src/bank_zip.rs` must stay mutually compatible (round-trip tests exist on both sides).

**Key invariants** (details in `AGENTS.md`): one personal Bearer token, no accounts/billing; passive reads, polling, export, and backup never call a model; paid work starts only from explicit user actions; app data directories (`v4/`) and schema 11 are fixed and older data is rejected rather than migrated; credentials stay in the OS credential store and out of SQLite/logs/backups; app packages contain no Python or LibreOffice.

## Docs map

Use `docs/README.md` as the index. Most useful entry points: `docs/guides/installation.md`, `docs/guides/import-tasks.md`, `docs/guides/question-bank-package.md`, `server/docs/document-tasks.md`, `server/docs/personal-use.md`, `server/docs/rabbitmq.md`, `server/docs/operations.md`, `app/docs/development-preview.md`.

## Git and GitHub

Conventional Commits `<type>(<scope>): <summary>` (types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`; imperative, ≤72 chars, no period). Issues must use the form in `.github/ISSUE_TEMPLATE/`; pull requests must use `.github/PULL_REQUEST_TEMPLATE.md` and complete their sections. See `CONTRIBUTING.md` for validation-to-change tables and label rules.
