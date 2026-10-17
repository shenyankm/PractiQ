# Python source-evidence performance, October 17, 2026

The service rebuilt every source frame's text and heading while looking for each
question's already located quote. A 1,000-question typed-document profile recorded
506,499 regex matches. Source frames produced by the existing typed/CSV
parsers are ordered and disjoint, so only the frame at or immediately before the
quote's physical start can qualify.

`build_source_evidence` now records frame starts once per layout and uses the
standard-library `bisect_right` to select that candidate. It then runs the same
stem, indentation, quote-end and chunk-containment checks. Unique quote matching,
multiple-claim rejection, whole-tree/option/material-reference proofs, uncertain
layouts and incomplete-source handling remain in place. No dependency, contract,
schema, model prompt, cache or worker-concurrency change is introduced.

## Review scope and rejected alternatives

Reviewed the existing performance records and the service's saved-result export,
document merge, source evidence, duplicate detection, shared tree validation and
verified local-storage paths. This is a focused optimization of the measured
source-evidence bottleneck, not an assertion that every service line was profiled.

- `graphs/document.py` calls the shared function during ordinary final merge and
  passive completed-result projection. Their caller signatures and outputs stay
  unchanged; the latter is also exercised in the benchmark.
- Replacing `_whole_question_trees`' deep copy with a shallow copy was rejected:
  `validate_question_tree` can normalize a nested choice answer against its shared
  option owner. Protecting the caller's input requires keeping that boundary.
- `bank_export.py` revalidates serialized result/processing data before packaging.
  Keep that trust boundary, resource namespace checks, size bounds and verified
  reads. No export-validation shortcut or persistent result/media cache is added.
- Preserve account scoping, checkpoint/retry semantics, explicit model actions,
  integer accounting and durable storage publication. None is changed by this CPU
  optimization.

## Measurements

Baseline runtime: `039bce0890451c90563d0c0a455df5a92ce5c3d0`.
The benchmark loads the original `build_source_evidence` function from that local
Git revision using the existing benchmark loader, with the unchanged helpers and
same inputs used by the candidate. Only the source-evidence function is replaced
for the passive projection comparison. The report records source, function and
probe hashes.

Each workload runs three serial alternating before/after pairs, with one warmup
and seven samples per version in each pair: 21 measured samples per version and
operation. Garbage collection remains enabled. Setup, assertions and output
hashing are outside the timer. No compiler or test suite runs concurrently with
the timed benchmark. The preliminary pre-lint run is retained locally and excluded
from the final figures.

Fixtures pass `DocumentParseResult` validation and use the real chunk planner.
Cases cover 20/1,000 typed records, 20/1,000 safe CSV rows, four source units with
reused physical numbering, and absent model quotes. The passive projection case
runs the real `completed_result`, including its defensive state copy, merge,
validation, canonicalization, duplicate analysis and output construction. It reads
the text through a real `ObjectStore` using a verified artifact in a temporary
directory; only the store provider and selected baseline function are substituted.
Both versions must retain partial-result warnings/review flags and all questions.

All before/after output hashes must match, and input/state hashes must remain
unchanged. These measurements exclude database/checkpoint/worker, HTTP, extraction,
Office, queue and model latency. They do not establish an overall import speedup,
production throughput, event-loop responsiveness or lower peak RSS.

Host: Apple M4, macOS 27.0.1 arm64, CPython 3.14.7. Medians pool all 21
samples per version and operation.

| Workload | Operation | Before median | After median | Reduction |
| --- | --- | ---: | ---: | ---: |
| 20 typed questions | Source evidence | 0.3150 ms | 0.2415 ms | 23.3% |
| Same | Completed-result projection | 5.6435 ms | 5.5441 ms | 1.8% |
| 1,000 typed questions | Source evidence | 222.0088 ms | 25.5145 ms | 88.5% |
| Same | Completed-result projection | 451.9057 ms | 259.1023 ms | 42.7% |
| 20 safe CSV rows | Source evidence | 0.3509 ms | 0.2468 ms | 29.7% |
| 1,000 safe CSV rows | Source evidence | 331.7235 ms | 25.5137 ms | 92.3% |
| 1,000 questions across four source units | Source evidence | 64.8145 ms | 16.0887 ms | 75.2% |
| 1,000 questions without model quotes | Source evidence | 5.9012 ms | 5.8827 ms | 0.3% |

