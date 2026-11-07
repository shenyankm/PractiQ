# Twenty performance experiments — November 7, 2026

Completed **20 independent candidate experiments: 12 retained, 8 reverted**. Each candidate was measured against the previously retained state. Repeated samples, controls and the original-to-final replay do not count as extra rounds.

The working baseline was `d0d0fc40` with existing uncommitted Alipay integration and Web header changes. Those pre-existing changes were preserved during all 20 performance rounds; subsequent all-diff publication validation aligned the schema-1/2 upgrade assertions with the new payment-table allowlist and updated schema instructions. See the [manifest](../../evidence/2026-11-07-twenty-rounds/manifest.json). Work is on `refactor/performance-twenty-20261107`. No payment configuration, merchant application, deployment, schema or model work was started by this optimization run.

The retained optimization changes affect seven existing service modules: source-page/unit selection, printed-number matching, literal OCR extraction, strict JSON objects, math-source fidelity, Tencent image associations/coordinates, and immutable correction replay. No new runtime dependency, cache, API, task replay or provider call is introduced by the performance changes.

## Twenty decisions

All times are milliseconds per operation for the stated synthetic large workload. Each linked report also contains small/control workloads, all samples, process medians, source hashes and boundary outcomes. Negative reductions mean slower candidates.

| Round | Hypothesis | Before | Candidate | Reduction | Decision |
| --- | --- | ---: | ---: | ---: | --- |
| [1](../../evidence/2026-11-07-twenty-rounds/round-01.json) | Index requested pages once instead of repeated linear membership | 3.3940 | 0.1445 | 95.7% | Retained |
| [2](../../evidence/2026-11-07-twenty-rounds/round-02.json) | Select sparse chunk indexes without materializing every chunk | 0.0865 | 0.0005 | 99.4% | Retained |
| [3](../../evidence/2026-11-07-twenty-rounds/round-03.json) | Reuse target printed-number extraction in both matching passes | 1.9405 | 1.6031 | 17.4% | Retained |
| [4](../../evidence/2026-11-07-twenty-rounds/round-04.json) | Normalize a supplied boolean label once | 0.0059 | 0.0059 | 0.3% | Reverted |
| [5](../../evidence/2026-11-07-twenty-rounds/round-05.json) | Compile the repeated choice and ordering answer splitter | 0.0059 | 0.0058 | 2.0% | Reverted |
| [6](../../evidence/2026-11-07-twenty-rounds/round-06.json) | Return directly for nontext OCR scalars instead of joining empty generators | 1.7053 | 1.1267 | 33.9% | Retained |
| [7](../../evidence/2026-11-07-twenty-rounds/round-07.json) | Construct unique JSON dictionaries in C while retaining duplicate rejection | 0.0287 | 0.0137 | 52.2% | Retained |
| [8](../../evidence/2026-11-07-twenty-rounds/round-08.json) | Traverse dictionary values without allocating an intermediate list | 0.7908 | 0.7471 | 5.5% | Reverted |
| [9](../../evidence/2026-11-07-twenty-rounds/round-09.json) | Skip math token scanning when no opening delimiter can occur | 0.8264 | 0.1035 | 87.5% | Retained |
| [10](../../evidence/2026-11-07-twenty-rounds/round-10.json) | Avoid stem substring scans when a printed anchor already starts at zero | 16.1019 | 0.4029 | 97.5% | Retained |
| [11](../../evidence/2026-11-07-twenty-rounds/round-11.json) | Stop printed-anchor discovery after the earliest matching anchor | 0.4013 | 0.2088 | 48.0% | Retained |
| [12](../../evidence/2026-11-07-twenty-rounds/round-12.json) | Avoid serializing absent option passage and item material | 8.4930 | 6.5068 | 23.4% | Reverted |
| [13](../../evidence/2026-11-07-twenty-rounds/round-13.json) | Normalize stems lazily only when printed-ID matching has no anchor | 8.6243 | 8.3133 | 3.6% | Reverted |
| [14](../../evidence/2026-11-07-twenty-rounds/round-14.json) | Divide only bounding extrema while preserving nonpositive dimension behavior | 1.5575 | 1.3679 | 12.2% | Retained |
| [15](../../evidence/2026-11-07-twenty-rounds/round-15.json) | Avoid constructing a numeric-type set for every coordinate | 1.4496 | 1.2823 | 11.5% | Retained |
| [16](../../evidence/2026-11-07-twenty-rounds/round-16.json) | Compile repeated image association identifier expressions | 0.6291 | 0.4539 | 27.8% | Retained |
| [17](../../evidence/2026-11-07-twenty-rounds/round-17.json) | Deduplicate candidate context pages before selection | 1.0708 | 1.1943 | -11.5% | Reverted |
| [18](../../evidence/2026-11-07-twenty-rounds/round-18.json) | Enumerate linked pages in source order instead of sorting the set | 1.1452 | 1.4788 | -29.1% | Reverted |
| [19](../../evidence/2026-11-07-twenty-rounds/round-19.json) | Bind the output append operation once during punctuation repair | 1.0337 | 1.0598 | -2.5% | Reverted |
| [20](../../evidence/2026-11-07-twenty-rounds/round-20.json) | Copy only the last applicable edit for each question in correction history | 3.2587 | 0.0846 | 97.4% | Retained |

