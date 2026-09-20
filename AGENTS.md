# Repository Guidelines

## Architecture

`server/src/practiq_ai/` is the sole Python 3.14+ LangGraph AI document import service. Keep its format extractors, shared parser graphs, structured contracts, local/OSS file storage and model usage accounting together. `webapp.py` exposes authenticated upload and artifact routes; The single-process open-source LangGraph runtime owns a SQLite task queue, checkpoints and Store; `/ok` and `/ready` are health checks. Do not restore official Agent Server APIs or Redis.

`app/` is the independent offline Tauri 2 desktop practice application (React/Vite/shadcn/ui/TypeScript, Rust, SQLite). It imports AI JSON and can explicitly start the bundled Python service to parse source documents. Offline practice does not require the service. macOS is the initial validated target; only desktop layouts are in scope. Keep SQLite and native file access behind typed Tauri commands. Preserve imported review flags and immutable practice snapshots. Images are immutable content-addressed files; SQLite stores their metadata. Write and verify images before committing database references. Backups include practice data and images, but exclude AI task state and credentials. Desktop connection settings persist in SQLite, while API keys stay in macOS Keychain and are excluded from backups; model calls require an explicit parsing, grading or resume/retry action; desktop storage is local.

There is no product HTTP backend, login, billing, answer generation or learning report. Material-question groups are document content, not study groups. Do not restore removed product compatibility APIs.

## Commands

- Use an existing Python 3.14+ interpreter; no project `.venv`. Set `AI_PYTHON` when needed.
- `make install`: install AI and development dependencies into that interpreter.
- `make server-dev`: run Uvicorn on loopback with local SQLite, loading `.env`.
- `make test` / `make test-server`: AI tests without external model calls.
- `make install-locked`: install locked runtime/development dependencies into the selected interpreter without a project `.venv`.
- `make verify`: lockfile consistency, Ruff, Pyright, evaluation fixtures, one test run with 90% coverage, recovery probes and package build. Reports go to `server/reports/checks/`, including on test failure.
- `make audit` / `make image-check`: audit locked dependencies (network required) / build the Docker image without publishing.

- `make app-install` / `make app-dev`: install locked desktop dependencies / start the Tauri desktop application.
- `make app-check AI_PYTHON=...`: check shared AI contracts, frontend interactions, Rust integration tests and Clippy.
- `make app-build`: build the macOS `.app` without publishing.

## Boundaries

Preserve strict Pydantic inputs, token authentication, bounded uploads, path and checksum validation, partial-result details, checkpoint resumability and per-call usage on success and failure. Never inject raw document/model HTML. Do not add another source-document parser or a product compatibility layer. The desktop JSON importer must follow the existing AI contracts.

Bind services to loopback. Keep credentials server-side and never commit environment secrets. Preserve existing files, database volumes and unrelated worktree changes. Select local (default) or OSS with `AI_STORAGE_BACKEND`; preserve shared reference and checksum validation. Local AI storage resolves relative to `server/`; production must use a persistent absolute path.

Update relevant documentation and focused tests with behavior changes. Follow `CONTRIBUTING.md` for pull requests.

Source-document import supports PDF, TXT, CSV and PNG/JPEG images. Word is unsupported; direct users to export PDF. Do not restore Word parsers or LibreOffice dependencies. The desktop sidebar has one unified import page for offline JSON import and AI parsing/task management.

Subjective grading is allowed only after an explicit user grading or retry action. Parsing still extracts supplied answers, scores and rubrics without solving questions. Grading requires a reference answer or explicit rubric; missing evidence remains ungraded. Reuse the bundled AI service and model call safeguards; keep exam answers, score snapshots and manual overrides local and preserve them in backups.
