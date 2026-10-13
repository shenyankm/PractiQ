# Plain question pagination

Baseline: `acd7ad85a042858d0479beb1a68bb6f261a17505` (PR #225). Measurements use release test binaries on the same macOS arm64 host with Rust 1.98.1. Inputs are 10,000 synthetic true/false questions in a temporary SQLite database; no user database or model service is used.

The optimization applies to paged requests without search, state filters or statistics. It shares the existing eligibility query, counts rows in SQLite and returns only the selected root IDs. Bank scans remain outermost to use existing indexes; an absent type filter omits the unnecessary choice-table join. Type-filtered requests retain their existing predicates. Search, favorite/review/wrong/unattempted filters, statistics and paper construction retain the full-root path. No schema, index, dependency or command contract changes are required.

## Measurement

| Workload (30 roots per page) | Before median | After median | Time reduction |
| --- | --- | --- | --- |
| First plain page | 3.240 ms | 2.382 ms | 26.5% |
| Deep page, offset 9,000 | 3.192 ms | 2.708 ms | 15.2% |
| Clamp offset 20,000 to the last page | 3.020 ms | 2.687 ms | 11.0% |
| Search page control | 16.061 ms | 16.377 ms | -2.0% |
| Search statistics control | 25.608 ms | 25.830 ms | -0.9% |
| Missing-search control | 31.723 ms | 31.755 ms | -0.1% |

`compare.py` alternates the order of baseline and candidate execution for five pairs. Each binary runs the existing `search_stress` fixture with three repetitions per workload. Reports retain each pair's median and use their median as the summary. SHA-256 checks assert identical outputs for every repetition group and both versions. Compilation and fixture creation are outside the timed closures. Final measurements are in [before.json](before.json) and [after.json](after.json).

Only local native-command latency is measured. SQLite still scans for exact counts and may allocate sorting buffers. The Rust root-ID vector is bounded by the requested page size, not the database size; this is not a process-RSS claim. The fixture uses one bank and flat questions; no production workload, Windows/Android runtime or installer acceptance is claimed. Small timing changes in the search controls are noise rather than an optimization claim.

## Reproduce

Build one release test binary from the baseline and one from this change, using the same pinned Rust toolchain. On the baseline, copy only the benchmark tail starting at `fn measure(` from `app/src-tauri/src/search_performance.rs`; its original `seed` fixture is unchanged. Leave baseline regression tests intact because the new tests also exercise the changed internal selection signature.

```sh
TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo test --release --manifest-path app/src-tauri/Cargo.toml search_stress --no-run
```

Preserve each `src/lib.rs` test executable printed by Cargo before building the other version, then run with an existing Python 3.14+ interpreter:

```sh
"$AI_PYTHON" docs/evidence/2026-10-13-question-pagination/compare.py /absolute/baseline-test-binary /absolute/candidate-test-binary /tmp/pagination-comparison
```

The new regression compares plain pages with full-root pages plus statistics across bank scopes, type/state filters and offsets. It also checks same-timestamp bank ordering, last-page clamps, empty results, invalid limits/offsets, selected-ID bounds, latest wrong-answer results, completed review flags and composite descendant filters.

Acceptance: full `make app-check AI_PYTHON=...` passed contracts/fixtures, types, lint, 390 frontend tests (one existing opt-in test skipped), 180 native Rust tests (10 existing opt-in tests ignored), formatting and Clippy. The release `search_stress` benchmark was explicitly run and passed its assertions and the paired comparison checks. Full `make verify AI_PYTHON=...` passed 2,116 service tests with 93% coverage, lockfile/Ruff/Pyright checks, 33 evaluation fixtures, recovery probes and wheel/sdist validation. The final SQLite-only cleanup was followed by another full App check; service inputs were unchanged. The comparison script passes Ruff, and `git diff --check` passes.