The criterion fixed before the rounds was at least 8% improvement in the selected large workload, at least two of three faster process pairs, equal output/boundary results, and no control regression exceeding both 10% and 0.02 ms. This is a local retention rule, not a product SLO.

- Rounds 4, 5 and 8: insufficient benefit relative to the fixed threshold.
- Round 12: the primary workload improved, but the prefix/formula control regressed, so the candidate was reverted.
- Round 13: lazy stem normalization changed rejection of malformed question content; preserving the error boundary took precedence over timing. The report retains both outcomes.
- Rounds 17, 18 and 19: context candidate deduplication/enumeration and local append binding were slower or violated the control threshold. No source-context change remains.

## Independent original-to-final replay

These are fresh isolated A/B processes after all retention decisions. Controls retained their behavior and varied by small amounts.

| Workload | Before ms | Final ms | Reduction |
| --- | ---: | ---: | ---: |
| [2,000 retained page/tile references; selected original pages](../../evidence/2026-11-07-twenty-rounds/final-pages.json) | 3.3888 | 0.1426 | 95.8% |
| [5,000 chunks; four explicit selected units](../../evidence/2026-11-07-twenty-rounds/final-active.json) | 0.0857 | 0.0005 | 99.4% |
| [1,000 target and supplied answer records](../../evidence/2026-11-07-twenty-rounds/final-matching.json) | 1.8570 | 1.5402 | 17.1% |
| [1,000 unique JSON fields](../../evidence/2026-11-07-twenty-rounds/final-objects.json) | 0.0281 | 0.0133 | 52.7% |
| [1,000 nested OCR records with nontext metadata](../../evidence/2026-11-07-twenty-rounds/final-ocr-text.json) | 1.6191 | 1.1148 | 31.1% |
| [108,000 characters without opening math delimiters](../../evidence/2026-11-07-twenty-rounds/final-formulas.json) | 0.7809 | 0.1045 | 86.6% |
| [1,000 numbered questions; first printed anchor at offset zero](../../evidence/2026-11-07-twenty-rounds/final-formula-source.json) | 15.9427 | 0.2054 | 98.7% |
| [1,000 numbered questions through OCR fidelity review](../../evidence/2026-11-07-twenty-rounds/final-review.json) | 24.7062 | 8.4164 | 65.9% |
| [1,000 Tencent polygons](../../evidence/2026-11-07-twenty-rounds/final-boxes.json) | 1.4141 | 1.2109 | 14.4% |
| [500 XML image associations](../../evidence/2026-11-07-twenty-rounds/final-images.json) | 0.5264 | 0.4320 | 17.9% |
| [500 revisions of one question](../../evidence/2026-11-07-twenty-rounds/final-corrections.json) | 3.2347 | 0.0866 | 97.3% |

The formula-source shortcut is narrow: a printed anchor at position zero makes further stem scans redundant. Prefix-containing controls retain their original scanning and fidelity behavior. Formula-rich controls retain token parsing. No gain is claimed for the unchanged context, rendered-string, association, or repair controls.

## Passive saved-result reconstruction and allocation

