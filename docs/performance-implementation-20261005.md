# Performance implementation record (2026-10-05)

Baseline: `b459d6496ada503f6d5c1978c55ddb0ae74eacbf`. This change implements the confirmed hotspots in audit priority order, reusing React/Vite, Tauri/Rust, SQLite, LangGraph and local object storage. It adds no dependencies, database migrations or model-call entry points.

## Implementation scope

| Order | Hotspot | Implementation | Preserved behavior and boundaries |
| --- | --- | --- | --- |
| 1 | Question lists expand every child and repeat shared material | `questions_page` returns a 200-character summary and aggregate flags; `question_detail` loads the full tree when opening details or editing, with ancestor material retained only on its owning node | Child matches, review flags, favorites, incorrect answers, partial scores and the root's previous score retain their semantics; details preserve original hints and nulls |
| 2 | Import Web repeatedly polls full details and previews | Add authenticated GET `/api/document-tasks/{threadId}/head`; unchanged completed tasks poll only head; active tasks poll every 3 seconds and quiescent tasks every 30 seconds; hidden pages pause and focus/visibility restoration refreshes | Initial detail/preview failures remain independent; paused and review states continue reading previews; explicit actions and retries refresh; uncertain mutations are never replayed |
| 3 | Deep completed-task pagination exceeds the summary LRU capacity | Add filter-bound `nextCursor`, continuing after `(created_at, thread_id)`; Web retains cursors for visited pages | Existing offset calls remain compatible; checkpoints remain authoritative; cursor length, encoding, timestamp, UUID and filter bindings are strictly validated; no table migration |
| 4 | Available-question-count DP scans already saturated states | Return directly for unit weights; stop mixed-weight scans once every supported count is reachable | Groups remain indivisible, exact counts and backtracking remain unchanged, and the 1,000-question cap is preserved |
| 5 | Explicit `ZipInfo` entries ignore the archive compression level | Set DEFLATE level 1 on the actual entry | Preserve decompressed bytes, CRC, permissions, streaming writes and every size limit; compressed size varies by content |
| 6 | Each update to a 1,000-question session returns all mutable state | Reuse the snapshot key with a mutable-state hash; return changed rows while the frontend retains other row objects | Bound the serialized single-view cache to 8 MiB; absent/stale baselines, count/ordinal mismatches and answer-visibility changes fall back to full responses; preserve the restore epoch |
| 7 | Manual selection repeats filtering and statistics scans | Return the page and statistics through one native command; retry each independently; paper candidates initially load only IDs and weights | Preserve child/associated-content search, exact totals, filter semantics and independent errors |
| 8 | Review repeatedly scans associations and mounts all resources | Memoize question/parent/option-source maps; paginate sources, material groups, visual elements and units at 20 items per page | Preserve association order for duplicate IDs within units; every resource remains accessible; images require explicit loading, verification and blob URL cleanup |
| 9 | Every checkpoint rewrites accumulated parsed results | Atomically save successful units as checksum-addressed JSON artifacts before checkpointing references and counts; load them for merge/preview as needed | Every model attempt still has a checkpoint; legacy inline results remain readable; regressions cover pause, restart, missing/corrupt files and storage-failure retry; cross-unit conflicts remove success references to prevent failed-unit resurrection |
| 10 | PDF PNG compression consumes CPU | Use PNG level 3, falling back to the previous level 6 when per-page or aggregate byte limits are reached | Preserve 200 DPI, identical pixels, neighboring-page model input and the PDFium lock; do not reduce parsing quality |

## Measurement scope and results

Timings are medians of sequential samples on the same machine. Native stress tests use release Rust and real temporary SQLite databases. Service reads and checkpoint tests use real temporary SQLite, synthetic parsed results and fake models. ZIP/PDF tests use repository fixtures. These results do not establish Tauri IPC/WebView, HTTP transfer, physical Android or real-model latency.

