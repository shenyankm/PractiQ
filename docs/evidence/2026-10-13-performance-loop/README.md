# PractiQ performance loop — 2026-10-13

The two screenshots in this record were removed on October 17, 2026. Their paths and SHA-256 values remain in the [historical screenshot manifest](../screenshots-removed-20261017.sha256); recover the images from Git commit `6a0ea50`. Performance measurements, logs and other evidence files remain unchanged.

Production experiments stopped after eight of the authorized ten rounds. Seven scoped optimizations remain in the working tree; round 8 was rejected and reverted. Required repository checks passed. Isolated macOS interaction verified selection, practice, ZIP append, backup/restore and reopen; a CUA modal-dismissal limitation was also reproduced on the initial version. This report separates those outcomes and limitations.

The initial workspace was clean `main` at `16e47c9c69bdad410a299ef6d385bfe0beb85dee`. Applicable AGENTS.md and CONTRIBUTING.md were read; source snapshots were saved before edits. Historical reports provided leads only. Existing benchmark scripts sometimes simulate former/current strategies; their former-strategy results are not the baseline for this loop. Every retained comparison uses fresh current-source snapshots, fixed inputs and at least five alternating baseline/candidate pairs on the same machine, serialized without concurrent benchmarks, builds or tests. See [environment.json](environment.json) and [candidate ranking](candidates.md).

Only synthetic temporary databases/storage, synthetic credentials and model substitutes were used. During the optimization measurements, no user database access, data migration or cleanup, real model call, commit, push or deployment was performed. Publication is a subsequent, explicitly authorized step. Production edits add no dependency, general cache, configuration, schema or data-format change.

## Retained changes and measured scope

Values below are each round's accepted paired baseline and retained candidate, in milliseconds unless specified. They are not one aggregate original/final benchmark and must not be summed. A calculation speedup does not establish an IPC, browser or user interaction speedup.

| Round / evidence layer | Fixed workload / metric | Baseline | Retained candidate | Supported result |
| --- | --- | ---: | ---: | --- |
| [1](round1.md), release Rust calculation | 100k roots, uniform 3-leaf feasible counts | 88.781 | 0.025 | Exact uniform multiples; >99.9% calculation reduction |
| [1](round1.md), release Rust calculation | 100k roots, uniform 10-leaf feasible counts | 87.503 | 0.023 | >99.9% calculation reduction |
| [2](round2.md), release Rust calculation | 100k alternating 2/3-leaf feasible counts | 93.282 | 0.460 | >99% reduction after all possible states are populated |
| [3](round3.md), local Python merge | 1,000 rich page-question records, warm merge | 47.871 | 39.040 | 18.4% reduction; text-overlap control unchanged within noise |
| [4](round4.md), instrumented production Chromium JavaScript | Diagnostic stringify total across ten unrelated filters | 42.8 | 1.2 | Repeated work removed; calls 31 → 1 |
| [4](round4.md), production Chromium with synthetic GETs | Fresh-context task open | 831.6 | 831.6 | No reliable opening gain |
| [4](round4.md), production Chromium with synthetic GETs | Natural poll to two animation frames | 21.8 | 7.1 | Scheduling-limited observation; four pairs faster, one slightly slower |
| [5](round5.md), complete release Rust/SQLite method | 100k roots, ordered quota preview of 1,000 leaves | 311.142 | 188.398 | 39.4% complete native-method reduction |
| [6](round6.md), server local export + async heartbeat | 1,000 questions, no resources: warm maximum event-loop stall | 113.180 | 34.654 | 69.4% stall reduction; throughput gain not established |
| [6](round6.md), server local export + async heartbeat | Same bank plus one 9.44 MB PNG: warm maximum stall | 106.256 | 38.030 | 64.2% stall reduction; throughput gain not established |
| [7](round7.md), complete release Rust/SQLite method | 10k questions, 100 × 1k-question immutable snapshots, 100k attempts: warm restore | 2073.556 | 1797.628 | 13.3% complete native restore reduction |

The retained production changes are:

