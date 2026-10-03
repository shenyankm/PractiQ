# Performance implementation and validation (2026-10-03)

This work implements the source audit against baseline `b3fef87`. The scope includes
issues #103–#109 and the additional desktop/service read, transport and rendering
hotspots found in the October 3 audit. It preserves SQLite schema 11, immutable
practice snapshots, resource checksums, recovery, strict service inputs, explicit
model-call actions and synchronous durability.

## Scope and evidence ledger

The table is a completion ledger. An implementation is complete only after its
behavioral regression and relevant performance measurement have passed.

| Workstream | Required behavior and effect | Status / evidence |
| --- | --- | --- |
| Service queries | Use existing task-order and active-run indexes without scanning all historical tasks before a small page or capacity check. Preserve supported formats and every run identity. | Implemented; SQL plans, capacity rollback and startup recovery tests passed. |
| State-filtered history (#109) | Narrow candidates before loading checkpoints; repeated sparse filters over more than 256 completed tasks must not reload all of them. Preserve lifecycle, expiry and pagination. | Implemented; 600-task regression and repeated-page benchmark passed. |
| Grading verification (#108) | Validate the raw digest and images off the event loop once per immutable input; retain admission during cancellation and all rejection rules. | Implemented; 44 focused tests, including asyncio and AnyIO cancellation, passed. |
| Session transport (#106) | Transfer shared materials/options/context once, preserving native answer and transcript hiding. Cover first open, increments, submission and review without changing frozen storage. | Implemented; native roundtrip/privacy and frontend reconstruction tests passed; release response reduced by 99.2%. |
| Incremental session responses | Reuse the existing snapshot key for flags, self-assessment, manual grading and AI grading. Visibility changes still invalidate it. | Implemented; four mutation and AI protocol tests passed. Native and frontend keys also invalidate on restore. |
| Search and statistics (#105) | Match a lightweight projection, hydrate only returned/explicitly selected roots, preserve Unicode substring and group/filter semantics. | Implemented; 7 regressions and 10k-question release comparison passed. |
| Listening persistence | Reuse the existing immutable document cache instead of parsing the entire SQLite JSON snapshot every second. | Implemented; playback identity, deadline, limits and cache reuse tests passed; 100 cached lookups take 0.0081 ms. |
| Local import history | Avoid repeated full-manifest scans for a small list/individual task; retain durable receipts and rebuild lookup state after restart or deletion. | Implemented; 14 focused tests passed, including post-rename fsync failure reconciliation. |
| Office conversion | Hash the immutable source once per conversion, keeping every output checksum and isolated worker behavior. | Implemented; 8 focused tests passed. The single source hash is outside the output loop. |
| Import review (#103) | Bound both mounted units and large composite children; index associations and retain source, shared-option and next-review navigation. | Implemented; 100-unit and 1000-node regressions and the complete browser gate passed. |
| Answer card (#104) | Preserve navigation/button identity across question changes, bound its height and keep keyboard navigation and submission reachable. | Implemented; 1000-button identity tests and Chromium checks at 960/1280px passed. |
| Task polling | Pause hidden list reads, reduce terminal-filter polling and refresh when returning; preserve discovery and required active-work updates. | Implemented; active list interval 2s, quiescent list 15s; hidden/import tabs do not read lists. |
| Exam score preview | Page score inputs and mount advanced selection on demand while retaining every score and total validation. | Implemented; 30 mounted inputs, full 1000 scores retained across pages and submitted correctly. |
| Audio resources | Delay full native audio reads until needed; retain shared requests, release, retry and exam playback restrictions. | Implemented; 6 lazy resource tests and existing listening/asset tests passed. |
| Asset cleanup (#107) | Skip historical audio scans for image-only libraries while preserving assets referenced only by frozen history. | Implemented; image-only and snapshot-only audio lifecycle regression passed. |
| Backup/restore | Stream historical snapshot validation and compare media compression time/size without weakening rollback, integrity or resource lifetime. | Implemented; 6 recovery/integrity tests and the 100k-attempt workload passed. See archive-size tradeoff below. |
| Extractor startup | Load only the required format extractor inside each isolated process; preserve packaged-format support. | Implemented; CSV/image module-isolation tests passed. |
| Import validation | Perform per-question normalization/schema checks once and preserve precise failure context and relational validation. | Implemented; precise invalid-question context and normalization equivalence test passed. |
| Vision/model preprocessing | Measure real fixture page-image read/encoding/context costs and safely reuse verified execution-local data. Compare unchanged model inputs and recovery; resolution/context changes need separate quality evidence. | Implemented; bounded execution-local cache, shared-read cancellation, checksum, cleanup and replay regressions passed. Exact provider image inputs preserved. |

## Validation boundaries

Use the existing Python 3.14 interpreter, with no project virtual environment.
Focused tests use disposable databases, temporary files and model substitutes.
Production bundle checks must validate the final generated Python/Office resources.
SQL, release Rust, React/jsdom and browser measurements describe their own layer;
none is interchangeable with native WebView latency or live-model quality.

Required final gates are `make verify`, `make app-check`, frontend coverage,
`npm --prefix app run test:browser`, the affected Office/process tests and
`make app-package-check`. Outcomes and retained failure artifacts are recorded
below. Hosted CI, distribution signing, clean-machine installation and untested
target platforms remain separate evidence.

## Results

The final source passed all required local gates:

| Gate | Outcome |
| --- | --- |
| `make verify AI_PYTHON=...` | Passed: lock consistency, Ruff, Pyright, 30 evaluation fixtures, 881 tests, recovery probes and wheel/source package build. Two platform tests skipped; service coverage 93%, above the unchanged 90% threshold. |
| `make app-check AI_PYTHON=...` | Passed: shared contracts/fixtures, TypeScript, ESLint, 256 frontend tests, 155 Rust tests and Clippy. Seven tests are ignored by default: all four release benchmarks ran separately, the restore subprocess entry point is exercised by its parent test, and the native-credential/512 MiB backup-boundary probes were not rerun. |
| `npm --prefix app run check:ui` | Passed: 256 tests; statements 82.87%, branches 78.87%, functions 79.96%, lines 88.53%. Coverage thresholds unchanged. |
| `npm --prefix app run test:browser` | Passed: 15 Chromium tests in 40.5s, including 960/1280×640 answer-card scale checks. Final machine result and screenshots retained; stdout was not redirected. |
| `make app-package-check AI_PYTHON=...` | Passed: final arm64 macOS application and DMG built; packaged service parsed all four supported formats, rejected removed formats, replayed grading and reopened four tasks without extra provider calls. Office passed eight conversion combinations in both writable and read-only relocated resources; fingerprints remained unchanged and the bundled LibreOffice signature verified. All provider calls used the local synthetic stub; Office made zero model calls. |

Earlier attempts exposed an import-tab polling assertion that needed to follow the
new visible-tab behavior, a restore assertion that needed to expect a fresh
snapshot key, Rust formatting/test-module placement errors, and a browser fixture
that returned the same mutated object rather than independent IPC responses.
These were corrected and their failure logs/traces retained. An overlapping
coverage run also exceeded the original large-DOM test timeout; the focused
1000-button structural test now has an explicit 15s budget, while its assertions
and project coverage thresholds remain intact. The final coverage run was
sequential. Dependency deprecation warnings in the service suite remain recorded.

Measurements use this Mac's Apple M4, warm filesystem caches where indicated and
temporary databases. Timings describe the named layer. The search comparison uses
an isolated baseline checkout plus the search patch; the filter comparison embeds
the previous recursive algorithm against the same current unfiltered backend to
isolate that algorithm's cost.

| Workload | Before | After | Scope |
| --- | ---: | ---: | --- |
| Search, 10k questions, first 30 matches | 145.85 ms | 18.16 ms | Release Rust; response size unchanged. |
| Search statistics, same 10k questions | 157.34 ms | 37.29 ms | Release Rust; all matching roots counted. |
| Search with no matches, same 10k questions | 142.38 ms | 36.22 ms | Release Rust. |
| Session wire, 1000 children sharing 100 KB material | 101,364,828 bytes | 813,541 bytes | Expanded vs production pooled representation in the same checkout; roundtrip equal. |
| Same session, construction + serialization | 57.97 ms | 23.11 ms | Five release samples; excludes IPC and WebView. |
| Same workload, maximum process RSS | 686,096,384 bytes | 67,518,464 bytes | Separate processes using macOS `time -l`; compact also runs additional fixtures. |
| Listening parent lookup, 100 reads | 80.91 ms | 0.0081 ms | Old SQLite JSON query vs borrowing the immutable cache; excludes persistence. |
| Import validation, 1000 questions / 822,070 bytes | 20.18 ms | 12.42 ms | Seven release samples, same parse plus/minus the removed validation pass. |
| Active filter, 600 completed + 1 active task | 150.836 ms / 601 snapshots | 0.914 ms / 1 snapshot | Three repeated reads, same returned page. |
| Paused filter, same history without paused work | 150.552 ms / 601 snapshots | 0.749 ms / 0 snapshots | Three repeated reads. |
| Completed first page, same history | 100 snapshots | 21 snapshots | Repeat reads require zero extra loads. |
| Grading, 3000×2000 synthetic PNG | 78.70 ms | 52.43 ms | Inner payload verification and image-message assembly; no provider call. |
| Grading maximum heartbeat gap, median of five runs | 80.47 ms | 37.54 ms | Threading reduces blocking; CPython's GIL still causes delays. |
| Metadata for 20 tasks among 10k receipts | 190.256 ms | 0.278 ms | Release equivalent file probe; cold index rebuild still costs 193.224 ms. |
| Audio-reference query, image-only 100k historical questions | 26.584 ms | 0.002 ms guard | Bundled SQLite 3.50.2, seven samples; excludes the rest of asset cleanup. |
| Hash 25 MiB Office source for 100 outputs | 4435 ms | 45.6 ms | Isolated SHA-256 probe; excludes LibreOffice conversion. |
| ZIP 32 JPG fixture copies | 152.9 ms | 74.0 ms | In-memory compression probe; level 1 archive is 6.6% larger. |
| ZIP 32 PNG fixture copies | 173.9 ms | 86.1 ms | In-memory compression probe; level 1 archive is 6.0% larger. |
| Backup, 100k attempts | 404.95 ms / 4,396,848 bytes | 298.01 ms / 5,634,935 bytes | Production backup path; 26.4% less time, 28.2% larger archive. |
| Restore, same workload | 2160.73 ms | 1983.16 ms | All 100k attempts survive reopening; no durability/locking change. |
| Cold CSV extractor | 76.79 ms / 46.12 MiB RSS | 55.70 ms / 34.53 MiB RSS | Three subprocess samples: module import, fixture read and extraction; excludes Python startup/protocol/cleanup. Old eager imports reproduced in current code. |
| Cold PNG extractor | 80.67 ms / 46.98 MiB RSS | 70.82 ms / 39.63 MiB RSS | Same scope as CSV; PDFium no longer loaded. |
| Structured schema preparation per call | 3.409 ms | 0.126 ms | Cached schema still copied before provider adapters can mutate it. |
| Cross-page table fixture read + encode | 1.544 ms / 4 reads | 1.060 ms / 2 reads | Exact same source image URLs. |
| Four-page material fixture read + encode | 21.137 ms / 10 reads | 16.135 ms / 7 reads | 8 MiB cache evicts pages; image URLs identical. |

Flag, self-assessment, manual-score and AI-score responses for the shared workload
are 213,158–213,370 bytes without snapshots. These responses retain the full attempt
state; the optimization only omits already-known immutable content. The actual new
listening `state` operation takes 30.87 ms for 100 calls, including SQLite work,
so the lookup result must not be interpreted as whole-operation latency.

React/jsdom score-editor probes show 1000 score inputs reduced to 30 mounted inputs,
mount time 126.8 to 16.2 ms and median single-key update 21.5 to 5.1 ms. These are
development-mode directional measurements with mocked native APIs. Chromium at
960×640 and 1280×640 verified a 288 px answer-card region, submission at 461.5 px,
retained button identity and keyboard navigation. The finish button is reachable
through normal page scrolling, keyboard confirmation and cancellation return
focus to it; these are browser checks, not native WebView acceptance.

The actual App callback is also stable across busy and position updates. An App
regression verifies zero unchanged answer-button renders after failed navigation,
two renders after successful navigation, retryable completion and a single finish
notification. This catches the parent inline callback that a standalone component
test with stable callback props would miss.

The standalone-question workload shows no meaningful first-open improvement:
1000 independent questions still produce 933,766 bytes and take about 10–11 ms.
Unsearched pagination remains about 3.15 ms and submission about 31 ms. Shared
content, search and historical read paths are the measured improvements; unrelated
operations are not claimed to be faster. Compression level 1 is an explicit time
versus archive-size tradeoff rather than a universal win.

Single-page preprocessing has no reuse benefit: the text-layer fixture takes
0.481 to 0.601 ms and scanned fixture 0.489 to 0.504 ms. All original samples,
including these small regressions, are retained. The cache improves overlapping
page context rather than PDF rendering or model inference.

## Remaining ceilings

Lifecycle SQL relies on admission inserting a pending run before graph execution,
synchronous checkpoint durability and startup reconciliation before accepting API
requests. Checkpoints still decide final classification. Only quiescent completed
summaries are reused, with checkpoint/run invalidation and a 256-entry LRU. No-run
pause/review checkpoints remain eligible. Ambiguous paused/review candidates and
deep filtered offsets can still scan; no persistent lifecycle field was added.

The first local receipt lookup rebuilds an ID index from the original durable
manifests. Batch history still scans. Backup retains its resource lifetime lock;
restore validates one historical snapshot at a time. Large answer cards retain
1000 buttons so keyboard access stays complete, but preserve them across question
changes; the material sibling navigator mounts only 30 children.

Listening uses an already-cached matching immutable session document. When the
native 8 MiB cache has no matching entry, including larger documents, playback
keeps the original SQL selector and parses only the target question. It does not
replace the cache ceiling with an unbounded per-tick full-document parse.

PDF rendering stays at 200 DPI, with the same neighboring-page context and exact
image bytes. Completed page-cache entries retain at most 8 MiB of raw plus encoded
payload; this excludes in-flight tasks, active model messages and Python object
overhead, so it is not an RSS limit. Oversized pages remain verified and uncached.
This page cache is neither checkpointed nor shared between executions; the static
schema cache is reused across executions. File and ancestor directory fsync remain
unchanged.
Checkpoint externalization and quality-changing image/context reductions require
a separate recovery/GC design or real-model quality evidence.

The disposable checkpoint probe repeats one real fixture page image, with
synthetic question responses, a substitute extractor and an in-memory
`FakeObjectStore`; SQLite persists the checkpoints. At 100 pages / 1000 questions
it writes 111 checkpoints totaling 283,466,321 bytes plus 14,071,730 bytes of pending
writes. Synthetic graph execution takes 1266.89 ms, excluding PDF rendering, real
file persistence and model network time. Accumulated checkpoint-write await time
is 781.70 ms and can overlap node work, so it is not an attribution percentage.
Reopening and replaying the completed task takes 7.26 ms, produces identical output
and makes zero new model calls; this does not establish mid-execution crash
recovery. The probe identifies a remaining storage cost; no checkpoint offloading
or durability reduction was introduced.

## Reproduction and retained artifacts

Run from the repository root using the installed Python 3.14+ interpreter, with
no project virtual environment. Replace `/path/to/python3.14` below with that
interpreter. These scripts create disposable state and make no provider calls.

```sh
PYTHONPATH=server/src:server /path/to/python3.14 server/scripts/benchmark_task_list.py --output server/reports/checks/performance-task-list.json
PYTHONPATH=server/src:server /path/to/python3.14 server/scripts/benchmark_grading.py --output server/reports/checks/performance-grading.json
PYTHONPATH=server/src:server /path/to/python3.14 server/scripts/benchmark_pipeline.py --output server/reports/checks/performance-pipeline.json
PRACTIQ_BENCH_OUTPUT="$PWD/server/reports/checks/performance-shared-expanded.json" PRACTIQ_SHARED_MODE=expanded TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo test --release --locked --manifest-path app/src-tauri/Cargo.toml --lib shared_snapshot_stress -- --ignored --nocapture
PRACTIQ_BENCH_OUTPUT="$PWD/server/reports/checks/performance-shared-compact.json" PRACTIQ_SHARED_MODE=compact TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo test --release --locked --manifest-path app/src-tauri/Cargo.toml --lib shared_snapshot_stress -- --ignored --nocapture
PRACTIQ_SEARCH_PERF_OUTPUT="$PWD/server/reports/checks/performance-search.json" TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo test --release --locked --manifest-path app/src-tauri/Cargo.toml --lib search_stress -- --ignored --nocapture
PRACTIQ_BENCH_OUTPUT="$PWD/server/reports/checks/performance-desktop.json" TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo test --release --locked --manifest-path app/src-tauri/Cargo.toml --lib desktop_stress -- --ignored --nocapture
PRACTIQ_BENCH_OUTPUT="$PWD/server/reports/checks/performance-import-validation.json" TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo test --release --locked --manifest-path app/src-tauri/Cargo.toml --lib import_validation_performance -- --ignored --nocapture
```

For uncontended measurements, run probes sequentially after compilation and
separately from test/build jobs. For macOS RSS, run each shared mode in a separate
test-binary process with `/usr/bin/time -l`; cargo's own peak memory is not the
test process's peak memory.

The final JSON reports and gate logs are retained locally under
`server/reports/checks/performance-*-20261003.*`. Failed gate attempts are retained
alongside successful reruns. Chromium scale screenshots and JSON are under
`app/test-results/browser/check-preview.mjs-performa-*/answer-card-scale.*`.
Copies of the final scale artifacts and the failed browser traces also live in
the dated reports. `performance-verified-source-20261003.json` records SHA-256
digests for the 51 changed source/test files at verification time; later changes
to this ledger do not change that executable-source snapshot. All 51 digests still
matched after the final package gate. Packaged service and Office results are
`performance-packaged-service-20261003.json` and
`performance-packaged-office-20261003.json`; application-executable and DMG hashes
are in `performance-package-artifacts-20261003.json`. The generated artifacts are
`app/src-tauri/target/release/bundle/macos/PractiQ.app` and
`app/src-tauri/target/release/bundle/dmg/PractiQ_0.1.0_aarch64.dmg`. They establish
this machine's package checks, not distribution signing, notarization or a
clean-machine/native-WebView acceptance run.
The frontend score report is explicitly a small set of development/jsdom
observations rather than a controlled benchmark. These ignored report files are
local artifacts; the runnable probes and this ledger are source changes.