| Workload | Baseline / control | After implementation | Interpretation |
| --- | --- | --- | --- |
| One root question with 999 children and 100 KB of material | 101,240,256 B / 73.82 ms | 328 B / 1.88 ms | Construction and serialization time decreases 97.5%; full material moves to on-demand details |
| One root question with 500 children and 50 KB of material | 25,670,997 B / 24.48 ms | 328 B / 1.71 ms | Preserve child aggregate flags and answerable counts |
| Available counts for 100,000 single questions | 88.67 ms | 0.038 ms | Return the same available counts from 1 through 1,000 |
| Page 25 of 602 completed tasks, clearing the LRU before each read | Offset: 501 snapshots / 119.04 ms | Cursor: 21 snapshots / 5.67 ms | Same 20 tasks; median decreases 95.2%; legacy offset retains its linear cost |
| Subsequent stable polling of a completed 1,000-question task | Detail + preview: 3,088,680 B; construction 30.75 ms, encoding 7.21 ms | Head: 232 B; construction 1.85 ms, encoding 0.005 ms | Paired reads of the same synthetic task; initial details/previews remain full; head still reads the authoritative snapshot |
| Changing position in a 1,000-question session | 224,168 B / 2.96 ms | 463 B / 3.35 ms | Transfer decreases 99.8%; native computation increases about 0.39 ms, so no end-to-end latency improvement is claimed |
| Updating one answer in a 1,000-question session | 224,168 B / 3.19 ms | 685 B / 3.15 ms | Transfer decreases 99.7%; unchanged frontend row objects retain identity |
| Statistics for a matching search over 10,000 questions | 32.09 ms | 24.84 ms | Statistics DP does less work; matching-page time is 16.22→16.39 ms and no-match time is 30.18→31.72 ms; search scan cost remains |
| Accumulated checkpoint payload, 100 pages / 1,000 questions | 283,509,575 B / 111 rows | 26,514,651 B / 111 rows | Checkpoint payload decreases 90.6%; new unit artifacts add 4,754,800 B; history is retained |
| Accumulated pending-write payload, same workload | 14,071,541 B | 9,570,231 B | Excludes model receipts in Store; this is not total deployment disk usage |
| Service ZIP containing 32 repository JPG copies | Default compression: 229.02 ms / 12,468,930 B | Level 1: 182.75 ms / 12,534,114 B | Compression time decreases 20.2%, archive size increases 0.5%; entry decompression, CRC and permissions pass verification |
| Service ZIP containing 32 repository PNG copies | Default compression: 291.14 ms / 12,178,946 B | Level 1: 181.77 ms / 11,405,826 B | This fixture reduces time 37.6%; compressed size is not guaranteed to be monotonic |
| Four-page long-material PDF at 200 DPI | PNG level 6: 516.70 ms / 6,000,288 B | Level 3: 424.95 ms / 6,254,239 B | Rendering and encoding time decreases 17.8%, image bytes increase 4.2%; pixels match across four PDF fixtures |

The new protocols and validation do not reduce bundle size. Initial static JavaScript, following static imports and excluding dynamic chunks, increases from 544,076 B to 544,588 B for the app and from 287,111 B to 288,893 B for Web. Existing content/review lazy loading remains. Response and checkpoint savings are not evidence of faster first render.

The checkpoint stress test uses in-memory fake models and artifact storage, with real temporary SQLite checkpoints. Its timings exclude artifact disk fsync, real models and durable model receipts. Actual local ObjectStore + SQLite tests cover pause, database closure/restart, missing/corrupt artifacts and model-receipt reuse. The completed 100-page result remains identical after closing/reopening the checkpointer, with no additional model calls.

Web resource regressions verify that only the current 20 entries mount initially and later pages remain accessible. Polling tests verify head-only reads for unchanged completed tasks, suspended GET requests while hidden, focus refresh and cursor reset on filter changes. Manual-selection tests verify combined statistics/page reads for new conditions and a fresh read when quickly returning to the original conditions before the pending request finishes.

Run the native measurements separately and sequentially from the repository root:

```sh
PRACTIQ_BENCH_OUTPUT=/tmp/practiq-native.json TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo test --offline --release --manifest-path app/src-tauri/Cargo.toml --lib performance::list_and_selection_stress -- --exact --ignored --nocapture --test-threads=1
PRACTIQ_BENCH_OUTPUT=/tmp/practiq-desktop.json TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo test --offline --release --manifest-path app/src-tauri/Cargo.toml --lib performance::desktop_stress -- --exact --ignored --nocapture --test-threads=1
PRACTIQ_SEARCH_PERF_OUTPUT=/tmp/practiq-search.json TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo test --offline --release --manifest-path app/src-tauri/Cargo.toml --lib store::search_tests::search_stress -- --exact --ignored --nocapture --test-threads=1
```

The standard service checkpoint benchmark is `server/scripts/benchmark_pipeline.py --output ...`. This run additionally used `/tmp/practiq-perf-20261005-pipeline.py` to count unit-artifact bytes and `/tmp/practiq-perf-20261005-read-and-export.py` for paired offset/cursor, detail/head and actual ZIP entry-writer comparisons. Detailed samples are retained at `/tmp/practiq-perf-20261005-{native,desktop-final,search,pipeline,read-and-export,pdf-levels}.json`; baseline samples are at `/tmp/practiq-audit-20261005-*`. Core values are recorded above so the conclusions do not depend on retaining temporary files indefinitely.

## Validation

