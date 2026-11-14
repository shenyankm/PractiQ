# Repository Guidelines

## Architecture

PractiQ is one macOS Electron application using TypeScript/Node, React/Vite,
shadcn/ui, LangGraph.js (`@langchain/langgraph`), SQLite and local files. AI runs
in embedded background workers owned by the App. LangGraph orchestration,
checkpoints and Store all use the JavaScript implementation. The renderer is
sandboxed; SQLite, credentials, networking and native file access stay behind
narrow validated typed IPC. See [the migration ledger](docs/maintainers/electron-migration.md)
and issue #549 for parity evidence and unfinished acceptance.

- `app/desktop/`: Electron main/preload, database and AI workers, document graphs,
  provider transports, practice storage, restoration and package resources.
- `app/src/`: React renderer; `api.ts`/`transport.ts` consume the typed preload bridge.
- `shared/cloud/`: the document-import workspace embedded in the App, with an
  explicit browser harness for tests. There is no independently hosted frontend.
- `shared/ai-contracts.json`: authoritative wire/model schemas and classifications.
  `app/scripts/export-contracts.ts` derives TypeScript types. Frozen wire/model,
  grading and native IPC fixtures preserve the historical behavior; do not
  regenerate baselines to conceal incompatibility.
- `app/scripts/`: TypeScript packaging, source-bound release verification and
  native acceptance tools. Local builds and reports stay under ignored `.build/`.

Rust/Tauri and Python service sources/build tools are retired. Never forward
an unported operation to an old runtime or return synthetic success. Do not
restore PostgreSQL, RabbitMQ, Agent Server, Redis, Python/LibreOffice discovery,
another recognition fallback or an independent service dependency. Historical
deployment files, reports and fixture provenance remain references in `server/`
and Git history, not current startup instructions.

The product is an open-source single-person application. Do not add accounts,
administration, sessions for authentication, phone registration, plans, points,
payments, billing or cloud sync. Material-question groups are document content.
The current App targets macOS on Apple Silicon; use accessible desktop layouts,
the existing octopus brand, Lucide icons and existing shadcn components.

## Commands

- `make install` / `make install-locked` / `make app-install`: install locked npm
  dependencies and explicitly install the locked Electron binary.
- `make dev` / `make app-dev`: start Electron and embedded workers.
- `make test`: frontend and embedded-runtime tests with coverage, without real
  provider calls.
- `make verify` / `make app-check`: Node CI guards, shared contracts, maintainer,
  frontend and worker types, lint, frontend/backend coverage, release-tool tests
  and production renderer build. Do not repeat full passing suites without a
  new change, failure or unresolved concern.
- `make audit`: audit the locked npm dependencies; network required.
- `make build` / `make app-build`: build a fresh macOS App/DMG without publishing.
  Set `APP_PACKAGE_DIRECTORY` to choose a fresh output directory.
- `make app-package-check`: build and independently install/verify that same DMG,
  including protected credentials and recovery flows.
- `make test-e2e`: browser and actual Electron flows with local provider substitutes.
- From `app/`, `npm run contracts:check`, `npm run desktop:build` and
  `npm run check:packaging` provide focused checks. Helpers run compiled code;
  serialize SDK rebuilds and native/backend checks that consume `.build/electron/`.

Only Node/npm and the supported macOS system tools are needed. No project Python
environment, Cargo toolchain, database/broker service or Docker is used by current
commands or CI. Pure/frontend checks must not start unrelated native services.

## Practice data and recovery

Practice data remains in `v4/` with SQLite schema 11. Initialize only empty
databases; reject unknown/older schemas and backups without implicit migration.
Portable bank ZIPs remain version 2; full backups remain version 4/schema 11.
Bank import appends content under **Settings → Import and restore**; complete
restoration requires explicit replacement confirmation. Imported review flags,
nulls, warnings, source associations and immutable practice/score snapshots must
survive edits, copies, exports and restoration. Incomplete or unavailable answers
must not become automatically incorrect. Write and verify immutable content-
addressed resource files before committing database references.

Production uses `v4/` under Electron's user-data directory. Earlier Tauri and
`electron-migration/v4/` prototype profiles remain untouched; transfer compatible
practice data only through explicit backup restoration, never silent adoption.

Backups contain practice data, referenced resources, optional strictly validated
version-1 legacy connection settings and learning notes. They exclude current
credentials and AI task state. Historical `v4/service-settings-v1.sqlite`,
`v4/import-service-v1.json`, legacy provider columns and grading receipts are
compatibility evidence only; never reinterpret them as current credentials or
targets. Never replace unknown nonempty sidecars. Only a version-0 sidecar with
no SQLite objects is treated as absent on reads and initialized on explicit writes.

A durable pending restore record resolves before startup permits database writes.
Failed publication/rollback blocks current operations until explicit recovery or
restart recovery finishes. Preserve the original recovery copy, database/settings/
notes consistency and generation fences against late replies. Resource collection
must include immutable history, so deleting a source question cannot remove its
historical media. Temporary integration-test profiles must never use real data.

Preserve old directories, task files, Python checkpoints, Keychain namespaces,
environment files, deployment volumes, historical account/payment tables and
customer-owned data. Do not adopt or clean them through this migration. Python
checkpoint serialization is not loaded as JavaScript state. Never `git clean`
or remove whole historical directories to delete tracked source; retain their
ignore files and unrelated ignored contents. Databases, credentials, uploads,
packages, reports and local caches stay out of Git.