The [combined probe](../../evidence/2026-11-07-twenty-rounds/passive-projection.json) calls actual `completed_result` with checksum-verified temporary local artifacts, source evidence, merge and quality construction. It verifies complete output hashes and unchanged input states. This is not an HTTP, provider or end-to-end import benchmark.

| Questions | Before ms | Final ms | Reduction |
| --- | ---: | ---: | ---: |
| 20 | 6.308 | 6.209 | 1.6% |
| 1000 | 272.789 | 256.518 | 6.0% |

The 20-question difference is small and is not claimed as a stable general read-latency improvement. The 1,000-question median improves approximately 6%; raw samples remain available to assess overlap.

Sparse unit selection peak traced Python allocation is **188,944 bytes before and 496 bytes after** in each of three fresh processes. Fixture allocation is excluded; this is operation-local `tracemalloc`, not native allocation or whole-process RSS.

## Method and reproduction

- Python 3.14.7 on local Apple Silicon macOS; exact platform and interpreter are recorded in every report.
- Three serial alternating AB/BA pairs in fresh processes per comparison; one warmup and seven measured samples per process, GC enabled. No build/test suite overlaps timed measurements.
- Full coherent source-package snapshots prevent old functions from accidentally using new helper globals. Candidate patches and the full retained-source chain are saved, including rejected candidates.
- Fixture construction and output hashing are outside timers. Output hashes cover complete results; adverse-input probes compare error types/messages and existing machine codes.
- The [measurement-time probe](../../evidence/2026-11-07-twenty-rounds/probe-at-measurement.py) preserves the exact hash in the round/final-case reports. The maintained [benchmark](../../../server/scripts/benchmark_twenty_rounds.py) has only import/type/lambda-binding cleanup after measurement. The [controller](../../evidence/2026-11-07-twenty-rounds/experiment-controller.py) records the actual candidate transforms and fixed decision rule.

See [reproduction instructions](../../evidence/2026-11-07-twenty-rounds/README.md).

## Verification

- New preservation/boundary regressions: **19 passed**.
- Shared contract exporter: **passed**; 51 shared fixture cases and the sample validated by Python.
- Ruff and Pyright: **passed** before the complete gate.
- First full gate: 3,921 passed, two outdated upgrade-table assertions failed; 92% combined coverage. The [initial failure](../../evidence/2026-11-07-twenty-rounds/verify-first-attempt.txt) is retained. The assertions now require exactly the new payment table set and continue rejecting legacy import tables; 50 affected/preservation tests passed afterward. The fresh complete gate passed: **3,923 tests, seven warnings, 92% combined coverage**, all recovery probe gates, wheel/sdist build and source/lock/license archive integrity. See the [final log](../../evidence/2026-11-07-twenty-rounds/verify.txt) and [verification summary](../../evidence/2026-11-07-twenty-rounds/verification-summary.json).

- Web: 321 tests passed, one skipped, 91.59% line coverage; production build and all 65 browser tests passed.
- Locked Python runtime/development and build dependency audits: no known vulnerabilities reported.
- All 20 candidate patches replayed; removing rejected candidates exactly reproduced the final seven modules.

- PR review follow-up: CodeQL flagged a 1,024-bit ephemeral RSA test key. It now uses 2,048 bits; production credentials and performance modules are unchanged. All 19 payment tests and focused Ruff passed ([log](../../evidence/2026-11-07-twenty-rounds/payment-review-fix.txt)); the follow-up commit is revalidated by hosted CI.

## Scope and rollout limits

The changes do not bypass checksum, XML entity/association, numeric-coordinate, duplicate-field, source-answer, revision, ownership or unknown-result boundaries. Correction output and edit snapshots stay independent; all applicable earlier revisions are validated before the selected revision is returned.

No live Tencent/model request, paid transaction, production migration, deployment, hosted CI or native App acceptance was performed. App/Web implementations are unchanged by this performance run. The previously requested payment/header work is included in this all-diff publication; payment configuration stays paused. The running development service was not restarted. Parser/helper source changes may affect conservative execution signatures; retain the original deployment for unfinished imports, and use explicit documented recovery rather than changing stored signatures or replaying uncertain work.