1. `paper.rs`: extend the existing uniform feasible-count shortcut to every positive uniform group weight, retaining exact counts and the 1,000-leaf bound.
2. `paper.rs`: bound subset-path saturation using the global smallest eligible weight, preserving later smaller groups and first-written selection paths.
3. `graphs/chunking.py`: skip content serialization used only for overlap comparisons when merging independent page results; keep deep copies, groups, sources, nulls and quality flags.
4. `web/src/App.tsx`: memoize the existing Usage component when its task object is unchanged. Fresh task reads still replace the object and update usage, budget and diagnostics; markup, fetches, auth and polling are unchanged.
5. `paper.rs`: reconstruct quota selections through Set membership in original root order instead of repeatedly locating IDs during sorting. Keep sorted quota-key validation, complete groups, deterministic random order, integer scores and digest.
6. `bank_export.py`: move existing export preparation into the already-used cancellation-safe thread helper. Preserve validation order, limits, resource ownership/checksums, ZIP permissions and cancellation joining before any archive allocation.
7. `contract.rs`: temporarily move each normalized question into the existing schema wrapper, then restore it before propagating the owned validation result. Keep the same validator, paths and subsequent validation for import, backup, editing and answer callers.

Related controls show no reliable broad gain: 100k random quota preview is 202.639 → 202.143 ms; ordered/random count-20 medians differ by 0–0.8% in the retained round-5 comparison. Export wall time is 122.379 → 114.440 ms without resources and 131.958 → 133.963 ms with the image, with mixed pair directions. Backup control is 297.151 → 300.187 ms with overlapping variation. Production filter/open timings are frame-limited and mostly unchanged. Initial JS/CSS gzip grows by 12 bytes (105,583 → 105,595), not a bundle reduction.

## Correctness and evidence

Each round document links commands, exact source or binary versions, input scales, raw samples, retained patch, controls and limitations. Native calculations use exhaustive small-subset tests, zero/999/1000/1001 boundaries and output hashes. Complete paper previews independently assert selected IDs/order, supplied answers, complete composite groups, integer scores, digest and repeatability. Page merges preserve nested independence, supplied nulls and quality/provenance output.

Production Chromium uses Vite production assets and authenticated synthetic GET routes, validates fixtures against Python contracts, and checks exact diagnostic JSON, result pagination/search, null answers and explicit refresh. Its JavaScript instrumentation is separate from uninstrumented browser timings. The React editor's initial benchmark uses jsdom and React Profiler; it is component-test evidence, not a production browser or native WebView measurement.

Server export checks identical whole ZIP bytes, manifest/questions/resource bytes, CRC, SHA-256, deduplication, ordering and 0600 entry permissions across all 60 paired samples. Repeated cancellation joins preparation; existing regressions cover cancelled ZIP writers, response cleanup, stale checkpoints and export-slot ownership. These HTTP-related correctness tests do not measure service HTTP latency.

Native restore checks all 32 application tables with typed full-row hashes immediately and after reopening, including immutable snapshot text, schema 11 and absent service settings. All 30 restore samples match. The logical database hash is not a claim of ZIP-byte identity. No validation, checksum, fsync, atomic replacement, image-write ordering, recovery or supplied-answer semantics were relaxed.

## Rejected and unsuccessful experiments

- **Round 5, first variant:** consuming `roots` with `into_iter` improved ordered quota work but the repeated count-20 control regressed 7.3% (165.520 → 177.540 ms). It was rejected. The retained variant preserves the original root-vector lifetime and borrows it. Raw results are `round5/`, `round5-control-repeat/` and the final `round5b/`; [round5a-rejected.patch](round5a-rejected.patch) preserves the rejected edit. No compiler/runtime mechanism is inferred from timing alone.
- **[Round 8](round8.md):** preallocating the existing metadata map had no confirmed gain. Complete 100k ordered count-20 preview slowed 171.306 → 201.900 ms (+17.9%); random slowed 172.932 → 194.911 ms (+12.7%). Outputs and seven paper regressions passed, but performance acceptance failed. Only this round's production edit was reverted; [round8-candidate.patch](round8-candidate.patch) and all five pairs remain.
- The initial editor invocation used the wrong working directory and failed alias resolution; the corrected app-directory run passed. The first round-4 browser attempt served stale assets and is excluded; use `round4-web-valid.json`, repaired verified `round4-assets.json` and `round4-comparison.json`. Its initial test typing/build failure was fixed before valid production runs. The first export localization fixture contained forbidden fields and is excluded. Failed logs are retained; none substitutes for accepted measurements.

## Why the loop stopped and what remains