The small projection and missing-quote control show no useful demonstrated gain.
The small projection's preliminary median was 1.2% slower, while the final run is
1.8% faster; both differ by about 0.1 ms. No statistical significance is claimed
for these controls. Remaining work includes source normalization, tree validation,
duplicate analysis and serialization.

## Acceptance

New regressions exercise LF/CRLF, indentation, reversed model ordering, preamble
quotes, partial headings and quotes crossing record boundaries. On the baseline,
all four matching-work bounds fail with 5,350 regex matches for 100 questions;
the four invalid-quote cases already pass. The candidate passes all eight, with
no wall-clock assertion. Existing source/duplicate/chunk regressions also cover
whole nested trees, shared options, ambiguous quotes, duplicate claims, incomplete
sources, uncertain sections, safe CSV and source-unit isolation.

The focused suite passes 103 tests. The first `make verify` attempt stops before
evaluation/test execution because the selected interpreter resolves an incomplete
installed `practiq_ai` namespace. Its log is retained; the corrected run explicitly
sets `PYTHONPATH` to the current checkout's `server/src`, as in the reproduction
command, and completes with exit code 0.

| Check | Result |
| --- | --- |
| Complete `make verify` | Pass: lockfile consistency, Ruff, Pyright, 33 evaluation fixtures, coverage, recovery probes, source/wheel build and package integrity. |
| Service tests | 2,743 passed, no failures/errors/skips; 418.28 seconds. Eleven third-party deprecation warnings remain. |
| Coverage | 94.85% lines, 90.04% branches; the configured combined 90% threshold passes. |
| Fault probes | 61 pass; the four scored rates are 100%. The separate `durableCrashRecovery` aggregate remains `NOT_ASSESSED`; this is not a production recovery guarantee. |
| Package integrity | 40 source modules verified; wheel, source archive and license hashes retained in the acceptance record. |
| Paired measurements | All output hashes match; original inputs and projection state remain unchanged. All source/probe hashes match the final files. An AST comparison confirms the baseline helpers are unchanged. |
| Prior evidence | All 842 files in the prior acceptance inventory retain their hashes, including 658 PNGs. No prior record is missing or changed. |
| Diff and report links | `git diff --check` passes; local report links resolve. |

The [acceptance record](../../../server/reports/python-performance-20261017-acceptance.json)
retains command scope, coverage/probe/package results, source and log hashes, first
failure explanations and the prior-evidence preservation check. No hosted CI,
live-model, deployed-Office fidelity or production-load acceptance is claimed.

The [raw report](../../../server/reports/python-performance-20261017.json) retains
every measured sample, input/output hashes and source provenance. First failures,
the CPU profile, preliminary measurements, original probe and full validation logs
remain under `server/reports/checks/python-performance-20261017/` (ignored local
evidence). Historical performance reports and App screenshots are preserved.

## Reproduction

Use an existing Python 3.14 interpreter without a project virtual environment:

```sh
PYTHONPATH=server/src /path/to/python3.14 server/scripts/benchmark_source_evidence.py \
  --baseline 039bce0890451c90563d0c0a455df5a92ce5c3d0 \
  --output server/reports/checks/python-performance-repeat.json
PYTHONPATH="$PWD/server/src" make verify AI_PYTHON=/path/to/python3.14
```

The benchmark never loads `.env`, calls a model or connects to a database. Full
verification uses the existing disposable PostgreSQL/RabbitMQ test fixtures.
No wall-clock threshold is added to ordinary tests.
