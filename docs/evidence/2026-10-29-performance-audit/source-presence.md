# Source-presence planning

Baseline: `2099f77a`. The review traced `document._assemble`, chunk splitting,
source-frame validation, field-presence planning and source-evidence construction.
The existing four-entry frame caches already share parsing across these paths;
this change does not add another cache or change their lifetime.

`source_presence_plan` previously scanned all source records for every chunk.
Both frame parsers produce ordered, nonoverlapping source ranges. Two binary
searches now select the same intersecting range. Existing complete-record and
closed-parent-tree checks still decide whether source hints are safe. The change
preserves arbitrary chunk order, repeated/overlapping chunks and partial ranges.

## Reproduce

From the repository root, with the project's Python 3.14 dependencies installed:

```sh
PYTHONPATH="$PWD/server/src" "$AI_PYTHON" server/scripts/benchmark_source_presence.py \
  --baseline 2099f77a --output docs/evidence/2026-10-29-performance-audit/source-presence.json
PYTHONPATH="$PWD/server/src" "$AI_PYTHON" -m pytest \
  server/tests/test_source_presence_spans.py server/tests/test_source_presence.py \
  server/tests/test_density_chunking.py server/tests/test_chunking.py -q
```

The benchmark loads the baseline function directly from Git. Each workload uses
three sequential before/after pairs, always before then after, each with one warmup and seven measured
calls. All outputs must have identical hashes and the complete expected set of
source IDs and answer/stem evidence. Cold planning clears both source-frame
caches and measures splitting plus presence planning. GC stays enabled; setup,
checks and output hashing are outside the measured calls.

Final serial local macOS ARM64 / CPython 3.14.7 results, with other audit
benchmarks and verification paused (median milliseconds):

| Input | Chunks | Warm presence before / after | Cold planning before / after |
| --- | ---: | ---: | ---: |
| 20 typed records | 2 | 0.131 / 0.130 | 0.201 / 0.198 |
| 1,000 typed records | 63 | 8.101 / 6.486 | 11.315 / 9.786 |
| 1,000 legacy table records | 63 | 6.598 / 5.021 | 8.329 / 6.895 |
| 10,000 typed records | 625 | 208.809 / 69.107 | 242.276 / 106.361 |

Raw samples, hashes, environment and limitations are in
[`source-presence.json`](source-presence.json).
The 10,000-record case is input stress, not a supported output-size claim. Legacy
tables cover saved-source compatibility; new CSV uploads remain rejected.

## Acceptance and limits

- The four focused test files passed: 120 tests, including three added span
  regressions. Focused Ruff and Pyright checks passed.
- A deterministic seed-29 check also compared 500 arbitrary ranges each for typed
  and table input against the baseline; all 1,000 matched.
- No changes to document contracts, call budgets, durable submission, source
  validation, model inputs or cache contents. No dependencies added.
- These measurements cover local CPU work, not model, storage, database, HTTP or
  end-to-end import latency. Timings can vary with host load. This evidence does
  not replace the final combined verification recorded in the pull request.
