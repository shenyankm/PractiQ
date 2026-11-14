# Electron and TypeScript migration

Tracking: [#549](https://github.com/shenyankm/PractiQ/issues/549).

The approved target is one macOS Electron application. React remains the UI;
TypeScript/Node replaces Rust and Python business logic. SQLite and local files
replace PostgreSQL and RabbitMQ. AI runs in background processes owned by the app.
LangGraph.js (`@langchain/langgraph`) owns document orchestration, checkpoints and
Store. Historical Python/Rust behavior is retained in frozen fixtures and Git
history; those runtimes are no longer current build or execution dependencies.

The user confirmed two desktop scope changes on 2026-11-14. Office files above
the active transport/type limit must be exported as PDF before import; the app
must explain this before admitting paid work and must not discover LibreOffice.
New listening input accepts QR codes and stores playback addresses without
persisting recordings. Existing audio files and their frozen practice and
backup references remain supported. QR/address editing, guarded in-memory
playback, ZIP/backup round trips and native Electron playback are implemented
and verified. Final runtime package acceptance is recorded below.

## Permanent regression data — 2026-11-14

One-time migration callback snapshots and randomized comparison matrices have
been removed from the PR. Original raw data remains at Git revision `012843bf`
and in ignored local archives; normal tests and package smoke checks do not load
those archives. Focused tests retain literal source/answer proof, immutable figure
identity, compound continuation, explicit deduplication, partial results and
recovery guarantees. Small format/encoding and crop-calibration inputs remain.
The original wire/model schema copies are represented by independent SHA-256
baselines rather than a second full schema source. Historical progress entries
below describe the checks that existed at their dated migration stages.

The current complete backend suite passes 1,829 tests across 90 files with
91.05% statements, 92.71% lines, 91.74% functions and 86.11% branches. Original
coverage gates remain 90% statements/lines/functions and 85% branches. Package
worker checks now use small explicit inputs rather than replaying the migration
corpora. All 4,616 original archived comparison tests across 23 files also pass against
the unchanged current implementation. These are a local one-time verification,
not a dependency of normal tests. Latest-head remote checks must pass before
returning this PR to review.

## Acceptance ledger

Checked items have executable evidence in the sections below. Runtime cutover
was accepted at `b3f3afcd` by both required remote gates, the full copied-app
workflow and independent installed-package checks. Receipts identify their exact
source/build; they do not certify a later implementation or a publisher release.

- [x] Sandboxed Electron renderer, narrow validated IPC, background database worker.
- [x] Schema-11 practice database, locale compatibility, exact schema validation,
  restoration recovery, and copy-based existing-data comparison.
- [x] Bank/question CRUD, every question type, source associations, review flags,
  search/filter/pagination, favorites, notes, and learning statistics.
- [x] Practice and exam selection, immutable snapshots, timing, listening,
  objective marking, manual overrides, history, and retry workflows.
- [x] Verified content-addressed images/audio, native file tickets, bounded
  archive import/export, duplicate detection, version-4 backups and restoration.
- [x] TypeScript-owned strict contracts and parity with committed IPC/AI fixtures.
- [x] Embedded AI settings and OS-protected credentials, absent from backups/logs.
- [x] SQLite AI tasks, LangGraph.js checkpoints/Store, usage budgets, durable call receipts,
  pause/cancel/resume, explicit retries, partial export, and shutdown recovery.
- [x] Tencent submission/query/signing, immutable sources, uncertain submission
  recovery, source splitting, optional private COS, and immutable figure mappings.
- [x] PDF/image/Office normalization parity within the approved desktop policy,
  resource limits, process cleanup, hidden sheets/slides and engine identity.
  Oversized Office requires user-exported PDF; no converter discovery remains.
- [x] Extraction, supplied-answer preservation, optional explicit answer generation,
  reference-grounded grading, and success/failure/unknown usage records.
- [x] Real Electron happy paths and recovery, packaged offline operation, dependency
  audits, CI, release tooling, documentation, and removal of obsolete runtimes.

## Current cutover status — 2026-11-14

The default install, development, test, build and verification commands, both CI
workflows, contract generation and release tooling now use Node/TypeScript only.
The 284 tracked Rust/Tauri/Python runtime, test and build-tool files have been
removed (97,607 deleted lines). Fourteen dated Python scripts under
`docs/evidence/` remain historical reproduction evidence, outside every current
build graph. Historical deployment files, licenses, reports, fixtures and
`.gitignore` rules remain intact. The repository-owned old loopback Python
process was stopped gracefully; port 8090 no longer has that listener. No
PostgreSQL/RabbitMQ volumes, local source/task files or credentials were removed.
Streaming inventories before and after tracked retirement contain the same
61,692 ignored paths and the same SHA-256
`573c57c8a31f9bdb423b14ca79480fc458cd97addd0dfaa985ad7339daef2c82`.

Before retiring the Python exporter, its contract/fixture checks passed one last
time. In addition to the existing frozen wire and IPC schemas, the original
Pydantic serialization schemas for all six model outputs and their nested
definitions are checked through `app/fixtures/contract-schema-hashes.json` (19
exact definition digests). A Node regression hashes every authoritative
TypeScript-owned schema and compares it with the original baseline. The fixture provenance records the original revision
and checksum; frozen references are never regenerated from the new exporter.

`make verify` passes after tracked retirement: 5,895 embedded-runtime tests
across 90 files, 916 frontend tests with seven existing skips, 26 CI guards and
76 release-tool tests, contracts, types, lint, required coverage and renderer
build. Backend statements/lines/functions/branches are 91.65/92.95/92.35/87.42%.
The CI guards explicitly reject retired runtime bootstraps and verify that
historical ignored data remains protected. These are substitute-provider tests,
not live model accuracy measurements.

The production profile now uses Electron's `userData/v4/`. Historical Tauri and
`electron-migration/v4/` prototype directories remain untouched; users transfer
compatible schema-11/version-4 learning data through explicit backup restore.
The installed-package check seeds an invalid old prototype database and verifies
that startup, backup/restore and restart neither open nor alter it.

The current arm64 DMG has SHA-256
`63938917c0c9135d1baa86dbe4b3d3d95a4f637f1ad748d85b2702f0184821d3`.
Read-only installation outside the checkout passes signature, sandbox,
system-only PATH, canonical profile, offline practice, all five ZIP codecs,
bundled PDFium, backup/restore and restart checks, with zero paid calls and zero
renderer HTTP requests. Its installed Node 24.22.2 runtime also verifies a
private copy of the existing profile: every table, hydrated projections,
4 banks, 64 question rows, 15 sessions and 2 assets survive backup/restore, and
original-profile hashes remain unchanged. Evidence is retained in
`app/.build/evidence/electron-package-63938917c0c9-1794648172205-acceptance.json`
and `existing-data-QFn9FY/report.json` beneath that directory.

That DMG's local OS credential initialization timed out. Its three credential
flags remain false; core success does not turn the complete package check green.
No timeout, encryption requirement or Keychain namespace was weakened. The prior
source, `a3bef2da`, passed both
[Desktop CI](https://github.com/shenyankm/PractiQ/actions/runs/43577564145) and
[Service CI](https://github.com/shenyankm/PractiQ/actions/runs/43577564200),
including full copied-app workflows and installed-DMG OS encryption/restart on
the fresh macOS runner. Those receipts predate tracked retirement and the
canonical profile change.

The final runtime source, `b3f3afcd52279850c698a9968fe854ab05508815`, subsequently
passed both [Desktop CI](https://github.com/shenyankm/PractiQ/actions/runs/43580736239)
and [Service CI](https://github.com/shenyankm/PractiQ/actions/runs/43580736267).
The backend passed all 5,895 tests on Node 24; App quality passed the same 916
frontend tests, seven existing skips, all 240 browser cases and npm audits with
zero reported vulnerabilities. The current copied application completed its
entire document/practice/recovery workflow, including graceful worker shutdown.
The independently installed CI DMG has SHA-256
`8e94ca595f304ab66648e79a7b31f556166a66ada606d812e1178f92925198e4`.
Its OS encryption, credential exclusion from backups and restart decryption
flags are all true; its package inventory rejects legacy runtimes. This is
current-source packaged acceptance on the fresh macOS runner, not a claim that
the different local ad-hoc signature's timeout was resolved.

The source-bound `desktop-checks-macOS` artifact was downloaded and verified
against GitHub's digest
`f48b8ce304dc5e2739b183b8cc19c2242966c1b4780c8ef54272b3df0d2beaf0`.
Its installed smoke, package inventory and hash-bound acceptance receipts are
retained under `app/.build/evidence/ci-b3f3afcd/`. The CI receipt does not claim an
existing-user-data copy; that separate check is proven by the local installed
runtime and original-profile hashes above. There are no unresolved PR review
threads. This closes the runtime migration ledger; publication remains a
separate explicit action. Native dialogs are substituted in automated package
tests; publisher signing/notarization and live provider fidelity are not claimed.

Repository-level CodeQL default setup is separate from the tracked App/AI
workflows. A complete PR-check inventory found that its retained Rust analysis
failed after source retirement with exit code 32, "could not process any code
written in Rust". The default-setup language configuration now retains Actions,
JavaScript/TypeScript and the preserved historical Python evidence, and removes
only the retired Rust analysis. GET-before/after verification confirms that code
scanning stays configured and its query suite, threat model, weekly schedule and
runner settings are unchanged. JavaScript/TypeScript aliases returned by GitHub
are preserved. The operation uses GitHub's documented
[default-setup API](https://docs.github.com/en/rest/code-scanning/code-scanning#update-a-code-scanning-default-setup-configuration);
its request and configuration receipts remain ignored under
`app/.build/evidence/codeql-default-*.json`. The final PR head must pass its new
CodeQL analysis as well as the normal App/AI gates; a prior workflow-only green
result is not a complete inventory of repository checks.

## Engineering safeguard parity

This map preserves the original safeguards, including recovery paths. The Node
regressions and current-source native acceptance above prove engineering parity
within the approved desktop policy. The chronological sections below retain
earlier intermediate results and failures; their then-pending lists are history,
not additional unimplemented runtime requirements. External/live verification
limits remain explicit in the table and current cutover section.

| Guarantee | Original implementation | TypeScript implementation and evidence | Verification boundary |
| --- | --- | --- | --- |
| Atomic task admission, idempotent operation receipts, run/checkpoint fences | `server/src/practiq_ai/task_api.py`, `runtime.py` | `app/desktop/document-tasks.ts`, `document-runtime.ts`; actual text/OCR graphs, production AI worker, typed main-process commands, embedded workspace import/read/control routing and admission-locked correction/answer-association history and a separately checkpointed explicit answer node; fenced full/selected reparse admissions and independent child evidence; durable deletion fences with explicit recovery, filter-bound stable cursors and version-fenced full/partial ZIP publication | Node admission/receipt/control regressions and current installed workflows pass |
| LangGraph persistence and successful-unit reuse | `execution.py`, `unit_results.py`, Python LangGraph checkpoints/Store | LangGraph.js graph with `SqliteCheckpoints` and `SqliteStore`; immutable validated unit cache, source-verified text chunks, execution fingerprints, actual batched text/OCR model units, durable primary/context correction/reservations, per-unit retry counts and durable text/OCR merge rejection with selected retry and final OCR publication | Checkpoint/unit-reuse and bounded helper queue/abort/deadline regressions pass; installed format helpers load and complete |
| Unknown paid outcomes never replay automatically | `llm.py`, `grading.py`, `tencent.py` | `AiDatabase`, `ModelClient`, `TencentClient`; worker restart and real `SIGKILL` tests with a local provider | Complete native graphs and local substitute-provider/SIGKILL recovery pass; live provider fidelity is not claimed |
| Completed/partial evidence remains available during retry | `task_api.py`, `unit_results.py`, bank export | Task artifact ownership ledger, immutable bytes, previous stage outputs, successful-unit reuse, native saved-result/selected-question import, stopped-task successful-unit partial projection, persisted manual revisions/historical revision import, frozen supplied-answer evidence, passive projection of saved generated answers, transactional local import identities and portable full/revised/selected/stopped-unit ZIP exports | Current installed retry/review/revision/import/export workflows pass; automated file dialogs are substituted |
| Usage on success, failure and uncertainty; bounded paid work | `cost_budget.py`, `llm.py`, import control | Durable call claims and usage; task limits plus atomic cumulative Store reservations and per-unit spend before text model I/O, shared with explicit answer supplementation; recognition has a separate bounded plan; atomic task/UTC-day monetary reservations and explicit read-only reservation reports | Atomic monetary/model budget and helper-capacity regressions plus installed budget controls pass; no process-wide RSS cap is claimed |
| Bounded concurrency, configured read retries, cancellation and shutdown | `import_control.py`, `capacity.py`, runtime/extractor workers | Separate AI/practice workers and process-wide provider slots; persisted run deadlines, queued cancellation before receipts, real HTTP cancellation, pause/interrupt and process-kill tests; a shared preparation queue and bounded PDF/Office/image/crop workers, drained before releasing task ownership on abort | Blocked-worker cleanup, queue bounds and real request shutdown regressions pass; installed AI-then-database shutdown passes |
| Task expiry, execution identity and read-only evidence retention | `execution.py`, task APIs | Original 180-day expiry; code/lockfile/runtime/settings fingerprints; incompatible builds skip checkpoint writes; explicit resume gets a new deadline without resetting spend; incomplete deletions remain discoverable as fenced expired records; read-only corrupt-evidence overlays and explicit journaled expired/orphan cleanup with real process-kill recovery; primary-admission startup isolation, exact-original metadata restoration and receipt/run fences | Expiry/build/admission/maintenance fences and process-kill recovery pass; historical Python checkpoints remain retained evidence |
| Immutable source identity and safe resource access | `storage.py`, native source tickets, `source_repair.py` | `AiStorage`, `SourceTickets`, typed task-owned artifact reads and embedded preview/source routing; preflight rechecks source and all recorded stage artifacts before starting or resuming; text chunk receipts also recheck source ranges, hashes and inferred field presence; explicit native source repair retains quarantined originals, durable manifests and idempotent receipts across real process kills; ZIP export verifies resource ownership/content and immutable source again before publication | Current installed artifact/ZIP/source-repair workflows and copy-only original-resource comparison pass |
| Tencent-only recognition and conservative text/figure proofs | `tencent_inputs.py`, `tencent_bundle.py`, `tencent_staging.py`, document graphs | TC3 signing, immutable submission intents, known-job polling/read retries, immutable raw result caching, invalid-result history and explicit known-job redownload; bounded decoding, native table/XML/image associations, conservative label crops, byte-exact text proofs, historical OCR/page association/enrichment validators and opt-in private COS V5 staging with immutable upload intents and validated-result cleanup | Splitting/signing/COS/association/crop/assembly corpora and actual installed graphs pass; live Tencent fidelity is not claimed |
| Bounded Office/media work, hidden content, cleanup and engine identity | `office.py`, `office_service.py`, extractors | CFB/OOXML input preflight, direct Tencent Office graphs, hidden-sheet and binary/OOXML hidden-slide metadata snapshots, declared slide order/count diagnostics, native PDF/image splitting, shared queued helper admission/cleanup and engine receipts; oversized Office requires user-exported PDF before admission | Approved PDF-first oversized-Office policy, hidden-content/engine/cleanup regressions and installed helpers pass; live provider fidelity is not claimed |
| Supplied answers and grounded scoring stay intact | document graphs, `grading.py`, Rust session handling | TypeScript subjective grading with the original evidence corpus, score scaling and manual/self overrides; supplied-field/count/stem proofs, text/OCR field fidelity, explicit missing-answer supplementation and paid-correction regression corpora | Original assembly/evidence/answer/grading corpora and installed explicit grading/generation pass; multilingual live-provider accuracy remains unmeasured |
| Existing data and restoration survive failures | Rust store/backup/settings/recovery code | Schema-11/version-4 Node implementation, process-kill restoration tests, bidirectional Rust/TS backup probe, all-table existing-user-data comparison on private copies using the installed Electron Node runtime, independent DMG installation and backup/restore/restart; actual macOS open/save panels, replacement confirmation, recovery-copy comparison and restart | Current-source independent DMG, full installed workflows and exact private-copy data/backup/recovery comparison pass |

No row authorizes an additional local recognition fallback or automatic retry of
an uncertain provider mutation. Historical data, credentials and deployment
volumes remain untouched while these checks are completed.

## Data and rollout

Keep practice data separate from AI task/checkpoint/usage data. Preserve schema 11
and version-4 backups; do not silently initialize or replace unknown databases.
Never open a production database for migration experiments. Preserve historical
directories, Keychain namespaces, PostgreSQL volumes, and saved Python checkpoints.
Completed AI results retain their existing JSON contract. Do not assume Python
checkpoint serialization can be loaded by JavaScript.

Closing a window may leave background work running. Quitting must persist state;
reopening may poll a known Tencent job but must not replay an uncertain paid
submission. Only explicit import, grading, generation, resume, or retry authorizes
the corresponding provider work. Backup, passive reads, and migration do not.

During migration, a new implementation must fail explicitly on any unported
operation. It must never silently forward work into the old runtime or return
synthetic success. The old runnable app remains available until parity passes.

## Implementation evidence in chronological order

These entries preserve the migration's intermediate deliveries, checks and
failures. Read the current cutover section above for the accepted runtime source
and remaining distribution/live-provider limits.

The migration branch contains the sandboxed Electron shell, a serialized SQLite
worker, TypeScript-owned contracts, and the practice database implementation.
`app/desktop/` implements question storage, paper selection, session snapshots,
objective marking, manual scores, notes, learning statistics, and restore-intent
recovery. These are partial deliveries against the ledger above.

Portable version-2 bank packages now use the Node implementation: bounded ZIP
streams verify sizes, CRC32 and SHA-256; media is verified before database
references are committed. Imports preserve archived metadata, partial results,
source associations, diagnostics, and whole-tree duplicate selection. Exports
exclude personal practice state and refuse existing destinations. Merged banks
retain their own IDs and preserve source-bank visual scope. Resource collection
retains immutable session dependencies. Image validation uses bounded Sharp
decoding; macOS CoreAudio validates audio in a temporary directory under a
filesystem/network sandbox with time and output limits.

New listening content stores a single canonical public playback address in a
`ContentBlock` with role `listening_audio_url` and a `textValue`. The existing
strict content-block wire contract, schema-11 JSON column, immutable snapshots,
ZIP exports and version-4 backups retain it without a database migration. Local
PNG/JPEG QR decoding returns validated addresses; it neither fetches a URL nor
saves the selected image. Applying an address is also offline. Only explicit
page-link discovery or playback performs network reads. Playback bytes and Blob
URLs live in memory and are released after use; no audio asset is published.

The Node transport retains the Rust reference's public-address restrictions,
all-answer DNS checks and pinning, no-proxy requests, five-redirect limit,
45-second overall deadline, 10-second connection bound, 25 MiB audio cap and
2 MiB HTML cap. An unresolved timed-out DNS lookup remains fenced until it
returns. HTML is parsed without executing scripts. QR work uses a bounded,
cancellable helper with a 4096-pixel-per-side limit. Native smoke acceptance
uses a memory-only audio transport substitute and real Chromium decoding;
unit regressions separately exercise DNS/redirect/body guards. No live website
availability is claimed.

The bundled example bank omits recordings and marks listening media pending
until a user supplies an address. Historical ZIPs, snapshots and backups retain
their original audio files and existing offline playback. New addresses need
network access and may expire; the app never downloads them during passive
reads, export, backup or restore.

Run from `app/`:

```sh
npm run contracts:check
npm run desktop:build
npm run test:desktop
npm run test:electron
```

Version-4 backup/restore now runs in Node. Validation covers the exact schema,
SQLite integrity and storage classes, question/context ownership, frozen session
trees, attempts, notes, media hashes and decoded audio ranges. Portable backups
exclude AI files and unclaimed grading requests with no response; recorded unknown
outcomes remain as evidence. Restoration retains a recovery
copy before publication; explicit repair also preserves damaged original bytes
and an inventory. A failed rollback blocks the running store. Process-kill tests
before and after database replacement verify startup recovery of the corresponding
database, settings and notes. Each reopened store has a new session-cache generation.

The Electron smoke test uses an isolated temporary profile. It exercises real
preload IPC, bank editing, unsaved-close protection, objective and subjective grading,
all-type ZIP import/export, bundled examples, and Settings > Import and restore
including backup and confirmed restoration, with native-dialog result substitutes.
Subjective grading uses a local simulated Responses provider and a test API key
encrypted/decrypted by Electron's real asynchronous OS storage adapter. Submitting
a practice answer or cancelling a regrade confirmation does not start a model
call; explicit grading or confirmed regrading does. The key is not returned to the
renderer or stored in plaintext in its settings file. It saves screenshots under
`app/.build/evidence/`. It does not prove physical file-dialog interaction,
MP3 codec coverage, packaged clean installation, or live provider behavior.

On 2026-11-13, a temporary isolated compatibility probe verified a TypeScript
backup restored by the original Rust implementation, re-exported by Rust, and
restored again by TypeScript. It retained 20 all-type questions, 20 practice
snapshots, notes, favorites and review confirmations. The probe source was removed
after execution; its generated archives and report remain under
`app/.build/evidence/backup-compatibility.json` and adjacent archives.

Embedded AI foundations now include a separate worker, SQLite call receipts and
LangGraph checkpoint persistence, asynchronous OS-encrypted settings storage, a
bounded Responses client and Tencent TC3 submission/query support. Tests exercise
real worker separation, checkpoint restart/resume, local simulated provider calls,
and preservation of unknown paid outcomes without automatic replay. Settings IPC
returns configuration flags rather than decrypted keys. This does not establish
live provider behavior or compatibility with historical Keychain namespaces.

Explicit subjective grading now uses frozen practice snapshots and one model call
in the AI worker. Native uncertainty is persisted before the worker receives the
request. The existing evidence/criterion contract, source-score scaling, supplied
quotations, feedback locale, manual/self overrides and previous usable scores are
preserved. Repeated reads reuse saved outcomes; unknown work requires an explicit
new retry. A restored/reopened database rejects replies from its prior generation.
The original 14-case evidence corpus and worker restart/concurrency tests pass.
On 2026-11-13 the desktop suite passed 226 tests; the real Electron smoke also passed.

Native source selection and immutable AI storage now run in the AI worker. Public
selection results contain opaque tickets, names and sizes rather than native
paths. Selection hashes bounded regular files without copying or starting paid
work. Upload rechecks the original bytes and the settings revision; expired,
evicted, changed or fenced tickets require reselection. Sources retain the existing
managed object keys and checksums under the separate `ai-storage/` directory.
Existing corrupt objects remain unchanged. Office inputs retain the 25 MiB cap,
bounded CFB root-stream family checks, and OOXML family/encryption/macro/expansion
checks. Other original sources retain the 150 MiB cap. Artifact reads validate
their managed namespace, size, checksum and media type; missing reads create no
directories. A later task read still needs its task-owned reference authorization.

The expanded Electron smoke verifies source selection, passive local copy,
settings/content-change fences and cancellation through native-dialog result
substitutes. SQLite inspection confirms those operations create no AI tasks or
paid-call receipts. On 2026-11-13 the expanded desktop suite passed 242 tests.
The document workspace has not yet been connected to these new source commands;
complete task execution and document parsing remain required.

The new task coordinator uses LangGraph.js and a separate
`document-tasks-v1.sqlite` database. Admissions and operation receipts commit in
one transaction. A provider-free initial LangGraph.js checkpoint precedes the
public acknowledgement. Task/run/checkpoint identities fence control actions;
configuration fingerprints preserve the model target. Stage references and the
task-owned artifact ledger retain earlier evidence during explicit retries.
Restart recovery initializes missing local checkpoints and marks unfinished work
interrupted; it never launches a provider call. Recognition job receipts have
their own bounded admission and do not consume the model-call allowance.

Task/control tests use substituted parsing stages. Separate real-process tests
kill Node during an unknown provider request and after a successful response is
durably saved. With a local Responses substitute they verify no calls at startup,
no new call on resume of an unknown receipt, one new call after explicit retry,
and reuse of a saved successful result without another call. These tests do not
prove the real document parser, task/day cost reservations or
the workspace integration. On 2026-11-13 the desktop suite passed 265 tests and the
existing real Electron smoke remained green.

LangGraph.js now also uses the SQLite `SqliteStore` implementation, with atomic
updates, strict bounded JSON, namespace isolation and reopen tests. A real
LangGraph.js checkpoint/resume test accesses it through the graph's Store.
Unit results publish immutable artifacts before Store references; reads validate
source/input/execution identity, JSON, question structure, visual bounds and
checksums. Late older rounds and failures cannot overwrite a usable saved result.
Original metadata repair, missing-formula review, source-answer conflicts,
fragment continuations and discarded model audio have focused regressions.
A one-time Python/TypeScript comparison of 51 existing contract cases and eight
literal-math cases found no remaining differences in that corpus; its inputs and
report are retained under `app/.build/evidence/unit-parity*.json`. This is not full
source-proof, OCR-page or document-graph parity.

The original 180-day execution validity is retained. Expired tasks cannot begin,
resume, retry or enter a new stage. Verified outputs arriving from an in-flight
stage remain saved; passive result/artifact reads retain their evidence. No
historical task data is deleted. Per-unit source proofs and normalization-engine
identity remain required before cutover.
On 2026-11-13 the expanded desktop suite passed 309 tests across 28 files;
the Electron smoke and both TypeScript/Python contract-export checks passed.

Document execution now persists an absolute deadline per run in the JavaScript
Store. The default remains 1,800 seconds; old AI settings without the new field
read that default without rewriting their file. Explicit resume creates a new
run/deadline, while task and unit spend remain unchanged. Model and Tencent I/O
inherit the execution abort signal even if a stage omits its own signal argument.
Local HTTP tests stall before headers and during the response body: deadline
cancellation retains the unknown receipt, and explicit resume sends no new call.
Real `SIGKILL` recovery tests also verify persisted per-unit spend.

Build fingerprints cover desktop runtime sources, SQL/configuration, shared
contracts, the dependency lockfile and Node/V8/ABI/platform identity. Semantic
settings add the model target, output bound, task allowance, run timeout and COS
settings; credentials and operational model-timeout/concurrency settings are
excluded. Changed/missing historical build identities are rejected before graph
checkpoint writes and skipped at startup; their original task records remain
readable and do not occupy the current build's admission queue. Changed settings
cannot be substituted inside an already authorized unit.

Per-unit model allowances are atomically spent in SQLite before new provider I/O;
validated successful receipts do not spend another slot. Unknown/failed calls
retain their consumed slots, and malformed or unavailable Store state cannot reset a budget
or authorize another request. Starting/resuming also verifies the original source
and every recorded current/previous stage artifact, including task ownership,
size and hash. Damaged bytes and prior operation receipts remain intact.
These are runtime guards, not acceptance of the unported parser dispatch/repair
rules, normalization manifests or task/day monetary reservations.
On 2026-11-13 the desktop suite passed 341 tests across 29 files, including the
real-process recovery cases. The Electron smoke and both contract-export checks
also passed; no paid provider calls were used.

Tencent result bundles now decode in TypeScript through one validated ZIP central
directory. Limits retain 2,000 entries, 150 MiB expanded content, 8 MiB per
XML/JSON/Markdown member, the shared character/pixel caps and 25 MiB subimages.
All archive member metadata is checked before reading evidence. Duplicate/unsafe
paths, encryption, symbolic links, bad CRCs, XML document types/entities,
cross-page image links, invalid bounds and repeated figure IDs are rejected.
Native tables retain blank cells, leading zeroes, merged-cell XML and
coordinate-free images. Captions are indexed once, with ambiguous matches left
unassociated. Literal Markdown and nested OCR/table/formula content remain inert.

Stored, deflate, Bzip2, LZMA and Zstandard ZIPs, including the deprecated
Zstandard method 20, retain decoding support. Rare codecs are opt-in for provider
bundles and run sequentially in a separate Node worker with a five-second limit,
256 MiB old-generation/32 MiB young-generation V8 limits, bounded output and
128 MiB dictionary/window caps. These are not a hard process RSS limit. Existing
bank/backup readers keep their prior codec policy. Actual image decoding verifies
format, size and pixel limits; PNG chunk CRC/frame checks retain the old source
extractor's rejection of animation, including APNGs with a separate default image.
JPEG MPF metadata also rejects multi-picture MPO files that Sharp otherwise reports
as single JPEG images; unsupported signatures are rejected before native decoding.

A one-time 19-case Python/TypeScript comparison found identical bundle outputs or
rejections, including native layouts and UTF-8/UTF-16/Latin-1 XML. Its inputs and
report are under `app/.build/evidence/tencent-bundle-parity*.json`. Fixed codec,
native-table and animation fixtures are retained under `app/fixtures/tencent/`.
The Electron smoke now exercises the same codecs in Electron-owned Node workers
and writes `electron-tencent-codecs.json`; this proves decoder/runtime integration,
not live Tencent recognition. An orphaned submission intent without an outcome
cannot create another paid request, and conflicting job/receipt identities are
refused. Durable acknowledgement recovery still reuses its known job ID.
The TypeScript result coordinator now saves the immutable raw ZIP and its reference
before decoding. It validates all referenced subimages and the shared visual-byte
cap before marking the result valid. Cached bytes are hash-verified on reuse;
local corruption fails without replacing evidence or triggering another download.
Invalid provider bundles retain their previous references/bytes. An explicit
resume queries and downloads the same acknowledged job, while validated results
need no provider I/O. Cancellation leaves validation pending rather than marking
the archive corrupt. Missing-page counts and safe page/error identifiers survive;
signed URLs and raw provider error messages do not enter task state.

Only reads retry: transport failures, HTTP 408/429/500/502/503/504 and Tencent
RequestLimitExceeded/InternalError responses use the configured bounded,
exponential backoff with jitter. Malformed/oversized JSON, invalid metadata,
permanent rejections and redirects do not retry. Backoff checks pause/cancellation
and inherits the persisted run deadline. Paid submission never uses this retry
loop. Atomic job patches retain newly saved references when an earlier query or
rejection finishes; validation publishes only against its original result reference.

On 2026-11-13 the desktop suite passed 442 tests across 31 files. This includes
corrupt-archive/subimage recovery, durable cache reuse after reopening SQLite,
uncertain/failed job retention, cancellation and a real LangGraph.js checkpoint
resume that keeps one submission across two downloads. Other parser stages in that
integration test remain substitutes. Evidence is retained in
`app/.build/evidence/desktop-tests.log` and `tencent-recovery-tests.log`.
The subsequent Electron smoke and both TypeScript/historical-Python contract
export checks passed. The smoke uses a local grading substitute and fixed Tencent
archives; no paid provider calls were made.
`TextDocuments` now implements actual prepare/recognize stages for UTF-8 TXT and
Markdown. A persistent, source/task/policy-bound manifest records ordered immutable
parts and original byte ranges. Every part is written and verified before the
first paid submission; later-part failures cannot submit a valid prefix alone.
A completed preparation receipt can be reused after interruption before its graph
output commits. Changed manifests, policies, hashes or part counts fail without
replacing the saved evidence. Text splitting retains every byte, initial/embedded
BOMs and CRLF, and prefers complete UTF-8/newline boundaries. A fixed 27-case
historical Python corpus is retained in `app/fixtures/tencent/text-splits.json`.

Text recognition uses the configured bounded parallel workers and retains source
order when results finish out of order. A failing worker stops queued parts,
requests sibling cancellation and waits for all in-flight workers to exit. Resume
reuses acknowledged jobs and valid archives, including siblings interrupted during
download; cancellation is not recorded as archive corruption. Original-text source
proofs require byte-equivalent decoded content concatenated without injected
separators and no missing pages/figures. Otherwise the original and OCR evidence
remain reviewable, with explicit failed-page markers and bounded total OCR text.

The subsequent desktop suite passed 465 tests across 32 files. Electron 45.3.1's
Node 24.22.2 worker also ran these real text stages through LangGraph.js with two
fixed, substituted Tencent responses and an exact source proof. It deliberately
stopped at the unported structure stage with ACTION_UNAVAILABLE; no final result
was fabricated. The Electron smoke passed and retains its stage/runtime report in
`app/.build/evidence/electron-tencent-codecs.json`. These stages are not yet wired
to the complete desktop import workspace.

Text chunk planning now retains the original 30,000-character target,
40,000-character hard limit and 16-node density target. Proven closed parent trees
stay whole, including trees above the node target. Unknown section/body scopes,
incomplete source and unproven tabular rows retain conservative legacy spans and
no exact record-count/presence gate. Original tabular headers remain separate
model context; they are never prepended to stored fragment bytes. Historical
CSV/tabular proof helpers do not enable new CSV uploads.

Source framing and slicing count Unicode code points, with Python-compatible
whitespace and line anchors. Literal-stem hashes, supplied stem/options/analysis
and answer presence, shared-option ownership and partial/reordered span behavior
matched the 169-case historical corpus, now archived at Git revision `012843bf`.
An additional deterministic 3,500-case boundary comparison found no differences;
its inputs/report remain in `app/.build/evidence/source-boundaries-fuzz*.json`.
Long whitespace runs use linear scans, including the shared Tencent trim helper,
rather than repeated multiline/backtracking starts.

When Tencent text exactly proves the original, `ChunkInputs` durably records
source/task/policy-bound spans, record counts, presence hints and immutable chunk
references before model work. Recovery recomputes those semantics from verified
text and checks every fragment's namespace, source range, bytes and hash. Missing
or damaged chunks and altered but hash-valid manifests remain explicit errors;
they are not regenerated or trusted silently. An interruption before graph-output
commit reuses the saved chunks and acknowledged Tencent result without more
provider requests. Regression tests cover each of these boundaries.

The subsequent desktop suite passed 642 tests across 33 files. This verifies chunk
planning and persistence, not model-output validation or the still-unported
correction/repair/merge policies. The latest Electron smoke and both contract export
checks also passed; its embedded worker report confirms a persisted chunk whose
bytes exactly match the source, then stops at the unported model structure stage.
The model parser stages, global preparation/
concurrency limits, cross-part visual accounting and the complete workspace remain
required before document-import cutover.

`structuredCall` now preserves the original four-call document correction bound,
preallocated per-unit allowances, 64,000-character complete input limit and
reset-to-original messages with only the latest failed output/feedback. Every
attempt has its own durable claim and known usage. Pause/restart reuses failed
receipts, while interruption after provider success reuses the successful receipt
before writing the unit artifact. Repeated identical content/feedback stops after
two attempts despite changed provider IDs/usage. Distinct invalid drafts stop at
four. Truncation, missing usage, local validation failures, unknown transport
outcomes and conflicting targets never trigger a corrective provider call.
Explicit HTTP 409/429 rejections retain bounded backoff and separate claims;
permanent/authentication/balance rejections stop without retry. Grading still makes
one bounded call without this correction loop. Global dispatcher allocation,
task/day price reservations and complete multi-format/review/repair scheduling
remain pending.
Model-facing schemas now also retain the original extraction-specific required
fields, parent/type/material descriptions, independent matching-side IDs and the
media/material-only model review vocabulary. Three fixed historical schema
comparisons cover extraction, grading and corrections, and confirm that producing
provider schemas never mutates strict local wire validation. Complete unit prompts
still need to be connected to the remaining parser stages.

The bounded local JSON repair fallback now ports the original punctuation-only
algorithm rather than adding permissive value/schema coercion. It can remove a
matching Markdown fence, remove a comma immediately before a closing bracket,
discard duplicate root closers and close known containers at EOF. Missing values,
unfinished strings, mismatched brackets, duplicate decoded keys, unsafe numbers
and excessive nesting still fail. Provider-declared truncation stops before this
repair. Only model arguments use it; HTTP envelopes and saved artifacts remain
strict. A 331-case historical corpus and actual paid-boundary tests confirm that
repairable punctuation consumes one model call. The common JSON decoder also
retains a leading BOM so model/offline importer parsing rejects it as the original
implementations did; BOM characters inside content remain untouched.

`TextStructures` now connects verified text chunks to actual batched model units.
The complete original document/answer-sheet prompts have fixed reference hashes;
file/type/fragment context, repeated-header boundaries, exact record counts and
supplied-field instructions accompany each original fragment. All chunks and
cached unit artifacts are verified before the first request. A hash-valid but
different text artifact cannot claim original-source field proofs. Differing OCR,
selected-page/reparse workflows remain explicit unfinished stages.

Before each batch, the JavaScript Store atomically reserves the original worst-case
allowance against a cumulative task ledger. The original default is two concurrent
text units. Completed calls do not refund unused reservations, and pause/resume or
interruption before stage-manifest publication reuses both allowances and immutable
unit results. An unknown call stops the batch, drains active work and never starts
the next batch or replays the call. Known failed units retain explicit records;
selected retry preserves successful siblings and the old partial manifest. Fixed
tests cover allocation corruption, concurrent dispatch, exhaustion, pause/restart,
unknown results and damaged late/cached evidence. Live progress/reservation
projection into the task API still requires parity.

The 1,309-test milestone used the actual `TextDocuments` and `TextStructures`
stages in LangGraph.js, including original prompts, one known missing-label
correction and local repair of the corrected response's trailing comma. It retains
the two-call failed/succeeded receipts and a durable structure manifest, then
deliberately stops at the unfinished assemble stage. This remains substituted
Tencent/model evidence, not complete source-to-bank or paid-provider acceptance.
The subsequent desktop suite passed 1,309 tests across 38 files; the latest
Electron smoke, TypeScript contracts check and historical Python exporter check
also passed. These results do not satisfy the remaining merge, OCR/multi-format,
live-workspace or release acceptance items.

The pure source-overlap merger now retains ambiguous or conflicting extracts and
collapses only one equal candidate at the same unique source position in adjacent
overlapping units. Unicode source positions count code points; whitespace follows
the original source rules. Group merging requires shared proven overlap or unique
source metadata, and preserves unassociated instructions. Node/group limits retain
whole composite trees and remap source/quality indexes. Thirty-seven fixed outputs
were captured from the passing 41-test historical chunking suite, with separate
large-cap regressions and nullable/default metadata comparisons.

Composite finalization now collapses only explicit adjacent source anchors,
preserves passage/table/transcript/shared-option/scoring/audio content and rejects
conflicting metadata. Missing children/ancestors and blanks outside their tree
retain review evidence rather than inventing questions. Canonical IDs remap groups,
visuals, provenance and quality issues. Twenty-five fixed outputs/conflict indexes
were captured from the passing 40-test historical composite/English suites. Source
tree validation retains the original answer/ancestry-before-parent-completeness
order, so a failed child identifies the correct source unit for later explicit retry.

Source model validation uses its own Unicode case-fold/whitespace rules, preserving
practice normalization behavior. The frozen Python-reference Unicode 16 mapping
was compared exactly with all 1,557 C/F entries in the official
[CaseFolding data](https://www.unicode.org/Public/16.0.0/ucd/CaseFolding.txt).
The Unicode license accompanies built desktop resources. Twenty-nine additional
historical cases cover shared-option canonicalization, duplicate labels, partial
answers and retained material/source warnings. JSON boundaries now reject lone
surrogate values/keys without altering valid supplementary characters.

At the 1,406-test milestone these merge components were still helper projections,
and the Electron smoke stopped at assemble with ACTION_UNAVAILABLE. The later text
assembly milestone below connects them to durable result publication and explicit
retry of merge-rejected successful units. OCR/multi-format assembly and complete
review/export workspaces still require their own acceptance evidence.

The subsequent desktop suite passed 1,406 tests across 41 files. Electron 45.3.1's
Node 24.22.2 worker passed the merge/provenance/immutable-byte projection and built
Unicode-license check; both contract exporters and `git diff --check` also passed.
The historical reference runs used for the new merge fixtures passed 41 chunking
and 40 composite/English tests. They are not a complete legacy-service verification
or full migration acceptance.

Supplied-answer retention now matches 271 historical calls from the passing
313-test answer-evidence/index suites. It proves each answer and explanation against
the question's trusted source, preserves separate answer-sheet context rules and
complete composite/item evidence, and marks unsupported values for review. False,
zero, text spelling and JSON numeric token types remain distinct. Another 162 fixed
edge cases, 2,500 generated Unicode/layout variants and 20,012 scalar string
spellings matched the Python reference. These are synthetic differential checks,
not paid-provider or real-document acceptance.

Source/tree duplicate proofs now reuse the exact source layout and unique quote
location helpers. Complete trees must establish a source/model bijection before
printed IDs are normalized; identity slots cannot collide with literal text.
Unknown, incomplete, ambiguous and context-dependent trees remain unproven.
Original-source repeats with different parsed business fields remain reviewable;
only proven exact copies may be removed after explicit opt-in. Group, visual,
source, quality and review associations survive removal. The fixed 151-call corpus
comes from the passing 126-test historical source/scope/duplicate/validation suites;
nonfinite evidence is checked independently to avoid fixture JSON losing its type.

The subsequent desktop suite passed 2,042 tests across 44 files; both contract
exporters and `git diff --check` passed. Electron's Node 24.22.2 worker also passed
all 151 source-tree and 271 supplied-answer reference cases, followed by the native
CRUD/practice/grading/ZIP/backup/restore smoke. These calls use model substitutes.
Those helper-level results did not authorize deleting the behavioral reference.

Manual retry admission now preserves the original two-retries-per-unit policy,
rather than exhausting the whole task after two rounds. The cumulative run round
still separates durable model receipts and allocations, and may exceed two across
different units. Eligibility, retriesRemaining and selected-unit validation share
the same code list; an all-failures retry skips exhausted units, duplicate selections
count once, and invalid mixed selections fail atomically. The persistent count map
is validated before use; historical records lacking per-unit counts remain readable
and cannot silently reset a prior retry history. Model allocations are cumulative
and are never refunded by this change.

An actual TextStructures/LangGraph regression passes five explicit retry rounds
across three independently failed fragments, reuses successful/unselected units and
retains the first immutable partial manifest. Its 15 model-substitute calls have
separate durable receipts. Seven reference Python retry-policy tests and the new
selection/count/metadata regressions pass. Store-backed live reservation projection
remains an unfinished item.

The subsequent desktop suite passed 2,058 tests across 45 files, including the new
retry, shared-option revalidation and large-table finite-evidence cases; both
contract exporters passed again.

`TextAssembler` now publishes final text results and processing artifacts from actual
saved model units. It rechecks the admitted source, recognition/chunk ownership,
immutable ranges, original scoped model-input digest, unit round/execution identity,
latest cache receipt and field proofs before assembly. `text-inputs.ts` owns the
same prompt/scope construction for both model dispatch and assembly; no prompts or
wire models are duplicated. Saved AI results retain source-validation rules, while
native bank import keeps its existing practice rules.

Assembly preserves question-scoped supplied answers, exact overlap rules, complete
tree finalization and source proofs, opt-in duplicate removal, historical audit
warnings, review/source associations, partial failures and document-level missing
content. Confidence uses the reference compensated sum and binary ties-to-even
rounding. The 293-case corpus includes 11 original graph merge captures, 271 composed
answer-proof cases, eight confidence and three audit-warning cases; all match the
reference result/status/processing values. Reference generation is provider-free and
read-only; 24 database-dependent cases were explicitly excluded from its 52-test run.

A merge-rejected successful cache entry now retains its immutable result reference
with status `rejected` and OUTPUT_INVALID. Same-round/late writes cannot clear that
decision; only a newer explicitly admitted retry can replace it. Partial assembly
excludes rejected units without starting another model. Retry rewinds model
structuring while keeping recognition and successful/unselected siblings, and old
unit/partial-result bytes remain task-owned and readable. Real multi-fragment graph
tests cover both failure policies, accepting a partial result, one additional call
for the selected retry, and recovery after rejection commits but result storage
fails. The recovery path makes no additional model calls.

The subsequent desktop suite passed 2,356 tests across 46 files. Electron's actual
TextDocuments/TextStructures/TextAssembler graph now reaches COMPLETED/SUCCEEDED,
with a verified final result and processing receipt, immutable unit bytes, and the
original two correction receipts. Its worker also passes the 293 assembly, 151
source-tree and 271 answer-proof reference cases. Both contract exporters and
`git diff --check` pass. These are model/Tencent substitutes, not paid-provider or
complete import-workspace/native-bank acceptance. Differing OCR evidence, remaining
formats, optional answer generation, full review/binding/export routes, live budget
projection and product cutover are still pending.

`source-fields.ts` and `source-fidelity.ts` now retain supplied field/count/ID and
literal-stem gates, trusted answer quotes, known-type labels, closed composite
trees, printed exercise titles and numbered gap markers. OCR field gates preserve
PRIMARY page anchors, native worksheet/explicit section groups, separate composite
parents, matching policies, unique passage punctuation, unsolved equation prefixes,
option separation and child hints. Ambiguous/unproven OCR title or punctuation
evidence retains review rather than inventing an exact proof. Native worksheet
proof text comes from bounded XML cells, including their original spaces and
iteration order, rather than formatted header aliases. XML types, malformed XML
and excessive nesting are rejected before model work.

Fixed historical corpora contain 35 source-field/closed-tree cases, 88 text
fidelity cases and 144 OCR field cases. These isolate field gates from complete
base-question normalization and immutable figure association/enrichment; the
subsequent OCR milestone below adds those page-validator regressions. A separate 213-case score
corpus preserves the original Pydantic absolute float tolerance, fixing rejected
ordinary decimal scores such as 0.07 and 0.29 without coercing strings/nonfinite
values or accepting arbitrary fractional scores. Practice text keeps Rust Unicode
White_Space trimming; AI extraction first applies Python whitespace rules. Both
retain source BOM characters. Focused tests also preserve exact blank marking and
source-conflict behavior at these whitespace boundaries; exhaustive Unicode
case/answer-source proof equivalence remains pending.

The subsequent desktop suite passed 956 tests across 36 files. Durable model tests
include a known OCR punctuation loss corrected in two separately receipted calls
and invalid persisted scopes rejected before any model request. The Electron
smoke at that milestone used two model substitutes for missing-type correction,
persisted a validated unit and stopped at assemble with ACTION_UNAVAILABLE.
It also checks native XML source text, worksheet grouping and a 0.29 source score
inside Electron's embedded Node worker. No paid provider requests are made by these
tests. The complete desktop import workspace is still not connected to this path;
the smoke is not acceptance of a complete source-to-bank import.

Listening playback, native audio selection/link handling, complete embedded AI
workflows/settings UI and release packaging remain incomplete. Tencent PDF/image/Office
splitting and private COS transport are also pending. Copy-based comparison
of existing user data, including legacy import digests and credentials, is still
required before cutover. The default development/build commands and legacy source
remain until the complete acceptance ledger is satisfied.


### OCR page validator and projection parity

The TypeScript implementation now includes the original page-context planner,
PageFigure table normalization, fixed Tencent figure association, PRIMARY/context
identity guards and final page projection. Context planning retains the eight-page
cap, failed-page barriers, explicit page links and uniquely owned numbered-answer
links. Context cannot remove/relabel PRIMARY ordinary questions, change composite
modes, replace material/options/passages/transcripts, or alter group/figure owners,
fixed coordinates, source cells, labels and answer-bearing roles.

`ocr-validation.ts` compares source reading order, repeated question starts and
literal formulas against displayed question/group/figure content. Missing prefix
or ambiguous statement evidence remains reviewable. The callback consumes original
formula elements independently of sourceText. Models never set coordinates or
invent/drop fixed element IDs. Table projection shares answer roles across
equivalent copies before inserting GFM content, preserves original source text,
and enforces the 1 MiB copy budget, 1,000-block cap and 120,000-codepoint text cap.
Unrepresentable tables retain readable evidence and material-review flags.

Historical Python test captures provide 262 context cases, 389 figure normalization
cases and six table-key cases, 524 PRIMARY/page validation cases, 112 projection
cases, 21 fixed-association cases, 586 complete OCR callback cases and 97 semantic
OCR cases. Focused tests also exercise oversized copies, unchanged input records,
verified coordinate projection and supplementary-character truncation. These
fixtures come from passing historical tests; no real model is called.

Raw model JSON now retains strict integer token semantics before JavaScript erases
the distinction between `1` and `1.0`/`1e0`. This also applies after punctuation
repair and inside ordering/matching answer payloads. Scores, figure coordinates
and arbitrary JSON values still allow float tokens; AudioReference byte counts
retain their historical non-strict behavior. Rejected paid output preserves its
usage, failed receipt and original output and cannot be replayed implicitly.

On 2026-11-13 the desktop build and 4,368 tests across 52 files passed. The real
Electron 45.3.1 / Node 24.22.2 smoke passed the existing native workflow checks,
the complete text graph, 1,452 OCR corpus cases in its bounded worker, and strict
integer/float-token checks. Both contract exporters and `git diff --check` passed.
The expanded desktop suite uses no paid provider calls.

At this validator milestone, OCR dispatch and complete multi-format assembly
were still pending; the dispatcher milestone below connects real OCR model work.
Neither milestone is acceptance of the complete embedded import workspace.


### Actual OCR unit dispatch

`TextStructures` now selects the OCR page dispatcher when Tencent text differs
from the original; only byte-exact text evidence retains original-text proofs.
The real prepare/recognize graph is exercised through TC3 submission, known-job
polling, bounded result ZIP decoding and the actual `OcrStructures` model stage.
All OCR pages, identities, failed-page markers, native XML proof text, fixed figure
bounds and referenced artifact hashes/ownership are checked before model work.
Selected-page/reparse admission and non-text recognition remain separate pending
work; this path currently consumes text/Markdown recognition manifests.

Each OCR page reserves four PRIMARY calls or eight shared PRIMARY/context calls
when usable neighbors exist. Both phases retain their own durable call receipts
and share the same cumulative Store allowance. PRIMARY/context corrections use
the original instructions and validators. Empty PRIMARY pages never acquire
neighbor questions; failed pages cannot start a model or bridge context. Missing
IDs disable enrichment. Only context input overflow falls back to the validated
PRIMARY, preserving `contextSkipped` and review flags. Other known failures stay
failed; an unknown context result cannot be automatically replayed on resume.
Provider calls keep their success/failure usage and original output receipts.

Context drafts match 520 historical `exclude_none`/`exclude_defaults` captures;
arbitrary JSON nulls and empty arrays remain intact. Template-like source text
is substituted once and cannot rewrite the draft or source placeholders. The
original UTF-8 comparison is included only if the complete prompt and preview
labels fit the existing 64,000-codepoint bound.

Verified native figure references supply at most 50 labeled previews. Small PNG
or JPEG bytes stay unchanged; oversized previews composite transparency on white,
encode at JPEG quality 80, and halve dimensions until within 200 KiB or the
original minimum-size stopping condition. Source artifacts stay immutable.
Labels remain adjacent to the matching image and count toward model input bounds.
Final page visuals attach only the original fixed coordinates and artifact/crop
references; associated questions retain review flags. Generated crops from full
source-page images and final diagram-boundary verification are still pending.

On 2026-11-13 the desktop build and 4,907 tests across 55 files passed. Focused
runtime tests cover actual differing Tencent text, PRIMARY/context correction,
context overflow, empty/failed pages, unknown context results on resume, shared
budget exhaustion, success-cache publication gaps, selected failed-page retry,
fixed image attachment, and later-page validation before the first model call.
The Electron 45.3.1 / Node 24.22.2 smoke also runs actual differing recognition and
OCR model dispatch in its bounded worker: one Tencent submission, one model call,
a durable successful page result, and no new calls on resume. Both exporters and
`git diff --check` pass. All provider calls in these tests use substitutes.

At the dispatcher milestone, OCR still stopped at assemble with
`ACTION_UNAVAILABLE`; the following publication milestone closes that text/Markdown
OCR path. Complete multi-format normalization, App import routing/settings/recovery
UI, real provider acceptance and release cutover remain pending.


### OCR final publication and source crop calibration

The real `TextDocuments` / `TextStructures` / `TextAssembler` graph now selects
`OcrAssembler` for differing Tencent text and publishes a final OCR result plus
processing metadata. Both exact-text and differing-text paths reach
COMPLETED/SUCCEEDED inside Electron. OCR assembly rechecks the full recognition
manifest, every unit identity/round, the current Store receipt and the exact
fixed figure inventory, bounds, resource references and question associations.
A consistently rehashed forged cache still cannot change those source bindings.

`assembly-finish.ts` shares final IDs, composite continuation checks, group/visual
remapping, duplicate review, quality, failures, confidence and publication schemas
between text and OCR. Original unit bytes stay immutable. OCR uses original UTF-8
text for answer/analysis verification when available; otherwise it uses immutable
page/context evidence. Native rectangular XML tables retain column ownership and
normalized cell whitespace; merged/multi-layout evidence falls back conservatively.
Original text overlap and automatic deduplication proofs are never inferred from
OCR provenance. PDF page-range references are disabled for text/Markdown OCR,
matching the historical planner; incomplete links retain review flags.

Failed pages preserve their source placeholders and partial diagnostics. A review
policy requires explicit partial acceptance. A merge conflict durably rejects
only its offending page; a crash between rejection and publication resumes
without any new model call. Explicit selected-page retry reuses successful
siblings and respects existing per-unit retry counts and cumulative allowances.
Unsupported model answers are removed only from merge-owned copies and reported;
raw unit/model receipts remain readable and original supplied answers are retained.

`vision-crops.ts` ports the sampled white-paper diagram boundary guard, including
colored foreground, alpha compositing, the 80 percent white threshold, diagonal
edge adjacency and per-crop failure positions. The batch decodes once, checks
pixel/decoded-byte/deadline bounds, and composites on white before checking or
encoding. JPEG previews/crops retain quality 80, the 200 KiB bound and halving
strategy. Native oversized previews use this same helper. Cropping preserves
fixed model bounds, separately retains full-page references, rejects a subimage
as proof of an expanded crop, and retains the 50-crop/1,000-visual caps. Native
image encoders need not produce the same JPEG bytes as Pillow; original source
bytes and their hashes are unchanged.

One hundred captures from passing historical merge tests match complete OCR
results and processing metadata, alongside all 293 existing text assembly cases.
Thirteen native answer-text captures cover rectangular/merged/nested/namespaced
XML and Unicode whitespace. Ninety-five real Pillow PNG cases match rejection,
failure position and crop dimensions through Sharp, including transparent and
colored strokes, faint lines, photos and all edges. Native tests also check
expanded crop verification, absent source pixels, immutable bytes and crop caps.

On 2026-11-13 the desktop build and 5,130 tests across 59 files passed. The real
Electron 45.3.1 / Node 24.22.2 smoke passed all earlier native workflows and runs
both complete graphs. Differing recognition makes one Tencent submission and one
model call, publishes SUCCEEDED with vision_parse provenance, preserves the raw
page ID, and rejects replay of the completed run. The bounded Electron worker
also runs all 100 OCR merge and 95 source-crop references. Both contract exporters
and `git diff --check` passed. All Tencent/model calls in this evidence use
substitutes; no paid provider calls were made.

This graph still consumes text/Markdown recognition manifests. Full PDF/image/
Office normalization, original page-image attachment, selective reparse and all
other source-specific scheduling are not accepted by these tests. The crop helper
is ready for those verified page images, but a text OCR page cannot invent them;
native figure references survive and unavailable expanded crops remain failures.
Complete embedded UI/import/export/review/answer-generation routes, real provider
acceptance, existing-user-data comparison and package/release cutover remain
unfinished. Keep the old runnable chains, credentials and historical volumes.

### PDF and image preparation in the actual graph

The same `TextDocuments` dispatcher now selects `RasterDocuments` for PDF and
PNG/JPEG sources. The complete preparation is persisted in the SQLite Store
before any Tencent submission. It binds the original source, normalization
engine, policy, ordered full pages, lossless input tiles, original page references
and pixel ranges. Resume checks every stored source/tile and the engine policy;
damaged later tiles, missing pixels, overlapping ranges and changed engine
receipts fail before paid work. A checkpoint gap reuses all saved input files.

PDFium runs in a separate bounded JavaScript worker, with a real 512 MiB Wasm
memory maximum, a 256 MiB JavaScript heap limit, a preparation deadline and
serialized admission. Cancellation drains the worker before admitting another
render. Pages preserve 200 dpi ceiling dimensions, rotations and order, the
dimension/pixel/page limits, PNG compression retry and shared visual byte limit.
No Python, LibreOffice or external executable is discovered by this path. The
otherwise in-memory PDFium filesystem exposes only catalogued macOS fonts through
read-only descriptors. Unembedded Chinese text now renders visibly; Wasm and
native PDFium fallback typefaces/rasterization can differ, and pixel equality
between those engines is not claimed. Original source bytes remain unchanged.

Image preparation validates the complete PNG/JPEG scan, PNG CRCs, animation/MPF
limits, dimensions and pixels before submission. Oversized inputs split along
the longer axis, preserving deterministic top/left ordering and exact coverage.
Tests reconstruct RGB, RGBA and 16-bit grayscale samples exactly. CMYK without
an ICC profile matches historical Pillow RGB conversion pixel for pixel; invalid
ICC profiles fail with a controlled error. No downsampling is used.

Recognition uses Tencent output type 9 for both formats. Native Tencent subimages
are verified and persisted before closing their result archive. The version-2
recognition manifest retains verified page images and its preparation identity;
existing version-1 text/Markdown manifests remain supported. OCR model inputs do
not invent UTF-8 source proofs for PDF/image data. The existing OCR assembler now
uses those verified page images for source references, cropping and failed-page
placeholders, retaining partial diagnostics and immutable model results.

On 2026-11-13 the desktop build and 5,161 tests across 62 files passed, including
31 new PDF/image normalization and complete graph tests. The Electron 45.3.1 /
Node 24.22.2 smoke also runs actual PDF and image graphs in its bounded worker;
each makes one substituted Tencent submission and one substituted model call,
retains its page image and publishes SUCCEEDED. Real graph tests cover
unsplit PDF/image publication, actual PDF tile pixel reconstruction, native
subimages, failed tiles, durable preparation reuse, write failures and forged
engine/range receipts. Tencent and model calls use substitutes; no paid calls
were made. The pinned PDFium and wrapper license files and source links are
retained in built resources; the complete PDFium third-party notice inventory
and packaged dependency audit remain pending release gates.

A separate local calibration uses the installed macOS Generic CMYK ICC profile
without copying it into fixtures or packages. Against the historical Pillow /
LittleCMS conversion, 15 of 4,800 channel samples differ by one level and the
maximum difference is one. Profiled conversion is color managed; exact cross-engine
pixel equality is not claimed for that path.

This milestone does not complete Office normalization, selected-page reparse,
App task UI/API routing, optional answer generation, real provider acceptance,
existing-user-data comparison or package/release cutover. Keep all old running
chains, user data, credentials and deployment volumes until those gates pass.

### Direct Office recognition and workbook visibility

The actual JavaScript graph now dispatches Office formats to `OfficeDocuments`.
Supported bounded Office sources go directly to Tencent output type 9; no local
Office content parser, LibreOffice runtime or executable discovery is added.
XLSX first creates an immutable visibility-only snapshot when hidden or very-hidden
sheets exist. It retains the original source and every other compressed member,
validates all decoded member sizes and CRCs before paid work, and binds the derived
artifact, worksheet names, policy and execution fingerprint to a durable Store
receipt. Repeated preparation verifies the snapshot against the original without
rewriting it. Invalid or forged snapshots and storage failures cannot start a
provider submission.

Workbook metadata is changed by namespace-aware bounded XML attribute ranges;
cell data, formula/cache values, merged layouts, out-of-print-area content and all
other XML nodes remain unchanged. The modified metadata member is encoded using
standard deflate. Other original compressed members retain their bytes and codec,
including bzip2, LZMA and Zstandard; no compressor dependency was added. Twenty-one
historical Python captures compare complete XML trees, worksheet identities and
all sibling hashes/codecs. DTDs, malformed XML, excess depth/sheets, corrupt member
data and cancellation fail before submission. Office upload metadata validation
now accepts the same bounded extra ZIP codecs as the historical implementation.

Office and raster recognition share the same native page/subimage persistence,
ordered receipt and stop/drain logic. Office's version-3 recognition manifest
retains OCR evidence and its preparation identity without inventing original UTF-8
proofs or unavailable full-page imagery. Missing worksheet coverage and reaching
the configured page ceiling remain partial results with review warnings. The
actual Tencent Office request carries that page ceiling, bound into its durable
submission input digest, instead of always requesting 300 pages. Native worksheet
groups remain required by the existing OCR validation.

On 2026-11-13 the desktop build and 5,194 tests across 64 files passed. New graph
tests use the committed DOC, DOCX, XLS, XLSX and PPTX fixtures with substituted
Tencent/model calls. They cover complete publication, missing-sheet coverage,
page ceilings, checkpoint gaps, snapshot write failure and a consistently rehashed
forged workbook. These tests do not establish live Tencent recognition fidelity
or legacy PPT content acceptance.

The Electron 45.3.1 / Node 24.22.2 smoke also runs the actual DOCX and XLSX paths
in its bounded worker. DOCX publishes SUCCEEDED; XLSX deliberately receives OCR
without native worksheet coverage and publishes PARTIAL with review diagnostics.
Each uses one substituted Tencent submission and one substituted model call,
retains original source bytes and never invokes an Office converter. An additional
focused run passes 57 tests, including the later ZIP64 fixture, preservation of
raw sibling compressed bytes/timestamps/attributes/comments and refusal to replay
an Office receipt with a changed provider page ceiling. Both exporters and
`git diff --check` also pass.

Large Office sources above the current Base64 transport limit remain explicitly
unavailable in this migration build before any paid call. The historical service
used LibreOffice PDF normalization for that case; shipping or discovering that
runtime conflicts with the approved desktop constraints. Private COS staging and
the final large-Office policy are still open acceptance items. Do not remove the
old runnable chains or declare full multi-format parity on this milestone.

### Embedded document command boundary

The production Electron AI worker now owns `DocumentApi`, with the actual
LangGraph.js document, structure and assembly stages. The main process exposes
strict `document_request` commands for create, control, list, detail, head,
preview and task-owned artifact reads. Their schemas live in
`shared/ai-contracts.json`; TypeScript derives the wire types and the historical
Python exporter checks the same generated artifact. Renderer requests cannot
supply credentials, execution configuration, native paths or SQL.

Passive reads, stop controls and acknowledged-create recovery use settings
metadata without decrypting credentials. A new create first checks its durable
operation receipt without credentials; only a definite pre-admission response
permits the main process to obtain the execution snapshot. An uncertain response
is propagated without automatic replay. Explicit starts/resumes/retries bind to
the selected settings revision. Changes during admission retain the original
request identity for inspection rather than silently resubmitting.

Task detail reads reserved model allowances from the authoritative LangGraph.js
Store ledger and rejects corrupted or insufficient allocations. Reviews retain
raw unit evidence and optional finalized results; artifact reads verify task
ownership, size and checksum, including the original source's wire reference.
Model and Tencent clients share bounded process-wide provider queues across
document graphs and direct grading. Queued cancellation and queue overflow occur
before provider receipts or budget claims; running slots are retained until the
provider operation drains.

Text and OCR dispatchers inspect unresolved provider receipts for every pending
unit before scheduling a batch. This includes units after the first batch and
OCR PRIMARY/CONTEXT calls. A normal resume cannot start sibling units before
discovering an unknown result; explicit retry uses a new round while preserving
the original unknown receipt.

Focused regression evidence covers the complete embedded text graph, passive
reviews and artifacts, ledger corruption, source ownership, keyless receipt
recovery, uncertain responses and settings revision fences. A production-worker
test exercises native source tickets and document commands through real worker
messages with substituted network calls. Workspace UI routing, corrections,
selective reparse, answer binding/generation, direct-bank/partial export and
deletion still need to be connected and accepted before cutover. These native
commands do not establish live provider or packaged application acceptance.

On 2026-11-13 all 5,212 desktop tests across 67 files passed, followed by the
Electron 45.3.1 / Node 24.22.2 window smoke. The latter also exercises the actual
main-process document IPC: empty task reads, credential-free admission refusal,
stale revision rejection and renderer configuration rejection all leave provider
call counts at zero. Existing native practice, grading, import, backup and restore
scenarios pass in the same smoke. Both contract exporters and `git diff --check`
pass. Tests use temporary data and network substitutes; historical user data and
paid provider endpoints are not part of this evidence.

### Embedded workspace and AI settings

Electron now opens the existing document-import workspace through a native
`desktopCloudBridge`, using typed commands rather than forwarding HTTP to the
Python service. Capabilities, recognition preferences, task lists, create/control,
head/detail/preview and checksum-verified artifacts use this route. Existing
operation request IDs, persisted uncertain-create recovery, cancellation,
read deadlines and correction-draft protection remain in the shared client.
Workspace filter aliases map to local task states; the active group excludes
stopped and expired tasks. Unported operations fail explicitly rather than
falling through into the old service.

Global Settings has a native model/recognition form with provider, API URL, model
ID, request/run limits and credentials. Settings wire types now derive from the
canonical JSON schema. Only metadata/configured flags return to the renderer;
credential fields start empty, blank values retain existing secrets, and clearing
requires the dedicated action followed by Save. Dirty edits block navigation and
window closure. Saving or explicitly reloading first flushes pending recognition
preferences. The main process serializes revision-fenced writes without
decrypting existing secrets; the workspace has a stable local recovery namespace.

Source/image/evidence reads retain ownership, byte-count and checksum checks.
Native document downloads use a bounded ArrayBuffer IPC branch and a native save
dialog; no renderer path is accepted. The real-window smoke verifies a 17 MiB
download, cancellation, unsafe filename rejection and refusal to replace an
existing destination. It configures and saves an OS-encrypted test key through
the visible settings form, enters the embedded import workspace, and observes
zero model calls during those passive operations. Screenshots are retained at
`app/.build/evidence/electron-ai-settings.png` and
`app/.build/evidence/electron-document-workspace.png`; form field widths are
checked in the real browser.

Focused component/native tests cover blank/cleared credentials, dirty settings,
preference flushing, native source tickets, typed task/preview routing, retained
uncertain creates, late replies after disconnect, reference property order and
checksum corruption. These tests do not complete correction persistence,
answer-sheet binding, selected reparse, task deletion, direct-bank/partial export,
answer generation, private COS or final service/runtime removal.

On 2026-11-13 the frontend coverage run passed 880 tests with the existing seven
skips (63 passing files, four skipped files); statement coverage is 90.49%, branch
coverage 86.62%, function coverage 87.61% and line coverage 94.94%. All 5,215 desktop
tests across 67 files pass in a separate run. The final Electron window smoke,
frontend/desktop builds, lint, both contract exporter checks and `git diff --check`
also pass. A concurrent earlier desktop run exceeded the five-second timeout of
the unchanged oversized-image preview test; running the suites sequentially
passes without changing its timeout or assertions. No live provider calls or
production-data migration were performed.

### Saved document results enter local banks

The embedded workspace's Import bank and Import selected questions actions now
use typed `import_bank` commands. The renderer supplies only the task ID, reviewed
checkpoint and selection. The main coordinator reads a portable saved snapshot
from the AI worker, verifies each task-owned resource's declared size/base64/hash,
checks the task state/checkpoint again, and sends dedicated byte buffers to the
practice worker. No ZIP or old-service request is created on this path. The
practice worker independently validates the canonical snapshot, exact resource
inventory, decoded image/audio contents and listening segment bounds before
writing verified content-addressed files and committing their database references.

The existing schema-11 `ai_imports` table records the task/content/checkpoint link
in the same transaction as the new bank, questions, diagnostics and asset metadata.
Repeated imports return the original bank and count, including after restart or a
lost reply after commit; they do not replace local edits or favorites. A receipt
pointing to another content digest is rejected. A failing receipt insertion rolls
back all database rows. Unrelated ZIP preview tickets remain valid during direct
document import. New bank names retain the existing 15-codepoint limit.

Selected-question snapshots preserve original ordering and close transitively
over parents, children and shared-option materials. Related groups/visuals and
question-source/quality references are filtered consistently; raw results remain
unchanged. A saved completed result or saved assembled partial result can be
imported with the appropriate scope. Stopped-task successful units can now be
projected before an assembly result exists, as described below. Manual revisions,
named historical revision import and supplied-answer evidence bindings are now
supported; portable partial ZIP output remains pending. Unknown revision IDs
fail explicitly instead of returning the original as a revision.

The real Electron smoke seeds a saved partial-media fixture through a real
LangGraph.js runtime, then uses the visible task list/detail and Import bank
button. The production main process, AI worker and practice worker import two
answerable questions with their image/audio, expose their local assets, and return
the same bank on an explicit repeated import. Subsequent study backup/restore in
the same smoke retains the imported bank. No parser/model/provider work is needed
for this saved-result action. The fixture seed establishes import acceptance,
not live recognition fidelity. The screenshot is retained at
`app/.build/evidence/electron-document-bank-import.png`.

Focused regressions also exercise source ownership, changed checkpoints while
reading resources, corrupt transport bytes, a simulated lost post-commit reply,
corrupted receipt links, Unicode-safe title limits, complete material selection,
audio segment bounds and transactional rollback. Live-provider fidelity,
production-data comparison and final runtime removal are still open gates.

On 2026-11-13 all 5,233 desktop tests across 68 files passed. The frontend coverage
run passed 880 tests with the existing seven skips, with 90.57% statement, 86.71%
branch, 87.61% function and 95.03% line coverage. The real Electron window smoke,
frontend/desktop builds, lint, both contract exporter checks and `git diff --check`
pass. These results use temporary data, saved fixtures and provider substitutes;
they do not establish live provider acceptance or existing-user-data migration.

### Passive partial results before final assembly

`completed-result.ts` projects verified durable units for stopped tasks that have
no assembled result. Detail, result preview and completed-scope bank import reuse
the existing text/OCR merge and finalization functions. The saved recognition
inventory, exact original-text proofs, chunk ranges, input digests, source hashes,
execution identity, retry rounds and fixed OCR figure associations are rechecked.
Active work must stop before a completed-scope import; a task change during a read
or resource transfer rejects the snapshot. No current provider configuration or
credential decryption is required for projection.

Known successes remain exportable alongside failed, unknown and unfinished units.
The snapshot is always PARTIAL, carries the historical partial-snapshot warning
and missing-questions flag, and requires review. Failure diagnostics and unknown
provider receipts remain saved. Detail progress reflects the durable successes;
units without a saved outcome remain outstanding. Merge-conflicting units are
omitted from a local projection copy with OUTPUT_INVALID diagnostics, without
marking their immutable successful receipts rejected or scheduling retries.

OCR projection retains existing native subimages and full-page source references.
When a crop has not been saved, it preserves the original bounds, uses the owned
full-page reference when available and marks affected questions for media review.
It never crops, writes result/processing artifacts, alters Store/checkpoint/task
records, calls providers or increments metrics. Explicit retry and resume retain
their existing paid-work and uncertain-outcome fences.

The real Electron smoke now seeds a raw successful unit through LangGraph.js and
stops before structure/final-result publication. The visible task detail shows
the failed task's partial question and correct completed-unit progress. Clicking
Import bank passes through the production main/AI/practice workers, creates a
one-question local bank and leaves the original state/checkpoint unchanged.
The later backup/restore flow retains that bank. The screenshot is retained at
`app/.build/evidence/electron-completed-unit-import.png`. This is fixture-based
recovery/import acceptance, not live Tencent/model fidelity.

Verification on 2026-11-13: all 5,249 desktop tests across 68 files passed,
including raw-unit checkpoint gaps, unknown model responses, immutable evidence
corruption, future retry rounds, merge conflicts and task-change fences. The real
Electron smoke, desktop/frontend builds, frontend lint, both contract exporter
checks and `git diff --check` pass. This change adds no provider calls or runtime
dependencies. Live-provider acceptance, corrected revisions, portable partial ZIP
output, answer binding/generation, selective reparse, private COS, existing-data
comparison and packaged cutover remain open; the old running chains are retained
until those gates are met.

### Persisted human corrections and historical revision import

The canonical native contract now exposes `corrections` and `save_correction`.
`DocumentRevisions` stores checkpoint-scoped history in the JavaScript SQLite
Store. A synchronous Store mutation lets a save retain the document admission
lock through the Store commit, so resume and concurrent saves cannot race it.
The task/model result, checkpoint, run, usage and source artifacts remain unchanged.
Reads and explicit manual saves require no provider configuration or credentials.

The historical editable-field whitelist is retained. IDs, source text/score,
confidence, resource references, passage/transcript and question relationships
are protected. Existing content blocks permit text/Markdown/LaTeX changes only;
their structure, role and opaque resource data stay fixed. Each candidate is
normalized and checked against the complete question tree, including shared
options and composite materials. Human edits retain review flags. Twelve pure
Python-reference cases cover accepted edits, Unicode, normalization and rejected
provenance/answer changes; separate tests cover protected block structure and
shared-option replay after a later parent revision.

Saves keep the original 1 MiB request, 500-entry and 8 MiB history limits. An
expected revision fences concurrent edits. Explicit replay normalizes against
the tree preceding the original request, returns the saved history without a
write, and rejects changed content, target indexes or answer-source selections.
SQLite write failures roll back; a new connection can reopen the original
history and replay its request. Expired tasks, stale checkpoints, unfinished
results and unknown revision IDs fail explicitly. Answer-sheet selections are
verified against their original saved results, as described below.

Native review previews include the saved history. The existing correction
workbench uses typed commands and keeps its local draft, leave guards and
uncertain-request recovery. Known validation/conflict errors retain their
definite rejection status; lost runtime replies remain uncertain. A named
revision import applies edits only through that request, validates the resulting
tree and preserves source/resource evidence plus the historical correction
warning. Original-result import remains separate. Repeated imports reuse the
existing transactional task/content identity, while different revised content
creates its own local bank.

Settings reload now unmounts the old workspace before replacing its native
bridge. The previous intermediate render could briefly construct an HTTP client
and request old service endpoints. A focused regression checks bridge replacement
without HTTP requests, and the native smoke rejects any renderer `/api/` traffic.
The smoke also replaces asynchronous `waitForFunction` predicates with bounded
awaited native reads: the installed Playwright implementation otherwise treats
the pending Promise as a truthy condition before its value is known.

The real Electron smoke edits a saved listening-material parent through the
visible workbench, saves the revision, imports it with checked image/audio,
verifies the corrected local question, and reimports the same revision into the
same bank. It compares the original task detail before/after, leaves the original
bank intact, verifies zero model calls during correction/import, and completes
the later study backup/restore flow. The screenshot is retained at
`app/.build/evidence/electron-document-corrections.png`. Fixtures establish native
correction/recovery acceptance, not live recognition or grading fidelity.

Verification on 2026-11-13: all 5,280 desktop tests across 69 files passed. The
frontend coverage run passed 886 tests with the existing seven skips; statement,
branch, function and line coverage are 90.63%, 86.80%, 87.72% and 95.12%.
The full native smoke passed with no renderer HTTP service requests. Desktop and
frontend builds, lint, both contract exporter checks and `git diff --check` pass.
Answer-sheet binding, explicit answer generation, selected reparse, private COS,
portable partial ZIP output, existing-data comparison, clean packaged acceptance
and final old-runtime removal remain open gates.


### Supplied-answer association and frozen source evidence

The native `answer_matches` and `answer_proposal` commands reuse the existing
answer-sheet workbench without HTTP or provider calls. Matching preserves printed
question numbers, repeated-number ambiguity, existing answers and explicit
replacement. Literal conversions retain historical separators, Unicode decimal
digits, false values and unsupported text; unsafe integer values are rejected
rather than rounded. The committed Python-reference fixture covers 90 numbering
cases, 30 conversions and an ambiguous matching inventory.

A proposal is passive. Only an explicit correction save writes the association,
under the existing task admission lock and revision/checkpoint fences. The source
must be a completed, unexpired answers task with its matching checkpoint. Saves
recompute the proposal from the immutable source result and reject altered
content. Each edit retains the source filename, SHA-256, supplied text and source
selection. An acknowledged request can be replayed after source availability
changes; new requests still require the source checks. Original target and answer
results remain unchanged.

Named revision imports retain frozen source warnings for the selected questions.
Later edits that preserve the associated answer retain its proof; replacing the
answer clears it. Historical revision import stops at that revision. Evidence
uses the original question ordinal, a codepoint-bounded source excerpt and the
existing warning count limit. Export does not reopen the answer task or invoke a
provider.

A regression with the real text graph exposed completed previews returning raw
unit question IDs instead of final assembled IDs. Completed previews now retain
source-unit metadata with empty question collections, letting the existing UI
use the authoritative final result. Partial, unassembled unit previews keep their
existing payloads. Exact-text recognition uses text chunks; OCR uses its page
inventory. This also avoids loading obsolete raw unit payloads for a completed
result.

The Electron smoke uses a saved LangGraph.js fixture containing distinct raw-unit
and final question IDs. Through the visible workbench it reads suggestions,
adopts an answer, saves the revision and imports the revised bank. It checks the
local choice answer, frozen SHA-256/text evidence, unchanged original task results
and zero model calls before explicit grading. The later ZIP and backup/restore
checks pass in the same run, with no renderer HTTP service requests. Evidence is
retained at `app/.build/evidence/electron-answer-binding.png` and
`app/.build/evidence/answer-binding-electron.log`. These are saved-fixture native
integration checks, not live extraction fidelity.

Verification on 2026-11-13: all 5,413 desktop tests across 70 files passed on the
full rerun. The first run timed out one unchanged image-preview test at its
existing five-second limit; its isolated suite and the full rerun passed without
changing that limit. Frontend coverage passed 887 tests with the existing seven
skips: 90.63% statements, 86.78% branches, 87.84% functions and 95.13% lines.
Frontend and desktop builds, lint, both contract exporters and the native smoke
pass. Explicit answer generation, selective reparse,
private COS/large-Office policy, portable partial ZIP output, existing-data
comparison and packaged cutover remain open. Old runnable chains remain until
those acceptance gates pass.


### Explicit answer generation after extraction

`DocumentRuntime` now routes an admitted `generateAnswers: true` task through a
separate LangGraph.js `answers` node after the extraction result is committed.
The default path ends after assembly. Answer-sheet admissions reject generation;
passive selection, settings reads, task reads, bank export and backup cannot start
this node. The native workspace freezes the selected setting in its explicit
Start request, using the existing strict default-false contract.

`AnswerGenerator` selects only supported leaf questions whose remaining missing
fields are answer/analysis. It preserves supplied answers, false values,
explanations, rubrics, IDs, source text and relationships. Original option labels,
item references, blank counts and complete material trees are validated. Parent
and shared-option context is included; related figures must have exact owned
artifact references and verified bytes. No missing passage, source image or audio
is invented. Generated content and its exported diagnostics retain review flags
and the historical AI-generated warning. Twenty-eight frozen Python-reference
cases cover literal completion, supplied-field retention and invalid answers.

Per-question results are stored in the JavaScript SQLite Store, scoped by task,
source, execution and immutable question digest. Durable reservations share the
existing cumulative task ledger and bounded structured-call correction policy.
Generation calls retain their own `answer_generation` usage kind. A known failure
or empty answer keeps the extraction and produces a partial result. A budget stop
does not reset spent or reserved calls. Unknown paid results stop execution before
another pending generation can run; ordinary resume cannot replay them. Explicit
retry uses a new bounded round while retaining earlier saved generated answers,
unknown receipts and cumulative reservations.

The extraction result remains an immutable assembly artifact. If generation stops
before its final graph output commits, passive task detail and completed-scope
bank import project saved generation records onto that extraction without model
configuration, provider work or Store/checkpoint writes. Restart and explicit
retry tests retain a successful first answer when the second call is unknown.
Changed questions cannot reuse old answers, conflicting records fail explicitly,
and corrupted source/execution/result digests are rejected.

The Electron smoke runs the actual generation node in its native worker with a
saved extraction fixture and model substitute. Through the visible task detail it
imports the generated choice answer and checks the local answer, review flag,
source warning and stable usage receipt. The original assembly has no answer,
and passive reads/imports leave task detail unchanged. The screenshot is retained
at `app/.build/evidence/electron-answer-generation.png`. This proves native
supplementation and result-import wiring, not live recognition or model accuracy.

Desktop verification on 2026-11-14: all 5,460 tests across 72 files pass. This
includes original runtime regressions, disabled generation, strict answer-sheet
admission, a changed original source rejected before generation reservations, shared budgets, known invalid/empty/rejected outputs, unknown-result
restart/resume/explicit-retry behavior, parent context and owned image bytes.
The frontend coverage run passes 889 tests with the existing seven skips: 90.63%
statements, 86.78% branches, 87.84% functions and 95.13% lines. Both contract
exporters, frontend/desktop builds and lint pass. The native smoke also verifies
the generated question remains identical after confirmed study-data restoration.
Private COS/large-Office handling, selective reparse/source repair, portable
partial ZIP output, remaining repair/review and monetary reporting, existing-data
comparison and packaged cutover remain open. Old runnable chains remain until
full acceptance.


### Selected source reparse and original-page selection

The native `reparse` command preserves the existing explicit action and pending
request recovery. Full reparse starts a new task and new Tencent recognition;
selected reparse requires a completed, unexpired parent and its exact reviewed
checkpoint. It reuses verified Tencent evidence and starts only the requested
model units. Both preserve the original source, range, role, deduplication flag,
answer-generation flag and failure policy. Parent task results, checkpoints,
usage and manual revisions remain unchanged. Replaying an acknowledged request
returns its original child receipt, including after parent removal; changing its
selection under the same request ID is rejected.

Child admission commits its metadata, operation receipt and owned artifact ledger
in one SQLite transaction. A parent-version fence is checked again at commit.
An artifact-ledger failure rolls back the child and receipt. Preparation,
recognition and text-chunk manifests receive the child identity; source bytes,
UTF-8 ranges, original page/tile indexes, figure coordinates and reference hashes
are retained and checked before new work. The child additionally owns a
`reparse-evidence` audit manifest, original preparation/recognition/chunk manifests
and selected raw-unit receipts. Original engine/execution evidence therefore
survives parent removal, independently of the rewritten active manifests.

The initial LangGraph.js checkpoint resumes after the already committed
preparation/recognition stages. A cold restart can create this checkpoint and
stop without credentials or provider work; explicit resume later continues the
selected units. Keyless receipt replay cannot acknowledge an uninitialized
current task before its initial checkpoint exists. Already running/completed
receipt replay leaves checkpoints unchanged. Selected work gets its own bounded
call ledger and usage; ordinary resume cannot replay an unknown model result,
while explicit retry retains unknown receipts and cumulative reservations.
Tencent credentials are unnecessary for reuse of saved recognition evidence.

Original page selection now reaches PDF/image and Office structuring. Split
tiles retain their original page mapping, and sparse fragment/page selections
retain their original indexes through model input, merge, partial projection,
preview, question-source associations and export. Raster page bounds are checked
before Tencent submission; Office bounds are checked against the recognized
inventory before model structuring. The historical selected-page warning remains
visible because whole-file recognition may still be charged. OCR PRIMARY and
CONTEXT keep their shared eight-call allowance and independent receipts; selected
work may read neighboring source evidence without structuring the neighbors.

The native smoke runs the visible selection/reparse/import workflow against the
production main process, AI worker and practice worker with a saved recognition
fixture and a local model substitute. It verifies one new model request, no child
Tencent jobs, the parent link, original unit index, reparse warning, unchanged
parent detail and direct local-bank import. The screenshot is retained at
`app/.build/evidence/electron-selected-reparse.png`. These checks establish native
wiring and recovery, not live Tencent or model fidelity.

Regression evidence includes actual text and raster graphs, sparse last-fragment
selection, original tile bounds and figures, rejected stale/unavailable/expired
sources, duplicate selection normalization, independent evidence after parent
removal, cold resume, transaction rollback and unknown-result explicit retry.
Verification on 2026-11-14: all 5,487 desktop tests across 74 files pass.
Frontend coverage passes 890 tests with the existing seven skips: 90.63%
statements, 86.78% branches, 87.84% functions and 95.13% lines. Both contract
exporters, frontend/desktop builds, lint and `git diff --check` pass. The full
native smoke passes with no renderer HTTP service requests, including the
selection/reparse/import workflow and confirmed study-data backup/restoration.
Source repair/quarantine, task deletion and stable cursor pagination, portable
partial ZIP output, private COS/large-Office handling, remaining review/repair and
monetary reporting, existing-data comparison and packaged cutover remain open.
The original runnable implementations remain until full acceptance.

### Original source verification, quarantine and explicit repair

`SourceRepairs` ports the original maintenance boundary into the embedded AI
worker. `source_status` checks retained bytes without writing task, call or repair
records. `repair_source` is an explicit native action under task details. The
main process opens the file picker; renderer requests, recovery records and
receipts contain no native paths or provider credentials. Neither operation
decrypts keys, starts a model, submits recognition or changes task/checkpoint,
correction or usage evidence.

Replacement requires the exact original byte length and SHA-256 plus the shared
Office input preflight. All document writers and provider slots must be idle;
pending/running/pausing records from other execution builds also block repair.
Finish or stop these records using their compatible runtime before repairing.
The existing storage root and write destinations must belong to the current
system account. Passive integrity verification does not require ownership.
Source, replacement and quarantine paths reject symlinks/nonregular files;
nonblocking opens prevent a selected FIFO from hanging before validation.

Before replacement, repair streams and fsyncs the damaged original into a
private quarantine directory, retaining its hash and byte length. It publishes
an incomplete manifest before atomically replacing the source, rechecks the
restored bytes, then publishes a completed manifest and SQLite Store receipt.
Missing sources retain an explicit null original. Pending records bind the
request ID, task version and immutable source reference. Changed task versions,
modified preservation evidence and conflicting requests are rejected. Original
bytes, incomplete manifests and interrupted temporary files remain available
after failure; repair never overwrites a different preservation copy.

The workspace persists a bounded, strictly validated recovery intent before
opening the picker. A lost response leaves this intent visible across remounts;
only explicit retry reuses the original request/version. Acknowledged receipts
return without another picker or write. If source publication finished before
the receipt, explicit retry validates the quarantine evidence and completes the
existing manifest/receipt without another replacement. Passive checks and
startup never finalize or replay repair. Cancelling selection does not modify
the source. Dismissing the local recovery notice retains worker audit records
and quarantine files.

Regression tests cover missing/empty/checksum-invalid originals, wrong and
oversized replacements, owner/version fences, symlinks/FIFOs, active document
and provider writers, altered receipts/manifests, and interrupted publication.
Four real `SIGKILL` probes stop after preservation, incomplete manifest, source
publication and completed manifest; the pending receipt and original bytes
survive and only explicit retry completes repair. Native Electron smoke checks
the visible picker/repair workflow, retained damaged copy and completed manifest,
unchanged task detail and provider counts. The inspected screenshot is
`app/.build/evidence/electron-source-repair.png`.

Verification on 2026-11-14: all 5,515 desktop tests across 75 files pass.
Frontend coverage passes 895 tests with the existing seven skips: 90.57%
statements, 86.77% branches, 87.83% functions and 95.15% lines. Frontend/desktop
builds, both contract exporters, lint and `git diff --check` pass. Full native
smoke passes, including source repair and study-data backup/restoration, without
renderer HTTP service requests. Logs are retained under
`app/.build/evidence/source-repair-{desktop-tests,ui-coverage,electron,build}.log`.
This establishes local recovery and native wiring with provider substitutes;
live providers, existing-user data comparison and packaged cutover remain
unaccepted. Task deletion/cursor pagination, partial ZIP output, private
COS/large-Office handling, remaining review/repair and monetary reporting still
remain open. The original runnable implementations remain until full acceptance.

### Durable task deletion and stable native pagination

The native `delete` command now reaches the production AI worker through the
strict TypeScript-owned document contract. Deletion needs no provider keys or
model configuration. It refuses active task records and in-process execution
or initialization. Under the task database's admission lock it first commits a
deletion fence; all ordinary record reads, controls, corrections, source repair
and reparse paths reject this fence. Concurrent delete requests share the same
operation. It then removes the task's LangGraph.js checkpoints and its own
`document_tasks/<id>/...` Store namespace in bounded pages, before atomically
removing the task, artifact ownership rows and operation receipts.

Cleanup failures and process kills leave the original row and fence available
for explicit retry. Startup does not finish deletion or resume the task.
Incomplete deletions remain visible in task lists as expired records with a
delete action, even if renderer recovery storage is lost. List discovery does
not read a fenced task's result artifacts. Missing-task retries also remove
explicitly addressed orphan checkpoint/Store state and return the same success
shape. Other task namespaces, shared source/artifact bytes, source-repair audit
records, imported local banks and all independent provider receipts—including
unknown, succeeded and failed calls—remain untouched. The app waits for in-flight
deletion during an orderly worker shutdown.

The client saves a bounded, strictly validated deletion intent before sending
the mutation. Unknown or mismatched replies retain it across remounts. Recovery
shows the original task ID and requires explicit retry; dismissing the local
notice does not undo the durable deletion fence. The existing confirmation and
unsaved-correction guard still precede a new delete. A confirmation shown after
an uncertain delete offers closing the notice rather than promising to retain
an already deleting task.

Native list requests now forward filter-bound cursors and set offset to zero
when seeking. SQLite orders and seeks by its immutable `(created_at,id)` tuple;
the emitted cursor uses that same database position, including equal timestamps
or a different timestamp in saved record metadata. Newer insertions and deleted
boundary rows do not shift the following page. Cursor decoding bounds bytes and
validates canonical Base64url, ISO timestamp, UUID, filter and offset exclusivity.
Offset requests remain available. Cancelled, active and expired filters remain
distinct, and passive pagination performs no provider work.

Regression evidence covers multiple Store cleanup pages, unrelated/orphan
namespaces, retained call receipts/resources, active task rejection, concurrent
deletion, checkpoint/Store/final-commit failures and real `SIGKILL` after each
durable cleanup boundary. Selected child reparse tests now delete the actual
parent checkpoint and Store before cold child recovery, rather than only
removing the parent SQL rows. The native smoke verifies confirmed deletion,
retained imported banks/source bytes, recovery of a fenced task without a local
intent, and visible pagination after an intervening insertion. Its inspected
screenshot is `app/.build/evidence/electron-task-lifecycle.png`.

Verification on 2026-11-14: all 5,537 desktop tests across 76 files pass.
Frontend coverage passes 899 tests with the existing seven skips: 90.46%
statements, 86.76% branches, 87.79% functions and 95.15% lines. Frontend/desktop
builds, both contract exporters, lint and `git diff --check` pass. Full native
smoke passes the new deletion/recovery/paging assertions and all prior source
repair, import, practice, grading and confirmed backup/restoration flows without
renderer HTTP service requests. Logs are retained under
`app/.build/evidence/lifecycle-{desktop-tests,ui-coverage,electron,build}.log`.
Portable partial ZIP output, complete unreadable-result diagnostics and global
expired/orphan maintenance, private COS/large-Office handling, remaining
review/repair and monetary reporting, existing-user data comparison and packaged
cutover remain open. The original runnable implementations remain until full
acceptance.

### Portable ZIP export of saved full, revised, selected and partial banks

`export_bank_zip` now uses the canonical native contract, a main-process save
dialog and the embedded AI worker. The renderer receives only the task/checkpoint
and saved/cancelled receipt; native paths and archive bytes stay out of the
WebView. The main process reads only the small checkpoint head before the picker.
It does not decrypt provider keys. Cancellation starts no packaging or provider
work. Snapshot validation and streaming take place in the AI worker after an
explicit destination is selected, with one export at a time and a bounded queue.
An orderly worker shutdown waits for accepted exports.

The exporter reuses `documentBankSnapshot`, resource ownership checks, media
validation and the existing ZIP writer. Native controls cover original full
results, an explicitly chosen saved human revision, selected questions including
required material/shared-option closures, and stopped tasks' completed-unit
projection. The latter retains `PARTIAL`, missing fields, warnings and processing
diagnostics without assembling the task or replaying a model. Original task
records, checkpoints, correction history, usage and imported practice banks stay
unchanged. Existing JSON/null/review/source associations remain portable.

Packages retain version-2 `practiq-question-bank` manifests, schema-3 results,
processing details and checked image/audio references. Limits remain 32 MiB of
question JSON, 64 KiB of manifest JSON, 25 MiB per resource, 256 MiB of resources,
2,002 entries and 300 MiB per ZIP. Resource media, hashes, audio segments and
task ownership are validated before writing; streaming rechecks file hashes.
The original source is verified both before packaging and before publication.
After streaming and fsync, a synchronous publication guard rechecks task version,
checkpoint, expiry and source integrity. Changed/deleting/expired tasks or altered
bytes leave no published target. Existing files are never overwritten, and
destinations inside application data are rejected using the shared export-path
validator.

The shared writer now records private Unix entry modes and file modes, opens
archives/lazy resource files without following links or blocking on FIFOs, and
accepts the final publication fence used by document export. Existing practice
bank and backup callers retain their behavior. Normal failures remove temporary
files. A real process kill before publication may leave a private temporary file
in the chosen directory; it does not create an incomplete target. A kill after
publication leaves a complete readable ZIP. Lost receipts do not automatically
repeat saving or permit overwriting a possibly completed file.

Native smoke exports full mixed-media, revised, selected and stopped-unit banks,
checks CRC/SHA and entry permissions, preserves imported-bank counts and provider
counts, and verifies cancellation. The normal ZIP importer round-trips the
historical mixed-media export. Regressions cover stale/expired/deleting tasks,
source/resource corruption, invalid media, existing targets, symlinks, forbidden
destinations and publication-time changes. Real `SIGKILL` probes cover both sides
of publication. The inspected screenshot
`app/.build/evidence/electron-portable-bank-export.png` shows saved feedback beside
the relevant task's export controls; feedback is fenced by task/checkpoint.

Verification on 2026-11-14: all 5,557 desktop tests across 77 files pass.
Frontend coverage passes 904 tests with the existing seven skips: 90.48%
statements, 86.69% branches, 88.00% functions and 95.21% lines. Frontend/desktop
builds, both contract exporters, lint and `git diff --check` pass. Full native
smoke passes these exports and all prior recovery/import/practice/backup flows
without renderer HTTP service requests. Logs are retained under
`app/.build/evidence/bank-export-{desktop-tests,ui-coverage,electron,build,lint}.log`.
This proves local portability and native wiring with provider substitutes, not
live-provider fidelity or packaged acceptance. Complete unreadable-result
diagnostics and global expired/orphan maintenance, private COS/large-Office
handling, remaining review/repair and monetary reporting, existing-user data
comparison and packaged cutover remain open. The original runnable
implementations remain until full acceptance.


## Read-only diagnostics for unreadable saved evidence

`document-diagnostics.ts`, `DocumentTasks`, `DocumentRuntime` and `DocumentApi`
now isolate missing/corrupt saved results, processing JSON, partial unit evidence,
recognition manifests and recorded checkpoints without rewriting them. A stopped
valid task receives a read-only failed overlay, a blocking diagnostic and no
resume/retry/accept/export actions. Active tasks retain their actual lifecycle and
stop controls; expired tasks remain expired. Original source references, provider
usage and unknown-call receipts remain visible. This is not a repair, a checkpoint
reset or a provider retry.

A previously recorded checkpoint must exist at its exact thread/id and retain the
admission task ID and input digest. Initialization no longer replaces an absent
recorded checkpoint. New control admissions validate the checkpoint before their
transaction, fence the task version across that asynchronous read and preserve
replay of an already acknowledged request. Accepting partial results also runs the
same source/artifact preflight as resume/retry. Durable unreadable-checkpoint
failures remain blocked; a full explicit reparse creates a separate task.

Task-list reads isolate invalid results and malformed primary metadata per row.
Unknown metadata remains visible as an unreadable task and is refused by mutation
and deletion rather than adopted or discarded. State filtering happens after
projection, with bounded-memory SQL iteration and the existing SQL timestamp/UUID
cursor order. Filtered scans can verify preceding healthy results; a persistent
diagnostic index is deferred until large-history measurements justify it. A bounded
256-entry volatile diagnostic cache keeps cheap head polling consistent with
observed failures. Restoring a file does not mutate task versions: a detail refresh
revalidates the bytes and can clear a transient diagnostic.

Infrastructure errors remain errors: database failures/closed handles, unavailable
Store, timeouts and filesystem I/O failures do not become corruption overlays.
Invalid primary task/usage/allocation metadata is still refused where a truthful
validated detail cannot be reconstructed. This gate remains explicit; no synthetic
usage or budget values are substituted.

The workspace displays a recovery explanation, disables unavailable work/export
and preserves explicit new-task reparse and stopped-task deletion. Existing unknown
model-outcome and deadline alerts now accept both string and structured blocking
codes. The native smoke corrupts a saved result in its isolated profile, checks the
visible alert and disabled exports, restores exact bytes, refreshes and compares the
original task record and detail. It never touches a user's profile.

Verification on 2026-11-14: 5,582 desktop tests across 78 files pass, including
25 new diagnostic/control/receipt cases and the updated partial-projection
regressions. Frontend coverage passes 905 tests with the existing seven skips:
90.49% statements, 86.72% branches, 88.02% functions and 95.22% lines.
Frontend/desktop builds, lint and both contract exporter checks pass. Full native
smoke passes the new corruption/refresh case and prior import, practice, recovery,
export and backup flows with provider substitutes. The inspected screenshot is
`app/.build/evidence/electron-unreadable-evidence.png`; logs use the
`app/.build/evidence/diagnostics-` prefix. These checks do not prove live-provider
or packaged-installation parity. Global maintenance, private COS/large Office,
remaining repair/review and monetary reporting, existing-user data comparison and
final cutover remain open; old runnable implementations are retained.


## Explicit global task-state maintenance

`DocumentMaintenance` ports the personal service's explicit expired/orphan cleanup
to the embedded runtime. Settings exposes an explicit inspection action and a
reviewable batch of at most 100 expired stopped tasks, unfinished deletion fences
and orphaned `document:<uuid>` checkpoints / `document_tasks/<uuid>` Store
namespaces. Raw active tasks, unsupported metadata, unrelated checkpoint threads
and unrecognized namespace identities are retained. Shared source/artifact bytes,
practice databases, banks, source-repair audits and every `ai_tasks`/`ai_calls`
record remain outside this cleanup scope.

Previews are held in memory for ten minutes, with at most eight outstanding plans.
Each candidate is revalidated before admission; changed records, newly owned
orphans, empty/unknown/expired previews fail before a cleanup intent is written.
The task fingerprint ignores only its timestamp and deletion fence so the existing
explicit per-task deletion recovery can finish after interruption. It retains the
admission, run, state, outputs and execution identity. Incomplete task metadata is
never adopted to make it eligible.

An independently retained `document_maintenance` Store journal binds a request ID
to its reviewed preview and candidate fingerprints before any deletion. Each
completed item advances that journal, and a completed journal replays the original
receipt even after reopening. Checkpoint, Store or final task-commit failures leave
an explicit pending batch. A new batch is refused while one is pending; inspection
lists the saved batch and only its Continue action resumes it. Startup, polling,
inspection, backup and passive reads never continue cleanup. Unknown or invalid
journals fail without mutation. Already deleted task state can be acknowledged
safely after a kill between deletion and journal advancement.

The AI worker's existing single-instance application ownership is retained.
Cleanup requires no active document runs/initializations/deletions, ordinary
requests, exports, source repairs or provider slots. During cleanup the API rejects
other document work and the worker rejects new model/grading/Tencent/source
operations. Identical in-flight cleanup requests coalesce; competing batches fail.
Shutdown drains task-state maintenance, ordinary requests, source repairs and
exports before closing their databases. The global namespace journal is excluded
from task-prefix cleanup and from practice backups.

The settings UI does not inspect or mutate on mount. It lists candidates and
retained/skipped records, explains the irreversible task-state deletion, and
requires its confirmation button. Dirty AI settings and active operations disable
the relevant actions. A lost response clears the stale preview and directs the
user to inspect persisted progress; it never automatically replays the cleanup.
Large batches require another inspection and confirmation after each 100 items.


Verification on 2026-11-14: all 5,600 desktop tests across 79 files pass, including
18 focused global-maintenance cases and real `SIGKILL` at intent persistence,
after task deletion and after receipt persistence. Frontend coverage passes 908
tests with the existing seven skips: 90.46% statements, 86.75% branches, 88.04%
functions and 95.24% lines. Frontend/desktop builds, lint, both contract exporters
and diff checks pass. Full native smoke inspects and confirms one expired task and
one orphan, verifies unchanged banks and paid-call rows, then completes the prior
practice/grading/backup/restoration flows. The inspected screenshots are
`app/.build/evidence/electron-task-maintenance-preview.png` and
`app/.build/evidence/electron-task-maintenance.png`. Logs use the
`app/.build/evidence/maintenance-` prefix.

This verifies local cleanup and recovery with provider substitutes in isolated
profiles. Damaged usage/allocation metadata diagnostics, private COS/large Office,
remaining review/repair and monetary budgets/reporting, existing-user data
comparison, packaged installation and final cutover remain open. The old running
chains remain until complete parity acceptance; historical data and volumes have
not been removed.


## Private COS staging and larger direct Office transport

The optional private COS transport now uses `tencent-staging.ts` with the existing
Tencent credentials and bounded process-wide parser slots. It is disabled by
default and configured explicitly under AI Settings. Saving/toggling its settings
is passive; only explicit import/resume work uploads sources. Every source uses
private staging while enabled, including small inputs; failures never switch to
Base64 automatically. Local immutable sources and verified results remain the
authoritative storage.

The implementation follows the [COS V5 signing protocol](https://intl.cloud.tencent.com/zh/document/product/436/7778?lang=zh)
and the existing Python staging behavior. A frozen signature fixture is computed
with the historical Python helper. PUT signs the exact bytes' Content-MD5, size,
media type, private ACL and AES256 encryption headers, then verifies ETag. GET
signatures exist only in the outgoing Tencent request; task records, call receipts
and artifacts never persist signed input/result URLs. All operations refuse
redirects and accept only the configured COS host and deterministic
`practiq-import/<task-unit-hash>/<source-sha256>` ownership boundary. Changed
buckets/regions/transports and borrowed object identities fail without network
work or mutation of the original receipt.

A durable STAGING intent precedes PUT. An interrupted upload can be retried only
by explicit graph work and reuses the same owned object/bytes. SUBMITTING and an
independent unknown paid-call receipt precede the Tencent submit request. A lost
submission response cannot authorize another upload or submission. Concurrent
staging acknowledgements recheck the receipt before claiming paid recognition.
Known rejections/failed jobs can remove their staging object; uncertain jobs and
unvalidated results retain theirs.

Raw result ZIP and subimages must validate before successful-input deletion.
Cleanup failure retains the verified local result and its cleanup diagnostic.
Explicit resume then retries deletion without another submission, query or result
download. A deletion acknowledgement lost before its local receipt is safely
repeated for the exact owned key. Cancellation, deadlines, local corruption,
invalid-result history and configured read retries retain their existing guards.
The graph itself still runs only in LangGraph.js.

The project retains its 150 MiB maximum despite provider documentation allowing
larger inputs. Per-source limits remain 10 MiB for text/Markdown/Excel, 30 MiB for
images and 150 MiB for PDF/Word/PPT, with an additional 8 MiB Base64 cap when COS
is disabled. Existing ordered text/PDF/image splits remain bounded by their
current manifests, byte/pixel ranges and page origins. The desktop's existing
25 MiB Office source cap remains in place; opt-in COS now transports supported
Office inputs above 8 MiB directly, without discovering or bundling a converter.
Visibility-only XLSX preparation preserves its original bytes, derivative receipt
and hidden-sheet review requirements. This is not complete large-Office fidelity
acceptance: inputs beyond the desktop cap, larger Excel normalization, hidden
legacy slides and real-provider fidelity still need their remaining parity work.

The settings UI exposes only bucket, region and explicit enablement; credentials
remain OS encrypted and excluded from backups. The native worker fixture exercises
real compiled Office preparation/recognition with private PUT/DELETE substitutes,
and the native UI saves and disables the preference without provider work.
[The Tencent task API](https://cloud.tencent.com/document/api/866/139312) remains
the sole recognition endpoint; no local recognition fallback is introduced.


Verification on 2026-11-14: 5,625 desktop tests across 80 files pass, including
23 COS signature/staging/unknown-outcome/cleanup/concurrency cases, real process
kills during upload, submit and cleanup, and two additional Office graph cases.
A valid 9 MiB DOCX runs through private staging without a converter, and a hidden
XLSX retains both original bytes and its visibility-only derivative. These tests
use provider substitutes and prove transport/receipt behavior, not provider
recognition accuracy.

Frontend coverage passes 909 tests with the existing seven skips: 90.47%
statements, 86.75% branches, 88.08% functions and 95.25% lines. Frontend/desktop
builds, lint, contract exporters and diff checks pass. Full Electron smoke exercises
private COS PUT/DELETE in its bounded Office graph worker, saves/disables the
advanced preference through actual IPC/OS-encrypted settings, verifies the changed
capability limit without provider calls, and completes prior practice/recovery/
backup flows. The inspected screenshot is
`app/.build/evidence/electron-private-cos-settings.png`; logs use the
`app/.build/evidence/cos-` prefix.

Real COS/provider interoperability, complete Office fidelity, monetary budgets and
reporting, remaining review/repair and diagnostics, copy-based user-data comparison,
packaged installation and cutover remain open. Old implementations and historical
data/volumes remain in place until full acceptance.


## Monetary reservations and reporting

`app/desktop/cost-budget.ts` ports the historical `cost_budget.py` reservation
contract into the LangGraph.js SQLite Store namespace `practiq_cost_v1`. Each
admission atomically persists its call receipt, cumulative task/grading scope and
UTC-day totals. Integer micros and BigInt arithmetic preserve exact values and
ceiling estimates; task/day limits and all three provider prices require explicit
configuration. Unset prices remain absent rather than silently becoming free.
Budgets are optional and disabled by default.

Model reservations use the serialized UTF-8 request byte count and maximum output
tokens, matching the historical conservative formula. Recognition reserves known
page counts or the bounded maximum when unknown, including text and Office;
these are estimates rather than invoices. COS storage/traffic charges are not
included. A model allowance is checked before money admission and spent only
afterward, so a monetary refusal cannot consume a model-call unit. Recognition
may already have staged its private input, but no new paid recognition request is
claimed or sent when its monetary reservation fails.

Receipts bind call identity, scope, currency, prices, target and amount. Reusing
one across a UTC-day rollover returns the existing receipt; it never charges a
second day. Failures, unknown outcomes and process termination never refund a
reservation. Changing limits alone permits explicit resume without resetting
spend; changing an existing receipt's prices/target/amount is refused. Completed
provider calls retain their earlier reuse rules and do not become paid again.
Task deletion/global state cleanup leave monetary receipts and totals intact.
They remain AI state, excluded from practice backups together with credentials.

Production workers read the latest validated settings file before each new paid
request, without decrypting credentials. An old task snapshot cannot override a
newer budget policy. Missing, corrupt or unsupported saved settings block new
paid work; passive reads remain passive. A fresh unsaved profile can still open
the workspace and read the empty reservation report. Changing settings does not
automatically resume work.

AI Settings exposes optional currency, task/day limits and prices. Decimal inputs
are exact to six places, preserving blank versus explicit zero and rejecting
exponents, negatives, excess precision and unsafe ranges. Settings and opened
task diagnostics expose a separate explicit read-only report of retained day/task
totals and the last twenty receipts. Disabled budgets retain their history;
previously unestimated work is not reconstructed as a zero actual charge. A read
failure clears stale displayed data and preserves the underlying ledger.


Verification on 2026-11-14: all 5,654 desktop tests across 81 files pass,
including 27 reservation/accounting cases and two actual document-graph limit/
explicit-resume cases. Coverage includes precision, UTC rollover, idempotence,
changed prices/targets, currency conflicts, corrupt ledgers, transaction rollback,
live saved-policy changes, missing settings, provider failures/unknown results and
real `SIGKILL` after reservation and paid-call claim. Raising a limit resumes
stopped recognition/model work without repeating completed recognition or
consuming a refused model allowance.

Frontend coverage passes 926 tests with the existing seven skips: 90.51%
statements, 86.73% branches, 88.11% functions and 95.24% lines. Frontend/desktop
builds, lint, both contract exporters and diff checks pass. Complete Electron
smoke saves the budget through real IPC/OS-encrypted settings, makes one bounded
model request against a local substitute, refuses its second reservation before
claim/HTTP, and displays the retained CNY 0.000001 in Settings. It then disables
the optional budget and completes the prior practice/grading/import/backup/
restoration flows. The inspected screenshot is
`app/.build/evidence/electron-cost-budget.png`; logs use the
`app/.build/evidence/cost-` prefix.

These checks use isolated profiles and provider substitutes. Real-provider cost
accuracy, remaining review/repair and damaged-metadata diagnostics, full Office
fidelity, copy-based existing-user data comparison, packaged installation and
cutover remain open. No historical data, credential namespaces, deployment
volumes or old runnable implementations were removed in this step.


## Damaged usage and call-allocation diagnostics

Task accounting reads now isolate invalid saved token counts, call-allocation
ledgers, unit-spend records and provider job metadata. The detail projection keeps
independently valid usage, uncertain call IDs and valid recognition summaries;
corrupt entries never become zero usage. When the allocation or spend cannot be
verified, `TaskModelBudget.reserved` is explicitly null while the validated task
limit remains available. The canonical schema, generated TypeScript/Rust parity
artifacts and temporary Python reference annotation accept this nullable value;
existing numeric responses remain valid.

A damaged task exposes the existing read-only checkpoint diagnostic plus
`TASK_ACCOUNTING_UNREADABLE`. Stopped tasks appear failed, expiry retains priority,
and an active task retains pause/interrupt controls. Continue, retry, acceptance
and export are unavailable until the saved evidence can be verified. Passive
reads never repair, delete, reset spend, create operation receipts or call a
provider. An explicit detail refresh can clear the volatile diagnostic after the
original records have been restored; it does not automatically resume work.

Resume/acceptance preflight verifies accounting before committing task changes or
new operation receipts. Missing allocations with recorded work, missing or
unallocated spend, changed execution/limits, overspend and insufficient spend for
provider receipts are refused. The original uncertain paid-call guards remain in
force. Recognition summaries validate their public schema and IDs and retain only
validated fields; a damaged job cannot expose nested/private fields or hide an
independent valid summary. Database/Store outages and filesystem I/O failures still
propagate as infrastructure errors rather than becoming corruption diagnostics.

`SqliteStore.readNamespace` reads the exact spend namespace with entry/byte limits
and no silent pagination truncation. It accepts all 10,000 supported entries and
refuses an extra entry. The task-list state-filter scan now verifies accounting
as well as saved results; the existing large-history indexing shortcut remains
explicit. The UI shows unknown reservations and a partial-accounting explanation;
known token sums use exact integer addition even above the JSON safe-total range.

This does not reconstruct an unreadable primary admission record or repair an
entire unavailable database. Such evidence remains unchanged and refused where a
truthful validated detail cannot be produced.


Verification on 2026-11-14: all 5,684 desktop tests across 81 files pass,
including thirty new accounting/namespace cases. Tests cover malformed/partial/
unsafe usage, unknown-call identity retention, missing/borrowed allocations,
overspend, lost spend, changed task budgets/source identity, mixed valid/invalid
recognition summaries, active/expired lifecycle priority, mutation refusal and
explicit verified refresh. Existing process-kill recovery fixtures now persist
the same preallocation as the real document dispatcher, retaining their original
unknown-outcome and successful-call reuse assertions.

Frontend coverage passes 928 tests with the existing seven skips: 90.51%
statements, 86.74% branches, 88.11% functions and 95.24% lines. The new UI cases
check unknown reservations/disabled work and exact token sums above the safe
numeric-total range. Frontend/desktop builds, lint, both contract exporters, the
focused historical Python nullable-budget contract test and diff checks pass.

Full Electron smoke corrupts only its isolated profile's actual reparse allowance
ledger, refreshes through real IPC, checks retained valid usage, unknown reserved
count, the visible accounting warning and disabled export, then restores the
original ledger value and compares the complete original task detail. Provider
call counters remain unchanged. All earlier import/practice/grading/source-repair/
ZIP-export/backup/restoration cases still pass. The inspected screenshot is
`app/.build/evidence/electron-unreadable-accounting.png`; logs use the
`app/.build/evidence/accounting-` prefix.

These are local tests with provider substitutes. Complete remaining review/repair
and helper capacity, full Office fidelity, real-provider interoperability,
copy-based existing-user data and credential comparison, packaged installation,
CI/release acceptance and final old-runtime removal remain open. Historical data,
credentials and deployment volumes remain untouched.

## Existing-user-data and independent macOS package acceptance

Verification on 2026-11-14 used private copies of the existing Tauri profile,
never the original database for writes. `app/scripts/verify-existing-data.ts`
compares every practice table before opening, after reads/export and after a
version-4 backup/restore. All row counts and exact row digests survive, including
4 banks, 64 question rows (56 roots), 15 sessions, 144 attempts and 2 assets.
Hydrated questions, immutable session documents, attempts, learning notes, legacy
connection settings and asset bytes also match. Only transient session transport
keys/worker epochs and the current clock are excluded from the hydrated projection
comparison; their stored database rows are compared exactly. Original-profile
file hashes are unchanged after verification. Copies of schema 8, 9 and 10 are
refused without mutation. Legacy account/task files and Keychain namespaces are
not adopted, reinterpreted or deleted. AI task state and credentials are excluded
from practice backups.

The same verifier ran using the actual installed Electron Node 24.22.2 runtime
and compiled SDK outside the checkout. Its latest report is
`app/.build/evidence/existing-data-yc0mn2/report.json`. Private evidence and copied
user data stay ignored; reports contain table hashes/counts, not question content.

`app/scripts/package-electron.ts` builds a macOS app and DMG using the pinned
Electron runtime, bundled frontend, compiled TypeScript workers, PDFium, Sharp and
the locked transitive runtime dependency closure. Eleven directly used runtime
packages yield 61 installed packages; frontend and development dependencies are
not redundantly installed. Packaging retains project/upstream license notices and
source links, rejects escaping symlinks, environment files and old Python,
LibreOffice, PostgreSQL and RabbitMQ executables/source files, and verifies the
complete ad-hoc signature before publishing an owned output directory.

`app/scripts/verify-electron-package.ts` mounts the DMG read-only, copies the app
outside the checkout, unmounts it and launches the copied executable with an
isolated `--user-data-dir` and system-only PATH. It asserts packaged mode, the
sandbox/context-isolation settings, real renderer-to-worker IPC, a correct
practice answer, backup/restore, persistence after restart, all five Tencent ZIP
codecs, Sharp image work and bundled PDFium rendering. Provider calls and renderer
HTTP requests remain zero. Native file dialogs are substituted in this automated
check; actual OS dialog interaction remains an acceptance limit. Only arm64 was
verified. Local ad-hoc signing does not prove Developer ID signing or notarization.

The accepted build at
`app/.build/packages/PractiQ-0.2.2-arm64-1794606977858/` passed OS-backed encryption,
credential exclusion from backups and decryption after restarting the installed
app, using only fake test keys. Its retained full receipt is
`app/.build/evidence/electron-package-863a7d86f3c9-verified.json`.

The current clean-manifest build at
`app/.build/packages/PractiQ-0.2.2-arm64-1794609737795/` passed the independent offline
and existing-data checks. Its credential stage timed out during macOS-protected
initialization; those flags remain false in
`app/.build/evidence/electron-package-770f889e6315-1794610381810-acceptance.json`.
This is partial acceptance, not a claim that this new signature has credential
access. No plaintext fallback or automatic Keychain authorization was introduced.

The builder now stores a stable package inventory rather than npm diagnostics
containing random temporary build paths. Two consecutive clean builds have the
same application CDHash `c0502aea1c90ad3a053553a959162e4d70adf06c`, metadata hash and
runtime lock hash. The verified receipt is
`app/.build/evidence/electron-signature-reproducibility.json`; DMG byte-for-byte
reproducibility is not asserted. Both packaged runtime and complete workspace
npm audits report zero vulnerabilities in
`electron-package-audit.json` and `electron-workspace-audit.json` under the same
evidence directory. The clean build uses the same runtime lock as the audited
package.

Packaging tools pass `npm run check:packaging`. These receipts cover the recorded
builds, not later source changes. Full document/helper parity, real-provider
interoperability, native dialogs, credential access for the current signature,
CI/release/default-command cutover and old-runtime removal remain open.

## Active review semantics and successful-result human gate

The current Python reference no longer schedules new AI source-review, repair or
recheck passes. `graphs/document.py` invokes `structured_call` for PRIMARY OCR,
optional bounded CONTEXT enrichment and text fragments; `llm.import_call_allowance`
reserves four calls, or eight with context. Historical `agentReview` reports still
contribute warnings, missing-question diagnostics and review requirements during
assembly. The TypeScript `structured-call.ts`, `ocr-structures.ts`,
`text-structures.ts` and `assembly-finish.ts` preserve these active calls, bounded
corrections and historical diagnostics. The old `_gate` comment mentioning separate
figure/review/repair/recheck passes is not an additional executable pipeline to
restore. Remaining acceptance items above now describe the active implementation.

The Python `_review` node is a human decision gate. Its result phase waits under
`failurePolicy=review` when quality requires review or contains issues, even if
extraction itself succeeded. A reproduced TypeScript gap previously checked only
`status=PARTIAL`, allowing successful-but-unreviewed results to complete directly.
`DocumentTasks.finish` now checks the validated final processing quality as well.
It uses the answer-generation stage's final quality when generation was explicitly
authorized. `return_partial` and clean successful results retain their previous
completion behavior.

An explicit acceptance uses the existing `accept_partial` wire action, marks the
task complete and leaves the result status, checkpoint, source evidence, quality
flags and saved artifacts intact. Passive reads never accept or restart work;
acceptance does not run extraction or generation again. Selected retries may
finish successfully and still require human confirmation of retained warnings.

Verification on 2026-11-14: all 5,687 desktop tests across 81 files pass. The new
LangGraph runtime cases cover successful flagged results, issue-only quality,
absent optional issue lists, clean results, both policies, final generated-answer
quality, passive read immutability and idempotent acceptance without another node
invocation. Existing actual text/OCR retry fixtures now require confirmation when
successful retry results still carry review warnings; their original successful
unit reuse, artifacts and exact provider-call counts remain asserted.

The complete Electron smoke passes. A persisted successful task is shown as
waiting for review; clicking the real acceptance button completes it while result,
processing, checkpoint and usage remain identical and model counters remain zero.
Its selected-reparse child also retains the review policy and requires acceptance.
The inspected screenshot is `app/.build/evidence/electron-quality-review.png`.
Logs use the `review-gate-` prefix in the same evidence directory. Frontend and
desktop builds, packaging-tool type checks, both contract exporter checks and diff
checks pass. Frontend coverage was not repeated for this runtime-only fix; the
previous 928-test run remains the recorded UI baseline.

The package receipts in the preceding section predate this review fix; no claim
is made that those DMGs contain later source edits. New-package credential access,
actual native dialogs, real-provider interoperability, remaining Office/helper
fidelity, CI/release cutover and removal of old running chains remain open.

## Hidden PowerPoint slides without a local Office runtime

`office-slides.ts` now prepares PPTX visibility-only derivatives before Tencent
submission. It uses the presentation's declared slide IDs/relationships and the
[Open XML slide `show` attribute](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.presentation.slide.show),
preserving declaration order, original sources and all slide content. Only a
hidden slide's root visibility attribute changes; a converted UTF-16 member also
gets a matching UTF-8 encoding declaration. Already-visible files remain identical.
Foreign/nested `show` attributes do not affect visibility. This is container
metadata preparation, not local document recognition or a new model parser.

`BoundedZip.replace` now rewrites multiple selected members in one bounded pass;
the workbook caller uses the same path. Every original member is decoded and CRC
checked before publication. Unchanged members retain their exact compressed
bytes, codecs, timestamps, attributes and comments. Archive/expanded/member limits,
XML bounds, depth, declared slide count, cancellation and original source hashes
remain enforced. Presentation XML members currently have a 2 MiB decoding limit;
excess input is explicitly refused rather than silently omitting a slide.

Transitional and strict namespaces are supported. Slide identities must be unique,
relationships must resolve to unique local archive members and external/escaping
URIs are refused. Missing parts, invalid booleans, malformed XML, DTDs, macros,
excess depth/slides and corrupt siblings fail before any provider work. The
synthetic `app/fixtures/office/hidden-slides.pptx` extends the existing smoke deck
with a second hidden slide containing Chinese text and a supplied answer/formula;
it needs no Office runtime to create or test.

The Office preparation manifest is now version 2, retaining original source,
ordered declared slide parts, visibility derivative, policy and execution identity.
Its immutable receipt commits before paid recognition. Preparation and recognition
revalidate those bytes and metadata against the original; a consistently rehashed
but altered slide, order or preparation label is refused. The recognition manifest
still uses Office version 3 and binds the derivative to the owning preparation
stage. Selective reparse preserves its provenance without repeating recognition.
Old checkpoints remain fenced by their original build/execution fingerprint; no
historical checkpoint or source file is rewritten to adopt this new build.

PPTX uses the same Base64 or explicitly enabled private-COS transport as other
Office formats. Fewer returned pages than declared slides produces a partial
result and an explicit warning, retaining the original and successful OCR units.
Page counts are not a proof of recognition fidelity. Binary `.ppt` remains a direct
Tencent input with a fidelity-review warning; hidden legacy slide coverage is
still unverified. No Python, LibreOffice executable, converter preference or local
recognition fallback is introduced.

Verification on 2026-11-14: 66 targeted Office tests and all 5,716 desktop tests
across 82 files pass. Added cases compare exact modified XML and sibling compressed
bytes, multi-slide replacement, encoded booleans, namespaces, UTF-16, declaration
order, safe URI resolution, invalid relationships/XML, source integrity,
cancellation, source limits, and full graph behavior on both transports. Recovery
checks retain one visibility write across a preparation/checkpoint gap, preserve
the original during selected reparse, and reject changed content/order/type before
network work. Snapshot write failure starts neither recognition nor model work.
Build/type checks, packaging-tool checks, both contract exporter checks and diff
checks pass. Logs use the `app/.build/evidence/office-slides-` prefix.

Full Electron 45.3.1 / Node 24.22.2 smoke also passes. Its bounded worker runs the
actual compiled PPTX prepare/recognize/structure/assemble graph with private COS
substitutes, inspects the uploaded bytes for the visible hidden slide, retains the
original bytes and declared two-slide inventory, and returns the expected partial
warning when the provider substitute supplies only one page. The receipt records
one recognition submission and one model call. The existing PDF/image/DOCX/XLSX,
practice, review, credential encryption, import/export and backup/restore scenarios
still pass. Native dialogs remain substituted and no real Tencent/model endpoint
was called. The retained per-feature native report is
`app/.build/evidence/office-slides-native.json`.

Legacy `.ppt` hidden-slide fidelity, Excel inputs above Tencent's direct limit,
other desktop/helper-cap policies, real-provider interoperability, current-source
packaging/credential acceptance, CI/release cutover and removal of old runtimes
remain open. Existing user data, credentials and service volumes are untouched.

## Binary PowerPoint live-slide visibility and independent format verification

`office-legacy-slides.ts` extends the existing CFB metadata validator rather than
adding a local source recognizer. It resolves the latest `CurrentUserAtom`, the
successive user-edit/persist directories and the current document's declared slide
list, following the [Microsoft PowerPoint document-stream specification](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-ppt/1fc22d56-28f9-4818-bd45-67c2bf721ccf).
Only active slides' `SlideShowSlideInfoAtom.fHidden` bits are cleared in a copied
file. Obsolete saves, inactive records, slide content, stream sizes/offsets and
all other bytes stay unchanged. Declared order and stable slide/persist identities
are retained; an already-visible active deck stays byte-identical even when an
obsolete save still contains a hidden slide.

The allocation reader checks normal FAT and MiniFAT streams, 512/4096-byte sectors,
exact chain lengths and system/data ownership. Shared/cyclic sectors, oversized or
truncated streams, invalid record bounds, encrypted current-user headers, cyclic
user edits, invalid persist offsets and duplicate slide identities are refused.
Work remains bounded by the 25 MiB Office source cap, 100,000 metadata records and
the configured active-slide limit (at most 300). Unknown record payloads are skipped;
question text is not decoded or recognized locally. Cancellation refuses
publication and preserves the original bytes.

Binary PPT now shares the `visible_powerpoint_slides` preparation receipt,
immutable derivative validation, transport selection and recognition/assembly path
with PPTX. The version-2 Office manifest binds ordered active slide identities to
its original source, execution fingerprint and visibility-only derivative. A
preparation/checkpoint gap reuses the durable snapshot. Selected reparse keeps the
source task and preparation evidence without another recognition submission. A
provider returning fewer pages than active slides retains partial results and a
review warning. No Python, Java, LibreOffice installation or executable preference
is discovered by the application.

Two project-authored synthetic binary fixtures were generated once using Apache
POI HSLF 5.5.1 on an existing local Java 17: a two-slide Chinese deck using a normal
FAT document stream and a one-slide English deck using MiniFAT. Independently
opening the TypeScript derivatives with POI confirms every slide is visible,
with unchanged page order and exact text hashes. Every other OLE stream hash also
matches. Each complete file differs by exactly one byte with only the hidden bit
cleared. `app/fixtures/office/legacy-slides-parity.json` freezes these oracle reports,
file hashes and changed offsets. Ordinary TypeScript tests consume only the
committed fixtures/reports; neither POI nor Java becomes a dependency, CI
requirement or packaged runtime. The verification-only jars, generator and logs
remain under ignored `app/.build/evidence/legacy-ppt/`.

Verification on 2026-11-14: all 5,738 desktop tests across 83 files pass, including
the independent binary fixture comparisons, synthetic successive-edit cases,
512/4096-byte metadata containers, corrupt allocation/record cases, active slide
limits and cancellation. Both Base64/private-COS graph paths retain originals and
submit only visibility derivatives. Encrypted files are refused before provider
intents; recovery and selected-reparse tests retain one derivative write and one
recognition submission. Build and packaging-tool type checks, both contract
exporter checks and diff checks pass. Logs use the
`app/.build/evidence/legacy-ppt-` prefix.

Complete Electron 45.3.1 / Node 24.22.2 smoke also passes. The bounded worker runs
the actual compiled binary-PPT graph and verifies that the exact submitted bytes
have the independently POI-verified derivative hash. The receipt retains two
active slides, one substituted recognition submission, one substituted model call
and the expected partial warning for one returned OCR page. Existing PDF/image/
DOCX/XLSX/PPTX, practice, human-review, encrypted settings, export and backup/restore
scenarios still pass. Per-feature receipts are
`app/.build/evidence/legacy-ppt-native.json` and `legacy-ppt-acceptance.json`.
These are local/provider-substitute and independent file-format checks. They do
not establish live Tencent or model accuracy, native dialog interaction or current
package acceptance. Large Excel handling, remaining resource-pressure/helper
acceptance, real providers, current-source packaging/credential access,
CI/release cutover and removal of obsolete running chains remain open. Historical
user files, credentials, databases and deployment volumes remain untouched.

## Shared preparation capacity and abort cleanup

PDF rendering, Office visibility preparation, image splitting and production figure
crops now share one preparation slot and the existing bounded queue (64 waiting
operations). The production PDF/Office/image source getters read and copy input
bytes only after admission. Queued cancellation starts no worker and reads no
source. Each helper has an empty environment, bounded JavaScript heap, its format's
existing byte/pixel/record limits and a finite deadline. Its slot is released only
after `Worker.terminate()` has completed, including after success, cancellation,
timeout, invalid replies, exceptions and an exit without a result. Office metadata
and production image/crop work run outside the AI orchestration thread; existing
PDF/font/engine checks and calibration algorithms remain in use. Small OCR preview
validation still uses the existing bounded Sharp validator in the AI worker;
this change does not claim complete media isolation or a process-wide RSS cap.

Real blocked-worker tests exposed a LangGraph abort race: `invoke()` can reject
before its active node has finished releasing its helper. The document runtime
now drains the actual node promises before recording the stop and releasing run
ownership. Shutdown therefore keeps task/Store databases open until cleanup ends.
Soft pause still waits for the current unit and retains its completed output;
interrupt/quit abort helpers. A separately gated stage test proves task deletion
stays fenced during cleanup and a completed in-flight output remains reusable on
explicit resume. No extra provider calls or automatic recovery submissions are
introduced. Expiry still preserves completed outputs and blocks the next stage.

Verification on 2026-11-14: 5,747 desktop tests across 84 files pass, including
five helper-boundary cases, three actual LangGraph/DocumentApi worker shutdown
cases and late-node cleanup/resume. The complete Electron 45.3.1 / Node 24.22.2
smoke passes with actual compiled PDF/image/Office graphs and local provider
substitutes. Both contract exporters, packaging-tool type checks and diff checks
pass. Evidence uses the `app/.build/evidence/preparation-` prefix. These checks do
not replace current-package pressure acceptance, actual native dialogs, live
Tencent/model interoperability or final CI/release cutover. Excel above Tencent's
direct limit and removal of the old running chains remain unfinished; historical
user data and credentials are unchanged.

## Application-to-worker shutdown and installed-workflow CI

The actual Electron quit path now waits for private RPC shutdown handshakes.
Previously it started `Worker.terminate()` calls from `will-quit` without waiting,
so the document-level drain could be bypassed by the outer process. The AI worker
now refuses new requests, drains its current document work and other admitted RPC
requests, and closes task/Store/checkpoint/call databases before closing its port.
The practice worker drains its serialized writes before closing SQLite and its
port. Shutdown is idempotent; a worker that remains unresponsive is terminated
after 30 seconds, retaining durable unknown receipts and existing recovery
journals rather than claiming successful work or automatically retrying it.

Electron prevents the first quit, closes AI before practice storage, then quits
after both workers exit. This order lets returning grading results reach practice
storage. Lazy AI creation, activation and second-instance window creation are
fenced during shutdown. Closing only the window still preserves background work.
The native smoke delays each worker-close completion and checks the exact AI-then-
database sequence, so merely initiating cleanup cannot satisfy the assertion.

`electron-smoke.ts --installed /absolute/copied/PractiQ.app/Contents/MacOS/PractiQ`
reuses the full runtime/UI workflows against an app copied outside the checkout.
It asserts packaged mode, an isolated profile and system-only PATH, and resolves
all compiled runtime imports from the installed app. Its report begins incomplete
and retains successfully tested graph/practice phases before OS credential
initialization; only the full successful run sets `passed: true`. A two-minute
watchdog reports the current stage and ends only the owned test application.
Native file dialogs and providers remain substituted.

macOS CI now builds the Electron app/DMG, runs the copied-app workflows and the
independent DMG/protected-credential verifier, and retains reports/installers.
These are required steps within the existing package job and Desktop CI gate;
there is no `continue-on-error` or credential bypass. Historical Tauri/service
gates remain until final architecture cutover. The packaging type check now also
covers the full Electron smoke script.
The copied package is the first Electron application exercised on the fresh CI
runner; a development-signed app does not first create the same named Keychain
item under a different signature. Local ad-hoc rebuilds can still require fresh
Keychain consent, as described in [Electron's signing guidance](https://github.com/electron/electron/blob/main/docs/tutorial/code-signing.md#macos-apis-that-require-code-signing).

Local verification on 2026-11-14: 5,750 desktop tests across 85 files, 194 existing
CI/scope regressions, packaging type checks and complete Electron smoke pass.
Focused RPC tests exercise real blocked-worker cleanup, bounded unresponsive
shutdown, idempotent close, refusal of new work and queued SQLite writes surviving
restart; the AI worker test closes during a real loopback response and retains
its successful call record. Evidence uses `app/.build/evidence/quit-` and
`electron-runtime-smoke.json`. The first copied-package run completed compiled
document graphs and offline practice but remained pending in
`safeStorage.isAsyncEncryptionAvailable()`; that test was explicitly stopped.
That earlier signature's run remains incomplete; it is not the accepted final
package below. No remote CI result, live-provider accuracy, real native-dialog
interaction or final old-runtime removal is claimed.

The current final build at
`app/.build/packages/PractiQ-0.2.2-arm64-quit-final-20261114/` passes the complete
independent DMG installation check, including OS-backed encryption, credential
exclusion from backups and decryption after restarting the installed application.
Its DMG SHA-256 is
`8c746f26acb22891ab0b05882c58f72a5ad9c39925c6127f84539d3b7da25775`;
the receipt is
`app/.build/evidence/electron-package-8c746f26acb2-1794617056480-acceptance.json`.
Its installed Node 24.22.2 runtime also verifies private copies of all existing
schema-11 tables, projections, notes, settings and resources: 4 banks, 64 question
rows/56 roots, 15 sessions and 2 assets survive backup/restore. Original-profile
hashes remain unchanged; schema 8/9/10 copies are refused without mutation.
The detailed data report is `app/.build/evidence/existing-data-awu1u0/report.json`.

The same final application, copied outside the checkout with an isolated profile
and system-only PATH, also passes the complete installed-workflow smoke. This
covers compiled text/PDF/image/DOCX/XLSX/PPTX/binary-PPT graphs, hidden-content
derivatives, conservative proofs/crops, explicit grading, review/revisions,
source repair/quarantine, task deletion/maintenance, budget boundaries, portable
ZIPs, backup/restore and the ordered graceful worker shutdown. The full receipt
is retained in `app/.build/evidence/quit-final-installed-smoke.json`; its
`passed`, `packaged` and `gracefulWorkerShutdown` flags are true. Providers and file
dialogs remain substitutes; this closes neither live-provider fidelity nor
actual native-dialog acceptance. This build remains ad-hoc signed, without
Developer ID/notarization. Large Excel policy and final CI/release/default-command
cutover with old-runtime removal remain open.

## Primary-admission recovery and operation receipt fences

Saved task admissions now validate bounded JSON, lifecycle/target fields, safe
timestamps, retry metadata and stage containers before participating in startup
recovery or capacity accounting. Seventeen damaged-record cases, including
truncated JSON and over-limit bytes, remain visible as failed/expired task-list
entries without editing their original rows. Detail, source access and fresh
controls requiring trustworthy metadata refuse the damaged admission. Other
healthy history and pending work remain available; four corrupt running records
cannot exhaust the import queue. Provider/helper concurrency limits still apply.

This is isolation and verified-original restoration, not reconstruction from
untrusted fragments. A task lacking its original admission is not given an
invented source, zero budget, new checkpoint or replacement run. Existing source
files, operations, artifacts, checkpoints, Store allocations and paid-call receipts
remain unchanged. Restoring the exact original record makes its verified evidence
readable again. A restored pending admission becomes interrupted on recovery and
needs an explicit continuation; known unknown calls retain their identities and
are never automatically resubmitted. Practice backups still exclude AI state and
credentials. Keep original task/checkpoint/Store/provider-call evidence together
when doing offline recovery; do not reset accounting to bypass a damaged record.

Acknowledged create/resume receipts remain replayable even if the primary row
later becomes unreadable. Runtime start and interruption are bound to the
receipt's original run ID: an old interrupt cannot abort a later run, and an old
create/resume cannot launch an unrelated pending run. A matching still-pending
admission can be explicitly replayed once; a stale scheduled run does nothing.
Queued pause/interrupt now finishes without starting a model, including the
pre-initial-checkpoint gap. Compatible queued tasks receive a provider-free initial
checkpoint so they remain explicitly resumable. Active pause still finishes its
current unit; active interrupt still aborts and drains it.

Database, filesystem I/O and timeout errors propagate as infrastructure failures
instead of rewriting a valid task as corrupt. The compiled AI-worker restart
test retains its exact corrupt row, unknown paid receipt and source bytes while
recovering a separate healthy admission. Version-fence fixtures now use valid
error codes so they continue to test stale previews/source repairs separately
from primary-record corruption.

Verification on 2026-11-14: 5,779 desktop tests across 85 files pass, with 29 new
recovery/receipt cases. The focused 147 tests also pass using Electron's actual
Node 24.22.2 executable; these exercise the current compiled runtime, not an old
packaged implementation. Complete Electron smoke, both contract exporter checks,
packaging type checks and diff checks pass. Reproductions and subsequent checks
use `app/.build/evidence/primary-row-`, `receipt-replay-before.log` and
`queued-stop-before.log`. These source changes postdate the accepted
`quit-final-20261114` DMG; its earlier package/credential receipts do not certify
this later code. Current-source package/remote CI acceptance, large Excel policy,
actual native file dialogs, final cutover and old-runtime removal remain open.

The first remote draft-PR run exposed that the full desktop suite was placed on
Ubuntu even though PDF font and CoreAudio boundaries deliberately require macOS.
The complete suite now runs as a required macOS package step; Linux retains
contract, compilation, tool-type, frontend and browser checks. Runtime platform
guards are unchanged. The existing CI regression checks require the desktop
suite and both installed-package checks in that macOS job. The temporary Python
reference test also narrows a known positive reservation before comparing it,
preserving the separately tested nullable/unknown reservation contract.

## Native file dialogs and preview resource parity

On 2026-11-14 the current development Electron runtime was exercised with real
macOS open/save panels through native accessibility, without dialog substitutes.
Only fresh temporary profiles and project-authored source/ZIP fixtures were used.
Document selection remained passive; cancelling a second selection retained the
first source. Native ZIP selection imported 20 root questions (26 stored rows)
and two verified resources. A backup was saved through the native save panel.
Cancelling the replacement confirmation retained both banks; confirmed restoration
removed a subsequently added temporary bank. All practice tables and resource
bytes exactly matched the backup. The automatic recovery ZIP retained the two-bank
pre-restore state. Quitting and reopening retained one bank and 20 root questions.
AI task, document-task and paid-call tables remained empty throughout this flow.

The real interactions exposed two omissions, now covered by regressions:
cancelling the source picker cleared existing selections, and ZIP previews could
not read their verified in-memory images/audio before import. Empty picker results
now leave selection state intact. Resource reads reuse the active preview inventory
before committed assets, matching the Rust behavior. Replacing the preview revokes
its uncommitted resources; invalid hashes still fail. Preview creates no practice
rows or asset files. A second fresh profile displayed the image before confirming
import, with its empty practice database and absent asset directory checked again
after cancellation and quit.

The 5,780-test desktop suite and complete Electron smoke pass. Evidence remains
local under `app/.build/evidence/native-dialog-`: the acceptance JSON, three native
screenshots, full desktop/Electron logs and the reproduced pre-fix resource failure
(`preview-resources-before.log`). These results close the earlier native-dialog
gap; they do not certify the final DMG, live providers, large Excel compatibility,
CI/release cutover or old-runtime removal.

The current-source arm64 DMG (`41c8573ab28d…`) subsequently passed an independent
read-only DMG mount/copy, code-signature verification, isolated system-PATH launch,
offline practice, all five archive codecs, PDFium, backup/restore, restart and
protected credentials. Its receipt is
`app/.build/evidence/electron-package-41c8573ab28d-1794624670421-acceptance.json`;
all three credential flags are true. A separate copy outside the checkout also
passed the complete installed Electron workflow using the package's compiled
modules (`native-dialog-installed-smoke.log`). Providers and file-dialog results
in those automatic checks are substitutes; the real-dialog checks above are
separate development-runtime evidence. This candidate has ad-hoc signing and no
notarization; the earlier copied historical-data comparison is still separate.

The initial package check exhausted its shared 120-second allowance during the
post-restart credential phase. A per-operation trace of this same binary then
verified all three fixture keys: cold OS encryption initialization took 27.292
seconds, post-restart initialization 4.831 seconds, and encryption/decryption at
most 1 millisecond per operation. Each credential phase now refreshes the existing
120-second watchdog, independently of installation/core checks. Every phase stays
bounded and credential assertions remain mandatory. Both the failed receipt and
subsequent complete receipt are retained; no plaintext fallback, Keychain deletion
or protection bypass was used. Remote CI, consistent signing across distributed
updates, large Excel parity and final architecture cutover remain open.

## Electron entry-point cutover and listening baseline

The arm64 listening-address baseline DMG has SHA-256
`18e1e2fa83fd528a9e4abdfe4649a2f876266da6b861ed9b237297ebffd84743`.
It passed independent read-only installation, code-signature verification,
system-only PATH launch, sandbox, offline practice, archive codecs, PDFium,
backup/restore, restart and OS-encrypted credential round trips. The receipt is
`app/.build/evidence/electron-package-18e1e2fa83fd-1794632078518-acceptance.json`.
A separate `ditto` copy outside the checkout passed the complete installed
workflow (`cutover-baseline-installed-ditto.log`). The initial Node copy rewrote
framework symlinks and could not launch helpers; its failure log is retained as
`cutover-baseline-installed.log`. This was a test-copy error, not an application
timeout. Automatic provider and file-dialog results remain substitutes; this
baseline predates the renderer/default-entry cutover below and is not notarized.

`make app-dev` and `npm run desktop` now launch Electron without Python package
preparation. `make app-build` and `make app-package-check` build and verify the
same fresh Electron package directory. The renderer requires the typed Electron
preload; missing IPC fails
explicitly instead of falling back to Tauri or preview data. Import and settings
always use the embedded Node runtime. The old service-connection component and
frontend transport are removed, while their historical settings and credentials
remain untouched. Model-setting drafts block sidebar navigation and returning
to grading until saved or cancelled. Browser fixtures use the same request
envelope and never run models. The unused Tauri frontend API dependency is removed;
the historical CLI remains only until the reference packaging/release chain is retired.
The octopus image is now owned by the frontend rather than the Rust source tree.

The listening browser regression now exercises explicit address application,
removal, answer-mode changes and QR replacement, retaining all three unsaved-draft
dismissal guards and the no-network assertion. Its fix is pushed separately as
`38f3f719`. Required CI gates, final cutover-package acceptance, release tooling
and deletion of the old Rust/Python running chains are still pending.

Local cutover validation passes frontend types, lint and coverage: 913 tests,
7 existing skips, 90.28% statements and 95.10% lines. The 240-case browser run
initially passed 226 cases; fixture routing, the standalone image fixture and
retired service-URL expectations accounted for its failures. The subsequent
17-case recheck passes every affected case plus sidebar/return-to-grading draft
guards. The original log and recheck are retained as `cutover-browser.log` and
`cutover-browser-recheck.log`; this is not described as one all-green full run.
Complete development Electron smoke and the real frontend-to-SQLite session
consumer regression also pass (`cutover-electron.log`,
`cutover-native-consumer.log`). None of these checks calls a real model.

The entry-cutover DMG for `41107ef7` has SHA-256
`91ce29daaf2cd9b54f8479c725c570663c06da90bc4d8dfc6c50f105f18c1918`.
Its core installation checks pass, but OS credential initialization times out.
A second independent `ditto` copy also stops at
`safeStorage.isAsyncEncryptionAvailable()`. Native UI access and display capture
were unavailable in that session, so a Keychain approval prompt is not confirmed.
Keep `cutover-make-package.log`, `cutover-installed-electron.log`,
`cutover-installed-41107ef7-failed.json` and the hash-specific package receipt;
the latter retains false credential-verification flags. The earlier baseline's
successful credential receipts do not certify this package. No timeout was
increased, OS protection disabled, historical credentials deleted or plaintext
fallback introduced.

## TypeScript CI scope and final gates

Both workflows now bootstrap change selection and their final protected gates
with Node 22 and `.github/scripts/ci-scope.ts`. The old Python selector and its
selector-only test module are removed. The required names remain `Service CI`
and `Desktop CI`; both require a full source SHA and successful source detection.
Changes and gate jobs no longer install Python. The former service quality job
now checks embedded AI and practice on macOS/Node 24, with no PostgreSQL,
RabbitMQ, Docker or Python matrix. Its complete suite runs once in that workflow;
the desktop package job retains copied-app and installed-DMG functional checks.
App quality still checks the Python contract exporter and reference release
tools until those implementations are retired together. Release tooling and the
reference Rust/package chain remain pending.

The Node selector preserves paginated PR files, old and new rename paths, the
3000-file truncation fallback, all-commit push diffs with NUL/Unicode handling,
unavailable-base full checks, and pinned-ref/manual full checks. Every
non-documentation path now requests both embedded-AI and desktop checks;
unrecognized inputs cannot silently skip validation. Only an explicit
documentation skip permits skipped quality/package jobs. Failed, cancelled,
unexpected, missing or unresolved dependencies fail the final gate.

Twenty-one Node guard tests pass, including real temporary Git history and
executing the gate commands with outputs read from the actual workflow YAML.
They cover the stable main rules, pinned actions/source, report retention and
single ownership of frontend/backend checks. The old Python CI-specific test
module is retired; 309 retained reference release/package tests and the
maintainer-tool type check pass. An earlier 378-case run also passed before that
retirement. The backend test command now requires 90% statement, line and
function coverage and 85% branches, includes all desktop source files, and emits
JUnit, JSON, LCOV and Cobertura reports. Complete 5,833-test runs pass under both
Node 22 and Electron's embedded Node 24.22.2: 91.62% statements, 92.92% lines,
92.31% functions and 87.31% branches. Native entry processes not exercised within
the coverage runner remain in its denominator; independent Electron checks are
separate evidence.
An intentional failing-test probe confirms that JUnit and coverage files remain
available on failure and the threshold violation retains a nonzero exit. Its
fixture is removed afterward; the ignored `ci-report-probe/` receipt and logs
retain the negative result. Coverage uses `reportOnFailure` and uploads run with
`always()`; reports never convert a failed test run into a passed gate.
The already installed `js-yaml@4.3.2` is an explicit development dependency for
workflow tests; the selector itself uses only Node built-ins and needs no npm
installation. It is not added to the packaged runtime dependency set.

The embedded-Node run initially found that the SIGKILL receipt probe discarded
`ELECTRON_RUN_AS_NODE` along with inherited environment variables. Its child now
sets only that mode flag; no parent secrets or provider settings are inherited.
Both unknown/successful receipt recovery assertions pass without a timeout
increase, preserving explicit retry and no automatic paid-call replay.

The `41107ef7` remote App-quality gate passed. Its macOS full-runtime job failed
one preview-resource test after about 9 seconds on a cold host, exceeding the
test runner's default 5 seconds. That test performs two native-media preview
passes and now has a 20-second total allowance. Its no-persistence, checksum,
expired-ticket and import assertions are unchanged; each CoreAudio decode still
has the original 5-second deadline. The remote failure is separate from local
package credential initialization. New CI acceptance remains pending.

The release workflow/assembler still expects the retired Python report layout;
it must be ported to the new `embedded-ai-checks` artifacts before a release can
run. Do not treat passing component CI as completed release cutover.
## Explicit Electron installation before packaging

The Node CI run at `8c195d63` passed Embedded AI quality and App quality, but the
macOS package job failed before creating a bundle: a fresh `npm ci` had no
`node_modules/electron/dist/Electron.app`. Electron 42 and later deliberately
download their binary on demand instead of using an npm postinstall script.
The locked Electron package's `install-electron` command now runs through
`desktop:install` before every `package:electron` invocation and during
`make app-install`. No registry package lookup or alternate Electron version is
introduced. Frontend and embedded-runtime unit jobs do not need this download.

The 22 Node CI guards pass, including an actual npm invocation which verifies
installation precedes packaging, preserves output arguments with spaces, and
aborts without packaging after an installer failure. The local explicit install
and 309 retained legacy release/package regressions also pass. These checks do
not count as acceptance of the repaired remote macOS package job; that job and
the final current-source installer acceptance remain pending.

## TypeScript release tooling and native package cutover

`app/scripts/release.ts` now owns candidate validation, ordinary DMG staging,
explicit final-byte restaging and draft assembly. `bump-version.ts` updates the
single application's npm versions without resolving dependencies. Candidate
checks retain annotated tags, exact source identity, clean checkouts and main
ancestry. Staging rebuilds and compares the renderer, compiled workers/resources,
runtime lockfile, native/full versions and bounded Mach-O slices against the
selected source. Read-only snapshots, contained relative links, full-payload
fingerprints, original-candidate raw bytes, exclusive fresh outputs and final
hash checks remain mandatory. External signing/acceptance reports remain bound
declarations rather than executed verification or permission to publish.

The draft workflow now bootstraps with Node, consumes `embedded-ai-checks`,
validates nonempty successful JUnit and consistent JSON/Cobertura/LCOV coverage,
and reopens the evidence ZIP to verify every entry before handoff. It retains
all-candidate CI, source/tag checks, pinned actions, attestation verification,
draft-only publication and rejection of existing releases. Public CI evidence
redacts machine paths while preserving npm URLs and integrity hashes; the
manifest records both source and public report hashes. Release notes and
maintainer/acceptance procedures now describe one embedded-AI application.

Node packaging also preserves the former missing-license-text gate. It collects
257 installed production dependencies, including bundled frontend code, and 104
distinct text/provenance files. Supplemental sources for six previously missing
dependencies retain exact versions, registry integrity and upstream provenance.
The combined terms and content-addressed inventory are embedded and regenerated
for exact comparison during final staging. Native libvips redistribution/source
obligations remain part of human release review, not an automated legal finding.
The macOS CI package chain now builds and tests only Electron; retired Cargo,
Tauri packaging and Python resource-preparation steps no longer run there.
Python exporter/reference checks remain in App quality until their source is
removed; the historical runtime files and default service commands still need
final cleanup.

Local verification on 2026-11-14: 100 Node CI/release regressions, packaging types,
frontend/desktop production builds and 307 retained Python reference regressions
pass. A real ad-hoc DMG with SHA-256
`97f6f34f79364ae8ab44aa86eee5a05b2a0d3b1541e59760c841ca41514ee12f`
passes source-bound staging, original-byte-preserving restaging and rejection of
an altered compiled payload. That probe uses an isolated synthetic repository
and explicitly synthetic acceptance receipt; it establishes tooling behavior,
not functional or live-model acceptance. Logs and first failures remain ignored
under `app/.build/evidence/`; no private fixtures are committed.

Separately, remote run `43568999622` at `964a1d03` passed App quality, Electron
packaging, copied-app smoke and independently installed DMG credential
encryption/restart decryption. Its aggregate failed later in the now-retired
Tauri license-preparation step, so that run is not reported as green. The next
source revision must pass the updated remote gates; final-current-source manual
and live-provider acceptance and old-runtime removal remain incomplete.

## TypeScript diagnostic and reference checks

The localization source guard now parses the active TypeScript error constructors
and invariants instead of scanning Rust. Its regression first reproduced missing
translations and interpolation parameters. The fix adds localized embedded-AI
errors and preserves field/reference details and restore recovery paths/codes
without copying document text or provider secrets into diagnostics. Generic
operation errors retain their diagnostic details; summary-only views hide them.

Wire-schema and grounded-grading reference fixtures now live under `app/fixtures/`
with their original paths, source revision and byte hashes recorded in
`migration-reference.md`. Tests no longer read the Rust/Python source trees for
these inputs. The TypeScript exporter generates current TypeScript types without
rewriting the frozen references. The historical Python exporter check still
passes against its retained artifacts until that implementation is removed.

Remote App run `43572744325` at `3d79ce25` passed every required job, including
Electron packaging, copied-app workflows and installed-DMG credential recovery.
The separate Embedded AI run failed one oversized-preview test at its 15-second
deadline. Profiling found the fixture generation and native image operations
were fast; the general deep-equality assertion over a roughly 3 MB Buffer was
the expensive step. Using `Buffer.equals` preserves exact byte equality and
reduced the local four-test file from about 4.2 seconds to 0.47 seconds without
changing production code, timeouts or image assertions. Fixture-generator and
worker-loading experiments showed no gain and were reverted.

Local verification on 2026-11-14 passes 5,836 embedded-runtime tests with coverage
of 91.62% statements, 92.92% lines, 92.31% functions and 87.27% branches; 916 UI
tests pass and seven remain intentionally skipped. Frontend types/lint, packaging
types and both contract exporter checks pass. Reports remain ignored under
`app/.build/evidence/` and `coverage/`. New-head remote gates and final-source
manual/live-provider acceptance remain pending; no paid provider calls ran.

## Default Node commands and complete fixture expectations

Default `make install`, `install-locked`, `dev`, `test`, `verify`, `audit` and
`build`, plus the existing App aliases, now operate on the single Node/Electron
application. `npm run check` runs contracts, maintainer/frontend/worker types,
lint, frontend/backend coverage and release-tool regressions. Root verification
also runs CI guards and builds the production renderer. The default command no
longer launches or requires Python, Cargo, PostgreSQL, RabbitMQ or Docker. The
Tauri CLI and its platform packages are removed from the npm lockfile, and
Dependabot no longer schedules the historical Cargo/Docker build graphs.

The retired service startup/upgrade/package Make targets are removed. App CI's
remaining historical Python reference checks retain their explicit locked
bootstrap in the workflow until the reference implementation is removed; they
are not desktop install dependencies. Old data, ignored build state, credentials,
deployment files and volumes remain preserved. Existing legacy ignore patterns
are intentionally retained. The three root README languages, installation,
contribution, import/practice/data and IPC guides now describe the embedded
implementation and distinguish historical service references.

All 51 shared contract cases now also exercise parse-side normalization and
every `expectedQuestion` field formerly checked only by Python. This reproduced
two sparse-choice cases whose absent stem was `undefined` instead of the
original `null`. Parse normalization now copies only absent defaults from the
authoritative question schema, preserving explicitly supplied values and the
input object. The sample, rich-content, composite and English JSON files and
both historical/current all-mode ZIPs also run in TypeScript. The old Python
fixture/exporter checks remain passing.

Local verification on 2026-11-14: 5,893 embedded-runtime tests pass with 91.62%
statement, 92.92% line, 92.31% function and 87.28% branch coverage; 916 frontend
tests pass and seven are intentionally skipped. All 76 release-tool and 25 CI
guards pass, including actual Make dry runs and the unchanged installer-order
failure guard. Contracts, packaging types, frontend types/lint/build, npm audit
and the complete actual Electron smoke pass. Native smoke uses isolated profiles,
local provider substitutes and substituted file dialogs; it is not live-model
or clean-machine acceptance. Changed documentation links resolve locally.

Remote Embedded AI run `43575412608` at `2ffa892a` passed its coverage, audit and
protected `Service CI` gate. Its App workflow was still running when these local
changes were prepared. New-source remote/native package acceptance and removal
of the historical runtime source remain pending.

## Native IPC reference execution and interpreter bootstrap regression

`native-ipc-parity.test.ts` now executes the original bank/session sequence in
temporary Node SQLite state and compares every frozen pagination, unknown/graded
session, manual override and restore field with `app/fixtures/native-ipc.json`.
Only generated IDs/cache keys and the temporary recovery path are normalized;
no payload fields are omitted. Historical response values are retained state,
not new provider responses bypassing the current quotation/criteria validator.
The test also verifies exact legacy sidecar round trips, preservation of an
opaque historical grade-request row across backup/restore and rejection of its
target for current grading without inserting another request. This focused test
passes; current embedded AI settings intentionally replace the old connection UI.

Remote Embedded AI run `43576871701` at `93ef2c8e` passed. App run `43576871636`
failed in the reference-dependency bootstrap before any App checks: the moved
command lost the former Makefile's absolute Python-path resolution, so `uv pip`
looked for a virtual environment for the bare executable name. The workflow now
resolves the existing `python` before calling uv. A regression executes the
actual workflow shell fragment with a substitute uv, reproduces the old failure,
and verifies all three calls receive the exact interpreter path (including
spaces), locked export flags and temporary-file cleanup. All 26 CI guards pass
after the fix. No project virtual environment is created. Current-head remote
App acceptance remains pending.

After adding native IPC parity, the full local backend run passes 5,894 tests
across 90 files, with 91.65% statements, 92.95% lines, 92.35% functions and 87.42%
branches. Its JUnit and all coverage formats are retained; the earlier focused
probe is not substituted for that full report. Historical ignored artifacts and
local state remain present under both old source directories; retirement must
remove explicit tracked runtime files only, preserving their ignore files and
all unrelated contents.
