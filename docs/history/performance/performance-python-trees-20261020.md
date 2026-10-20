# Source tree membership performance, October 20, 2026

The existing source-evidence proof scanned every source frame again for every
question tree. `build_source_evidence` now groups frame IDs by their root once
per layout. `_typed_frames` and `_table_frames` already require closed, ordered
roots with unique IDs and parents preceding children. This allows the same whole
tree membership comparison with one dictionary lookup per tree. Local maps live
only for the current call; no persistent cache or new dependency is introduced.

This shared proof serves final document merge and passive completed-result
projection. Quote uniqueness, complete-tree bijection, source-unit isolation,
parent/option/material reference checks and uncertain/incomplete-source rejection
remain unchanged. Inputs are not mutated and no model is called by the probe.

## Measurement

Baseline `c7635acb`, CPython 3.14.7 on macOS arm64. Reuse
`server/scripts/benchmark_source_evidence.py`: three alternating pairs, one
warmup and seven timed samples per pair. Input and output SHA-256 values match
for every case, including legacy saved CSV evidence. Setup, checking and hashing
are outside timing; GC remains enabled. No other test suite or compiler ran
during the timed processes.

| Questions | Shape | Before median | After median | Reduction |
| --- | --- | ---: | ---: | ---: |
| 20 | typed | 0.226 ms | 0.222 ms | 2.0% |
| 1000 | typed | 23.122 ms | 12.080 ms | 47.8% |
| 20 | csv | 0.262 ms | 0.269 ms | -2.7% |
| 1000 | csv | 24.685 ms | 12.736 ms | 48.4% |
| 1000 | multi-unit | 17.343 ms | 14.349 ms | 17.3% |
| 1000 | no-quote | 6.629 ms | 6.674 ms | -0.7% |

For 1,000 typed questions, complete passive projection changes from 246.718 ms to
241.093 ms (2.3%); this is a much smaller gain than the isolated source proof.
Small/quote-free controls show no useful gain, and their negative results remain
in the [raw report](../../../server/reports/python-tree-performance-20261020.json).
These CPU timings exclude DB/checkpoints, HTTP, queue/workers, extraction, Office,
models, deployment and production throughput.

## Validation and reproduction

The new deterministic work-bound regression counts frame-parent reads for 100
independent roots. The baseline performs 10,200 reads and fails the 500-read
bound; the candidate passes. The existing source evidence/scope/duplicate suite
also covers nested/shared options, missing children, conflicting IDs, invalid
quotes, multiple source units and input immutability. Full service verification
is recorded in the PR after completion; its first attempt exposed an optional
iterable type error in the new test, corrected before the final run.

```sh
PYTHONPATH=server/src python3.14 server/scripts/benchmark_source_evidence.py \
  --baseline c7635acb --output /absolute/report.json
PYTHONPATH="$PWD/server/src" make verify AI_PYTHON=/path/to/python3.14
```

First failures and full logs remain in ignored
`server/reports/checks/perf-20261020/`. There is no schema, API, prompt, model
budget, explicit-action, credential or backup-format change.
