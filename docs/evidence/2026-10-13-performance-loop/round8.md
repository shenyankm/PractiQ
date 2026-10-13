# Round 8: reject metadata map preallocation

Decision: reject and revert only this round's production edit. Five alternating baseline/candidate pairs preserve every output hash but confirm no performance gain. The 100,000-root count-20 preview is slower in all five pairs for both ordered and random selection. The root agent restored the saved pre-round-8 `paper.rs`, preserving the retained uniform/mixed-count and quota changes from rounds 1, 2 and 5. The rejected diff remains in [round8-candidate.patch](round8-candidate.patch).

The candidate changes only `Store::paper_candidates` in `app/src-tauri/src/paper.rs`. Its query returns metadata for the already-known root IDs, but rusqlite's mapped-row iterator has no row-count hint. Collecting its fallible results into a `HashMap` therefore grows the map incrementally. The candidate reserves `ids.len()` entries and inserts the same converted rows in the same order.

The contribution of map growth to complete preview time remains unknown. Earlier count-20 measurements in this optimization loop identified this path as a candidate; they were not the round-8 baseline or acceptance evidence. The experiment does not establish why the candidate is slower or isolate map growth from SQLite selection, recursive metadata aggregation, serialization and subsequent question hydration. No mechanism or allocation-cost saving is claimed.

The trial kept the query, row conversions, error conversions, duplicate-key replacement, missing-root rejection, signed-weight validation and subsequent removal in root-ID order identical. It introduced no API, cache, dependency, schema, data-format or user-flow change.

## Fixed workloads and correctness

The experiment reused the existing ignored `performance::paper_preview_stress` release workload unchanged. Each invocation creates disposable 10,000-root and 100,000-root SQLite banks. IDs, stems and bank timestamps are fixed; the first half of each bank contains true/false questions with a supplied `true` answer, and the second half contains short-answer questions with a supplied `Reference` answer. There are no assets or model calls.

At each scale, the benchmark measures complete native `Store::preview_paper` calls for:

- Count selection of 20 questions, ordered and fixed-seed random.
- Quota selection of 500 true/false and 500 short-answer questions, ordered and fixed-seed random.

Random selection resets fastrand seed 7 before each sample. Each workload has three raw samples. Count selection allocates 2,000 integer cents across 20 questions; quota selection allocates 100,000 cents across 1,000 questions. Both yield 100 cents per question. Existing assertions verify exact selected IDs and order, leaf count, supplied answers, scores, independently reconstructed digest and repeatability. Fixture input hashes and output hashes match across both binaries and all five pairs; each worker also checks repetition identity.

Fixture creation, expected-output reads, request decoding, assertions and report JSON serialization are outside the measured native method. These are warm synthetic data-path measurements; OS caches are not flushed. The first method call within a workload occurs after setup and expected-output reads and participates in its three-sample median. It is not a separate cold-start measurement. The workload excludes IPC, native pickers, WebView rendering and physical Android/Windows behavior and establishes no end-to-end interaction gain.

## Paired results

The retained round-7 source/binary was saved before this edit. Both versions use the same macOS arm64 release mode, toolchain, machine and probe, recorded in `environment.json`. The root agent executed five alternating AB/BA pairs serially, with no concurrent benchmark, build or test. Each value below is the median of the five workers' three-sample medians. Raw results are [round8/comparison.json](round8/comparison.json) and `round8/0-baseline.json` through `round8/4-candidate.json`; corresponding worker logs are retained.

| Roots | Selection | Order | Baseline ms | Candidate ms | Candidate slowdown |
| ---: | --- | --- | ---: | ---: | ---: |
| 10,000 | Count 20 | Ordered | 15.249 | 17.050 | 11.8% |
| 10,000 | Count 20 | Seeded random | 15.387 | 17.182 | 11.7% |
| 10,000 | Quota 500 + 500 | Ordered | 37.164 | 46.253 | 24.5% |
| 10,000 | Quota 500 + 500 | Seeded random | 39.342 | 47.557 | 20.9% |
| 100,000 | Count 20 | Ordered | 171.306 | 201.900 | 17.9% |
| 100,000 | Count 20 | Seeded random | 172.932 | 194.911 | 12.7% |
| 100,000 | Quota 500 + 500 | Ordered | 202.479 | 226.845 | 12.0% |
| 100,000 | Quota 500 + 500 | Seeded random | 208.448 | 218.340 | 4.7% |

The acceptance rule required correctness, a gain above paired variation, and no repeatable material control regression above 5%. The candidate supplies no measured gain and fails that rule. Some controls have overlapping ranges and variable pair directions; the decision does not require assigning their variation to a particular runtime mechanism.

The saved binary SHA-256 values are:

- Baseline: `45e5599de3000120c175e79daf2868b261ccdb8ce2a2e2a10b4a8faa3238418b`.
- Candidate: `c14a6d8f3fd5572695c9f68116f09dc442b3736840c4104682e81b43ca3b5a7b`.

The paired command from the repository root is:

```sh
python3 docs/evidence/2026-10-13-performance-loop/native_compare.py \
  /var/folders/1b/b19xbzjx7xqc4kl0k9x_y4y80000gp/T/practiq-perf-loop-qrdu2192/round8-baseline \
  /var/folders/1b/b19xbzjx7xqc4kl0k9x_y4y80000gp/T/practiq-perf-loop-qrdu2192/round8-candidate \
  performance::paper_preview_stress PRACTIQ_BENCH_OUTPUT \
  docs/evidence/2026-10-13-performance-loop/round8
```

The runner invokes each saved binary with `--exact --ignored --nocapture --test-threads=1` and an absolute output path. Preserve the temporary snapshots or reconstruct the recorded versions before reproduction.

## Verification and retained state

[round8-regression.log](round8-regression.log) records all seven existing `paper::tests` passing in release mode: exhaustive feasible-count/exact-selection checks, indivisible groups, future smaller-weight order, quota order/groups/scores/digest, random complete groups, score-budget reallocation and immutable snapshot metadata. The result is `7 passed; 0 failed; 0 ignored; 190 filtered out`, finishing in 0.12 seconds. Formatting and `git diff --check` passed for the candidate before execution. No implementation-mirroring test was added.

Only the round-8 production edit was rolled back; benchmark fixtures, existing regression coverage, earlier retained changes and raw evidence remain. This rejected trial creates no retained application behavior change. Broader final checks and application interaction are reported separately by the root agent.
