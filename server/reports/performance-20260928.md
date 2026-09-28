> Historical evidence: behavior, measurements and validation apply only to the dated baseline below. They are not current usage instructions or acceptance of the current release.

# Performance optimization and validation (2026-09-28)

Measurements compare baseline commit `0c3c020` with the accompanying optimization changes. The implementation follows audit priorities A1–A4 and the minimal solutions for B1–B5, plus removal of an unnecessary audio-reference scan when the asset table is empty. It adds no dependencies, changes no database version, and preserves durability and integrity checks. Full measurement data is in [performance-20260928.json](performance-20260928.json).

## Implementation

| Priority | Change | Boundary |
| --- | --- | --- |
| A1 | Reuse SQLite connections for AI task receipt lookups, import batches, draft writes, session reads, and position updates. | Expired exams still use the existing submission transaction. Migrations, temporary restore stores, and connection configuration remain intact. |
| A2 | Cache detected Office capabilities for at most five minutes, checking the preferred path, canonical path, file size, and modification time. | Manual detection and executable selection/reset force refresh; worker failure invalidates the cache. Each conversion checks the executable version in the private worker. Missing executables are not cached. |
| A3 | Build blank-answer maps only for referenced questions, stabilize callbacks, and mount answers, analysis, source details, and transcripts on first expansion. | Content still responds to answer and locale changes. Previously expanded content stays mounted to avoid repeated parsing. |
| A4 | Skip old-detail cleanup for new questions, include question kind/instructions in the main write, and reuse prepared statements within the transaction. | Editing still clears old detail types, options, and items. ID conflicts, shared options, resource write-before-reference checks, and rollback behavior remain enforced. |
| B1 | Apply existing SQL filters to candidate root trees before loading details; fetch attempted question IDs in a batch. | Preserve Unicode lowercase substring matching, short Chinese queries, complete groups, and favorite/mistake conditions on the same node. No search projection or FTS is introduced. |
| B2 | Cache one immutable session document; omit unchanged snapshots from position/save responses using `snapshotKey`, then merge them in the frontend. | Only documents with encoded size at most 8 MiB enter the cache; this is not an RSS limit. Answers, grades, and favorites are read live. Submission, completion, and expiry change the visibility key and return full snapshots. Restore clears both caches; late responses cannot repopulate the frontend cache. |
| B3 | Share pending asset requests and Blob URLs among mounted consumers; defer native image reads until near the viewport. | Release after the last consumer unmounts, with no idle asset cache. Failed reads can be retried. Rust still verifies files and SHA checksums on each initial read. |
| B4 | Cache completed task-list summaries in a 256-entry LRU and query latest checkpoint IDs in a batch. | Only completed checkpoints without pending nodes or interrupts are cached. Checkpoint/run ID or run status changes invalidate the entry; expiry is evaluated live. Active tasks and task details still load their actual state. |
| B5 | Add indexes for bank creation order, session activity order, and pending submission deadlines. | Use the existing optional-index validation so older backups remain restorable. Query plans are checked against Rust's bundled SQLite. |
| B6, partial | Skip frozen-document audio-reference scans when the asset table is empty. | Orphan-file cleanup and asset-directory validation remain active. Backup and restore locking is unchanged. |

B2 responses still contain all mutable attempt state; they are not constant-size single-question responses. Less frequent flag, self-assessment, and manual-grade operations still synchronize full sessions. Opening a large material session still incurs initial hydration work. B3 retains existing root pagination and complete material rendering without adding virtualized question groups.

## Local measurements

Environment: Apple M4, macOS 27.0, Python 3.14.7, Cargo 1.98.1, Node 22.23.2. Desktop measurements use a temporary database with 5,000 simple true/false questions and a 1,000-attempt session in a release build. Each measurement is the median of three samples and includes JSON serialization, but excludes IPC, WebView parsing, and painting. Final sampling ran without concurrent tests or builds.

| Operation | Before | After | Time reduction |
| --- | ---: | ---: | ---: |
| Write phase for 1,000 new questions | 44.70 ms | 5.47 ms | 87.8% |
| Filter favorites and search within 5,000 questions | 68.10 ms | 4.43 ms | 93.5% |
| Draft write in a 1,000-question session | 3.08 ms | 0.73 ms | 76.4% |
| Save answer and synchronize session state | 16.31 ms | 4.03 ms | 75.3% |
| P95 of 100 consecutive draft writes | 3.16 ms | 0.67 ms | 78.8% |