After round 8 there is no remaining measured, localized hypothesis that justifies another production edit. The ten-round limit is a ceiling. Large total durations still need phase attribution before another cache, query or storage change is selected; they do not identify the cause or establish a safe optimization.

- Current initial task-query probes show a 265.9 ms first read for twenty 1,000-question tasks and roughly 1.1 ms warm reads. This is disposable PostgreSQL/task-API work, not HTTP latency; the cold cost still needs localization.
- The current synthetic 100-page/1,000-question parser/checkpoint probe takes 835.4 ms, including 225.6 ms accumulated checkpoint write wait. Reopened completed replay is 37.4 ms with identical output and no additional model calls. These initial whole-pipeline numbers do not establish a checkpoint-only gain or final-version latency.
- The retained-source round-8 baseline still spends roughly 171–173 ms in complete count-20 previews over 100k roots. Metadata query, allocation, hydration and serialization need separate profiling; the rejected preallocation trial supplies no safe next change.
- Initial 10k-question search probes take 27.3 ms for matching statistics and 34.1 ms for a missing term. Dense-filter and actual component interaction costs need dedicated current measurements.
- Initial editor input has 250 children and 930,164 bytes; 45 jsdom edits have median React render 3.49 ms and input-to-commit 5.23 ms. No localized editor bottleneck or actual WebView responsiveness gain was established.
- Export still has 35–38 ms median maximum scheduling stalls, affected by the GIL and timers. Restore remains about 1.8 seconds on the snapshot-heavy fixture. Image-heavy backups/restores, ZIP bank imports and full service import/export requests need separate measurements.

No total cost, response-byte reduction, Rust calculation, React test or heartbeat result is used to infer real service HTTP or native WebView performance. Windows/Android latency, real-model quality/latency/cost and distribution-package acceptance are outside these measurements. PDF pixels, source completeness and answers were not changed to obtain speedups.

## Final verification

Checks ran on the retained source after round8 rollback. Standard checks could run concurrently; all accepted performance pairs ran alone. Failed check attempts and subsequent fixes/results remain below.

| Required final check | Status / evidence |
| --- | --- |
| `make verify AI_PYTHON=<existing Python 3.14+>` | PASS — 2,118 tests, 93% combined coverage, lint/types/lock/fixtures/recovery probes/package integrity; `final-server-verify.log` and `server/reports/checks/` |
| `make app-check AI_PYTHON=<existing Python 3.14+>` | PASS — generated contracts/fixtures,390 frontend tests (one opt-in skipped),185 host Rust tests (12 opt-in ignored),fmt/Clippy; `final-app-check.log` |
| `make web-check` | PASS —70 component tests, coverage thresholds,20 Chromium fake-HTTP tests; `final-web-check.log` |
| `make web-build` | PASS —TypeScript + production Vite build; `final-web-build.log` |
| Isolated macOS/Tauri interaction with synthetic data | Data/flow checks PASS; CUA modal-dismissal limitation reproduced on initial commit — see [native-interaction.md](native-interaction.md) |
| Additional app Chromium/touch suite | PASS on complete repeat:61 tests; initial60-pass/1-fail and focused1-pass retained; `final-app-browser-repeat.log` |
| Windows / Android / distribution package verification | UNVERIFIED — no platform/package behavior change; no platform claim |

Shared server/web/app boundaries, account authorization and integer billing, idempotency/recoverability, checksum validation, immutable content/snapshots, schema 11/v4 and service-settings sidecar rules remain the constraints for all retained edits. Final limitations must remain explicit even when repository checks pass.

Final-check repairs: server Ruff import grouping and the new ContentBlock test typing were corrected; the benchmark assertion now uses checked_div for Clippy. These affect tests/instrumentation only. The first app browser suite timed out locating an editor button after a dismiss; the focused test and complete61-test repeat passed without changing production code. Failure trace/context and logs are retained; the failure screenshot is available only in Git history as described above. An initial focused command used the wrong working directory and is excluded.

Native modal-dismissal limitation: the original commit was separately archived and built with another absent QA identifier; the same reading popup remained visible after Close/Escape. This reproduces the observation before the optimization changes, but does not establish its cause. See `native-ui-baseline-observation.json`. Both QA apps were closed; their synthetic data, archives and recovery copies were preserved. No further production edit was made.
