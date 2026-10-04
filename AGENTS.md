# Repository Guidelines

## Architecture

`server/src/practiq_ai/` is the sole Python 3.14+ LangGraph AI document import service. Keep its format extractors, shared parser graphs, structured contracts, local file storage and model usage accounting together. `webapp.py` exposes authenticated upload and artifact routes; The single-process open-source LangGraph runtime owns a SQLite task queue, checkpoints and Store; `/ok` and `/ready` are health checks. Do not restore official Agent Server APIs or Redis.

`web/` is the independent React/Vite import frontend served by the AI service. It handles explicit source upload, task progress, saved-result review and question-bank ZIP download through the existing authenticated task APIs. Keep service tokens in browser memory only; model provider configuration and credentials belong to the service environment. Do not add Tauri imports, online practice, product accounts or a second document parser.

`app/` is the independent offline Tauri 2 practice application (React/Vite/shadcn/ui/TypeScript, Rust, SQLite). It imports question-bank ZIP packages using the existing AI JSON contract. It contains no Python service, LibreOffice runtime or AI document-import UI. Explicit subjective AI grading calls the independently running service; offline practice needs no service. Supported app targets are macOS, Windows and Android. Use desktop layouts on macOS/Windows and touch layouts on Android. Keep SQLite and native file access behind typed Tauri commands. Preserve imported review flags and immutable practice snapshots. Images are immutable content-addressed files; SQLite stores their metadata. Write and verify images before committing database references. Backups include practice data and images, but exclude AI task state and credentials. App data uses `v4/` and SQLite schema 11; initialize only empty databases and reject older databases/backups without migration. Preserve old directories, task files and credential namespaces untouched. App service URLs persist in existing SQLite settings, while access tokens stay in macOS Keychain, Windows Credential Manager or Android Keystore-backed private storage and are excluded from backups. Only explicit grading or retry may start app model work.

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
- `make app-build`: build a native macOS package without publishing; use the README PowerShell commands on Windows. Android build and emulator commands are documented in `app/docs/android.md`.
- `make web-install` / `make web-dev`: install locked Web dependencies / start the loopback import frontend with a proxy to the independent service.
- `make web-check` / `make web-build`: check the Web frontend / build its static assets for the independent service.

## Module Conventions

### AI service (`server/`)

- Layout: `webapp.py` authenticated upload/artifact routes, `auth.py` shared Bearer authentication, `config.py` environment settings, `graphs/` workflows, `extractors/` format readers, `contracts.py` shared models, `runtime.py` graph registration, `database.py` SQLite task records, tests in `tests/`. Do not add another parser or restore product APIs.
- Style: four-space indentation, type annotations and small single-responsibility modules; `snake_case` functions/variables, `PascalCase` classes and Pydantic models, `UPPER_CASE` constants; keep public payload fields compatible with the existing camelCase API contracts; prefer async for I/O and reuse shared errors and models instead of duplicating validation. Run the configured Ruff checks and type-check with `pyrightconfig.json`.
- Tests: pytest with `pytest-asyncio` in automatic mode, named `test_<behavior>` with fixtures or fakes close to each scenario and shared fakes in `tests/support.py`, not other test modules. Runtime tests explicitly request the `disposable_databases` fixture; pure tests must not start Docker. Cover success paths, validation failures, resumability and storage/checksum boundaries; never call real LLM services (monkeypatch them as existing tests do). Service CI exercises PDFium and the deployed Office adapter; desktop CI verifies that final packages contain no Python or LibreOffice runtime. Keep the 90% coverage threshold and add a focused regression test for every behavior change.

### Import Web frontend (`web/`)

- Derive shared types from `server/src/practiq_ai/contracts.py` using the existing exporter. Do not hand-maintain duplicate API schemas.
- Use authenticated same-origin fetches, bounded files and verified binary artifacts. Never render raw document/model HTML, accept arbitrary download URLs or persist the token in URLs, browser storage or logs.
- File selection, GET polling and ZIP export are passive. Start import, resume, retry and parse again are explicit actions. Preserve failed/unknown outcomes and request IDs; do not automatically replay uncertain mutations.
- Reuse the octopus brand, Lucide icons and standard accessible desktop layouts. Test upload/result/control behavior with model substitutes.