The insertion probe uses the shared write function inside a transaction that is rolled back; **it does not measure end-to-end ZIP import**. The previous save response contained the full session; the optimized response omits unchanged snapshots while the frontend reconstructs a complete `Session`. Native JSON decreases from **933,685 B** to **224,168 B**, a **76.0%** reduction. Position updates take a median **3.54 ms**. The final answer from the draft burst is verified after reopening the database.

A same-version connection A/B probe performs 40 import-receipt lookups: **8.78 ms** with separate connections versus **0.47 ms** with one shared connection. This isolates connection overhead, not AI network latency.

For 20 completed tasks with 1,000 synthetic questions each, repeated task-list reads decrease from a median **34.10 ms** to **0.46 ms**, with the same 6,389-byte response. **The initial cold read takes 40.64 ms**; the benefit comes from subsequent cache hits, not an equivalent improvement on first entry. Checkpoint payload totals approximately 36.7 MB. The probe neither simulates a complete checkpoint history nor compresses checkpoint contents.

Full reads and whole-session submission show no reliable improvement: reading 5,000 questions changes from 99.00 to 102.97 ms, the first 30-question page from 2.19 to 2.32 ms, and submission from 22.17 to 23.93 ms. Samples are few and timings vary; these results are retained rather than extrapolating local improvements into a whole-app speedup.

## Validation

- `make app-check`: 197 frontend and 108 Rust tests pass, along with shared contracts/fixtures, TypeScript, ESLint, formatting, and Clippy. System-keychain and manual stress tests are ignored by default; the stress test passes separately.
- `make verify`: 611 tests pass and two Windows platform checks are skipped; coverage is 92%. Lockfile checks, Ruff, Pyright, evaluation fixtures, recovery probes, and Python sdist/wheel builds pass. The new benchmark script also runs successfully and passes checks.
- Browser checks pass for bilingual interaction/layout, rich-text math/tables at 960/1280 widths, lazy image decoding, zoom, and keyboard focus. Component tests cover offscreen read avoidance, shared requests, release, and retry after failure.
- Regressions cover insert-without-follow-up-UPDATE, detail cleanup on type changes, filter isolation, older backups and optional indexes, shared options, snapshot reuse and restore invalidation, expiry refresh, checkpoint/run/expiry invalidation, and the task cache limit.
- `make app-bundle` and native `.app` builds pass. The actual packaged service passes PDF/TXT/CSV/PNG parsing, authentication, Office-upload rejection, subjective grading replay, and read-only restart checks. All model calls use a local synthetic provider. The final `.app` service executable matches the hash of the validated executable.

Real-model accuracy/latency, real LibreOffice conversion, Windows/Linux native execution, clean-machine installation, distribution signing, and notarization were not validated. LibreOffice was not found at its standard installation path on this machine. Office cache and version-protocol checks use substitutes/native logic tests and do not replace actual conversion acceptance. The `.app` build and packaged-service checks were run directly; the full `make app-package-check` wrapper and DMG packaging were not run.

## Conditional follow-up

- Splitting backup locks, choosing Stored/Deflated for media, and moving cleanup after first paint need lock-wait, compression, and cold-start measurements, plus a resource-lifetime plan before releasing locks.
- An incremental local-history index needs 1,000/10,000-manifest workloads to establish scan cost. Preserve every idempotency receipt.
- Search projections, virtualized large previews, and concurrent AI asset loading require representative large libraries or long materials; retain scoped reads and demand loading for now.
- PDF resolution, neighboring-page context, model concurrency, and external checkpoint payloads need real-document quality, budget, and recovery comparisons. Preserve synchronous durability, validation, model budgets, and the event-wakeup fallback scan.

## Reproduction

```sh
AI_PYTHON=/path/to/python3.14
make app-check AI_PYTHON="$AI_PYTHON"
make verify AI_PYTHON="$AI_PYTHON"
PRACTIQ_BENCH_OUTPUT=/tmp/desktop.json TAURI_CONFIG='{"bundle":{"resources":[]}}' \
  cargo test --release --manifest-path app/src-tauri/Cargo.toml \
  --lib performance::desktop_stress -- --ignored --nocapture
PYTHONPATH=server/src:server "$AI_PYTHON" server/scripts/benchmark_task_list.py \
  --output /tmp/task-list.json
(cd app && npm run test:browser)
make app-bundle AI_PYTHON="$AI_PYTHON"
(cd app && npm run tauri -- build --bundles app)
"$AI_PYTHON" app/scripts/check-bundle.py \
  --bundle app/src-tauri/target/release/bundle/macos/PractiQ.app/Contents/Resources/bundled
```
