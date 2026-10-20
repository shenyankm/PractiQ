# Batch attempt write performance, October 20, 2026

Creating a paper, submitting its answers and retrying mistakes repeatedly
compiled the same INSERT or UPDATE statement inside each transaction. Use the
existing connection-local `prepare_cached` pattern in all three loops. The SQL,
parameters, transaction boundaries, error handling and durability stay unchanged.
The connection still closes at the end of the operation; no persistent SQLite
connection or application cache is introduced.

The shared Store methods serve practice/self-tests/mock exams, explicit submission,
expiry and mistake retry. Existing integer scores, manual/AI grading boundaries,
immutable snapshots, elapsed time, flags, backup and pending recovery rules remain.

## Measurement

Baseline `c7635acb`, Rust 1.98.1, macOS arm64, release profile. Build two saved test
executables with the identical `performance::batch_attempt_writes` probe, then run
three alternating process pairs. Each process runs one warmup and seven timed
samples per operation and size, giving 21 samples per version. Setup, assertions,
semantic hashing and cleanup are outside clocks. No compiler or other test suite
runs during the final measurements. The earlier candidate-only smoke run under
build load is excluded from the comparison.

The fixture uses temporary SQLite, 20 or 1,000 true/false questions and real
Store start/submit/retry methods, including compact response construction. All
answers are deliberately wrong to exercise retry. Each run asserts scores,
answer/result clearing on retry, retained flags/elapsed time, exact attempt count
and no leftover attempts after cleanup. Input and persisted submitted-attempt
semantic hashes match across all processes. Random session IDs and wall-clock
timestamps are excluded from the semantic projection; ordinal, question ID,
answer, result, grading kind, time spent, score bounds and flag are included.

| Questions | Operation | Before median | After median | Reduction |
| --- | --- | ---: | ---: | ---: |
| 20 | start | 1.755 ms | 1.515 ms | 13.7% |
| 20 | submit | 1.387 ms | 1.276 ms | 8.0% |
| 20 | retry | 1.555 ms | 1.368 ms | 12.0% |
| 1000 | start | 33.268 ms | 31.147 ms | 6.4% |
| 1000 | submit | 16.820 ms | 15.095 ms | 10.3% |
| 1000 | retry | 28.835 ms | 26.920 ms | 6.6% |

These are complete local native operation timings, not IPC, WebView, startup,
installer or physical-device acceptance. Filesystem and scheduler noise remains;
no App-wide speedup is claimed. Raw samples, source/probe hashes and saved binary
hashes are in the [report](../../../server/reports/rust-attempt-performance-20261020.json).

## Validation and reproduction

- Passed: 193 host Rust tests; 16 opt-in/entry-point cases remain ignored in the ordinary suite.
- Passed: release batch probe in all six paired processes, in addition to the smoke run.
- Passed: Rust fmt and Clippy `--all-targets -- -D warnings`.
- Passed: generated shared contracts and 49 Python-validated fixture cases.
- Windows/Android runtime, native UI, installer and live model tests are not local evidence; hosted checks are tracked in the PR.

```sh
TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo test --offline --release --locked \
  --manifest-path app/src-tauri/Cargo.toml --lib batch_attempt_writes --no-run
PRACTIQ_BENCH_OUTPUT=/absolute/report.json /absolute/saved-test \
  performance::batch_attempt_writes --ignored --exact --nocapture --test-threads=1
```

Use the same probe against each runtime revision, save both executables before
timing, and alternate the saved binaries. Full logs and saved executables remain
in ignored `server/reports/checks/perf-20261020/`. There are no schema, contract,
dependency or credential changes and no migration is required.