| Check | Result |
| --- | --- |
| `make verify AI_PYTHON=...` | 1,722 passed, 93% service coverage; lockfile, Ruff, Pyright, offline evaluation fixtures, recovery probes and Python package builds pass |
| `make app-check AI_PYTHON=...` | Contract generation/fixtures, TypeScript, ESLint, 349 frontend tests, 172 Rust tests, fmt and Clippy pass |
| `npm --prefix app run test:coverage` | 349 passed; statements 88.66%, branches 83.68%, functions 86.25%, lines 91.82%; includes combined statistics requests and filter-reversion regressions |
| `make web-check` | 45 unit tests, 9 browser tests, TypeScript, ESLint and coverage checks pass |
| `make web-build` | Production static build passes |
| `npm --prefix app run test:browser` | 50 passed on the final source; desktop preview, rich content, 360/390 px touch layouts and production-build navigation |
| macOS package | Final app/DMG build and verification pass, with no embedded AI engines; DMG SHA-256: `5634cd66f5c3f12c0a0565d185c0337ad87f4ff992add40347434e295d061919` |
| Bundled license inventory | `app/scripts/check_licenses.py --bundle app/src-tauri/bundled --output /tmp/practiq-perf-20261005-licenses-pr-delivery.json` passes: 570 packages, no missing texts or unverified sources |

The first full service run found regressions in rehydrating cross-unit conflict results and dispatching old execution state without a source hash. Fixes in the shared loading/dispatch paths passed 56 focused cases and the full rerun. The first app browser run had 48 passes and 2 failures because older assertions treated summaries as details; reading `question_detail` passed all 50 cases. Review found that reverting manual-selection conditions before a request completed could leave an empty list; the new reproduction failed before clearing completed-request markers on condition changes and passed after the fix. The first package verification exited because its report path already existed; the old report was retained and verification passed using a fresh path. First-run failure logs remain at `/tmp/practiq-perf-20261005-*`; those runs are not described as passing.

A review-association test reproduced a collision between a special question ID and an internal unit key. Distinct-length JSON array encodings for global/unit keys fixed it; all 45 Web unit and 9 browser tests pass. Running app coverage concurrently with other checks produced 3 failures: two timeouts and one callback assertion failure. A serial rerun passed all 349 tests without increasing timeouts; the original log remains. Final service probes were checked again against the current source and report PASSED.

## PR review and CI follow-up

The first hosted runs at `f1be92f68fab6ba42fbf58f168d27a0fb8b99d2f` are retained separately: [Service quality](https://github.com/shenyankm/PractiQ/actions/runs/37283567789/job/111677091219) failed the long-material PDF byte comparison, and [macOS packaging](https://github.com/shenyankm/PractiQ/actions/runs/37283567776/job/111679645214) passed Rust tests and native compilation but failed `bundle_dmg.sh`. The latter log did not identify an underlying disk-image error; a fresh hosted package run is required before claiming macOS CI passes.

The PDF regression incorrectly assumed PNG level 3 always produces more bytes than level 6. On Linux, the long-material fixture fits the original byte limit at level 3, so no fallback is required. The corrected test accepts the bounded encoding selected by that condition, checks identical decoded pixel hashes, and uses deterministic aggregate/per-page limit faults to verify level-6 fallback. Hash-based assertions avoid dumping raw images; the original hosted assertion produced a 143,922,950-byte job log. Runtime rendering, DPI and byte limits are unchanged.

[Review](https://github.com/shenyankm/PractiQ/pull/155#discussion_r4182131649) also found that a missing local parent/option owner could resolve to another unit's duplicated ID. A regression first reproduced that wrong material. The global map now marks duplicate IDs ambiguous while retaining stage/unit lookups. The test verifies both local duplicate owners, no ambiguous cross-unit material/options, the child's own-option fallback, and a globally unique cross-unit owner.

After these corrections, local verification passes 23 focused service regressions, all 1,724 service tests with 93% coverage and recovery/package checks, 46 Web unit tests, 9 Web browser tests, and the Web production build. Failure excerpts and corrected runs are retained in `/tmp/practiq-pr155-*`. Latest hosted CI and review results are tracked on [PR #155](https://github.com/shenyankm/PractiQ/pull/155); earlier successes do not substitute for checks of its current head.

## Recovery and operational constraints

Successful unit artifacts use existing atomic writes and fsync before their checksum references enter checkpoints; reads verify checksums. Recovery requires the task/checkpoint/Store SQLite files together with the local object directory. Do not separately remove `unit-result` files referenced by checkpoints. Existing service-signature compatibility rules still decide whether tasks from older code can resume. This change retains checkpoint history, fsync, isolated workers, model budgets, authentication and storage boundaries.

Delta and task-summary caches are bounded and process-local; misses take the full path. Deltas reduce transfer and frontend object replacement but still read mutable rows for the current session, so SQLite's linear cost remains. Search and exact totals still depend on bank size. This change removes repeated scans and tree expansion; add indexes or broader caching only if real-device evidence establishes a remaining hotspot.

## Deferred until evidence supports further changes

- Lower PDF DPI or change neighboring-page input only after real-model quality evaluation; this implementation uses lossless compression.
- Reduce fsync, relax validation or delete checkpoint history only with separate crash-recovery and retention-policy evidence.
- Do not add global connection pools, generic result caches or further code splitting without a measured hotspot.
- Local checks and macOS package verification do not establish Windows/Android builds, emulator/physical-device experience, release signing, remote CI or real-AI acceptance.