### Practice app (`app/`)

- Validate all native command inputs. File access begins with a native file picker; imported content cannot request arbitrary SQL, file access or network access.
- Preserve nulls, quality warnings, source associations and practice snapshots. Unreviewed content may be practised; incomplete/unavailable answers must not become automatically incorrect.
- Keep databases out of the repository. Use temporary directories in integration tests, including resource import and restore tests.
- Use the existing octopus brand asset, Lucide (`lucide-react`) for functional icons, existing shadcn components and standard CSS layout. Android uses accessible narrow-screen navigation, dynamic viewport dialogs and 48px touch targets; preserve desktop interactions.
- Android file access uses the native system picker and bounded private snapshots or selected output descriptors. Only Rust may invoke the private credential/file-descriptor bridge; reject frontend calls to it. Keep tokens in Keystore-backed storage outside automatic system backups. Android Back must preserve unsaved-edit confirmation and practice draft persistence.
- Keep Android Gradle/Kotlin host sources, wrapper provenance and locked dependencies tracked; exclude build outputs, local SDK paths, emulator data and signing keys. Linux app targets and scaffolding are removed; Linux remains a supported AI-service/CI host.

## Boundaries

Preserve strict Pydantic inputs, token authentication, bounded uploads, path and checksum validation, partial-result details, checkpoint resumability and per-call usage on success and failure. Never inject raw document/model HTML. Do not add another source-document parser or a product compatibility layer. The desktop JSON importer must follow the existing AI contracts.

Bind services to loopback. Keep model provider credentials server-side and never commit environment secrets. Preserve existing files, database volumes and unrelated worktree changes. Use local file storage; preserve reference and checksum validation. Do not restore cloud object-storage backends. Local AI storage resolves relative to `server/`; production must use a persistent absolute path.

Update relevant documentation and focused tests with behavior changes. Follow `CONTRIBUTING.md` for issues and pull requests. Issues must use the applicable template in `.github/ISSUE_TEMPLATE/`; pull requests must use `.github/PULL_REQUEST_TEMPLATE.md`. This applies to submissions through the GitHub UI, CLI, or API. Preserve template fields and sections, explain non-applicable items, and mark checklist items complete only when verified.

The service accepts PDF, TXT, CSV and PNG/JPEG images, plus Word (.doc/.docx) and Excel (.xls/.xlsx) when its deployment configures LibreOffice. The service normalizes Office inside the existing parser prepare stage, using PDF by default or Word TXT / ordered sheet CSVs in text mode, including hidden sheets. Reuse the isolated `office` worker and existing format extractors; do not add parser graphs, python-docx, openpyxl or UNO. Executable/version configuration comes only from trusted service environment, never HTTP or desktop preferences. Preserve original source hashes, derived manifest checksums, deterministic manifest order, engine identity, process cleanup and shared limits across conversion and parsing. The explicit Web Start import action authorizes normalization and AI submission without a second confirmation dialog; merely selecting a file must not submit it to a model. Retain upstream licenses and source links in the independent deployment. Desktop packages must not include or discover Python/LibreOffice installations. Do not store executable preferences in SQLite; reject backups containing them. Offline question-bank ZIP import is under Settings > Restore backup alongside full study-data restoration; bank import appends content, while full restoration requires replacement confirmation.

Subjective grading is allowed only after an explicit user grading or retry action. Parsing still extracts supplied answers, scores and rubrics without solving questions. Grading requires a reference answer or explicit rubric; missing evidence remains ungraded. Reuse the independent AI service and model-call safeguards; keep exam answers, score snapshots and manual overrides local and preserve them in backups. Legacy provider settings and keys must not be interpreted as a service URL/token or deleted during this change.

## Commit Conventions

Use Conventional Commits: `<type>(<scope>): <summary>`. Allowed types are `feat`, `fix`, `docs`, `refactor`, `test`, and `chore`. Use an optional module name for `scope`, an imperative summary of at most 72 characters, and no trailing period. Example: `fix(extractors): enforce PDF page limit`. Keep each commit scoped to one concern.