## Embedded AI and explicit actions

Current provider credentials use macOS-protected encrypted local storage, outside
SQLite, URLs, browser storage, logs and learning backups. Leave old Keychain/env
values untouched. Validate settings, endpoint/model changes and every native
command input. File access begins with a native file picker; imported content
cannot choose arbitrary SQL, paths, executables or network destinations. Artifact
reads require a valid task and a verified reference owned by that task. Do not
render raw document/model HTML or accept arbitrary artifact download URLs.

Selecting files, reading/polling, export, backup and migration are passive. Only
explicit Start import, resume, retry, parse again or grading actions authorize
their provider work. Preserve idempotent request IDs, atomic admission, run and
checkpoint fences, durable paid-call intents/receipts and unknown outcomes.
Never automatically replay uncertain submissions or model calls. Explicit retry
may incur charges. Preserve successful-unit reuse, partial results/exports,
per-call usage on success/failure/uncertainty and cumulative task/day budgets.
Keep bounded concurrency, queued cancellation, time/memory/output limits,
worker termination/draining, shutdown recovery and execution fingerprints.

Every new supported import uses Tencent SubmitMultimodalDocParseJob /
DescribeMultimodalDocParseJob before structuring. Supported formats are PDF, TXT,
Markdown, PNG/JPEG, DOC/DOCX, PPT/PPTX and XLS/XLSX; reject new CSV while retaining
saved records/banks. Verify immutable source hashes and durable submission intents
before paid work. Local files remain authoritative storage. Tencent input limits
are at most 150 MiB; local Base64 also has an 8 MiB cap. Private COS is explicit
advanced opt-in: stage every source privately and use signed FileUrl without
automatic transport fallback. Never persist signed URLs; retain local source/
result references, checksums, upload intents and safe validated-result cleanup.

TXT/Markdown use output type 2; layout/resource inputs use 9 for coordinates and
XML associations. Split oversized text at UTF-8 boundaries, PDF into rendered
pages and images into lossless tiles before the first submission. Oversized
Office must first be exported as PDF by the user; no LibreOffice conversion or
executable preference is supported. Preserve hidden-sheet/slide visibility,
ordered split receipts, source byte/pixel ranges, original pages, manifest
checksums, engine identity and shared preparation capacity/cleanup limits.
Only exact Tencent/original text equality permits original-text presence and
deduplication proofs; differing evidence remains reviewable OCR. Models may
associate fixed figure IDs but cannot invent or alter coordinates.

Parsing extracts supplied answers, scores and rubrics without solving questions.
`generateAnswers` defaults false; enabling it plus explicit Start authorizes a
separate post-extraction node to fill missing answers/analysis. Preserve supplied
or partially supplied fields, source proofs and references. Generated content is
marked for review and shares durable receipts and task budgets. Passive reads/
export must not generate answers.

Subjective grading needs an explicit grading/regrading action and a reference
answer or rubric; absent evidence stays ungraded. Direct grading makes one
bounded model call without automatic retries. Persist unknown-result intent
before sending, bind endpoint/model/prompt version and immutable scoring input,
and require explicit regrading after uncertainty or target changes. Preserve
historical receipts, score snapshots and manual/self-assessment priority. Validate
quotes, criteria, arithmetic, limits and response shape before replacing a score.

## Listening and native resources

New listening input stores validated QR-derived or manually supplied playback
addresses, never recordings. QR decoding/applying an address are offline. Only
explicit discovery/playback performs guarded public HTTP/HTTPS reads; reject URL
credentials, private/reserved addresses and unsafe redirects. Retain DNS pinning,
no-proxy requests, redirect/body/deadline bounds and unresolved-DNS fencing.
Fetched bytes/Blob URLs are memory-only and released after use. Snapshots, ZIPs
and backups retain the address without downloading audio. Historical recordings,
checksums, segments and offline playback remain compatible; native decoding is
sandboxed and bounded. New desktop packages contain no Python/LibreOffice runtime
and must not discover installations or accept executable preferences in backups.

## Validation and delivery

Use temporary data and provider substitutes; normal tests never call real models
or Tencent. Preserve original regression corpora and first-failure evidence.
Backend coverage requires 90% statements/lines/functions and 85% branches, with
reports retained on failure. Verify actual native workflows separately from
browser mocks, remote CI, final-package/manual acceptance and live-provider
quality. Signing, notarization, publication and model accuracy are not established
by successful tests. Update relevant documentation and focused regressions with
behavior changes. Preserve pinned dependency/license provenance, source/lock
identity, exact final bytes and fresh outputs in package/release checks.

Follow `CONTRIBUTING.md`. Issues use `.github/ISSUE_TEMPLATE/`; PRs use
`.github/PULL_REQUEST_TEMPLATE.md` with all sections preserved, non-applicable
items explained and only verified checklist items checked. Conventional Commits:
`<type>(<scope>): <summary>`, types `feat`, `fix`, `docs`, `refactor`, `test`,
`chore`; optional scope, imperative summary at most 72 characters, no trailing
period. Keep each commit scoped to one concern. Do not publish a release or
discard historical deployment data as part of routine migration/CI work.
