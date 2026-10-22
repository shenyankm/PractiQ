# Rust selected snapshot reference index

## Change and boundaries

`questions::thaw_questions` now seeds its reference index with only the requested
question IDs. Previously it allocated reference lists for unrelated questions and
then discarded them when returning a small dependency closure. The source
metadata is still scanned; this removes unnecessary index entries, not the scan.

The shared helper serves full snapshot expansion (`thaw`) and selected session
context (`context_from_document`). Connected callers include draft validation,
session responses, snapshot hydration and backup validation/restoration. No IPC,
SQLite schema, dependency, cache, credential or model-call behavior changes.
Validation still runs before expansion, including for an empty selection.
Reference order, duplicates, null metadata, global visuals and immutable inputs
are preserved. Existing ancestor/exclusive-sibling tests remain applicable.

## Paired measurements

Baseline production source: `3208cc860b6501fa80a1b1e64a9d5c4d8023ba37`.
Both saved release test executables include the identical new probe and regression.
Three process pairs run in order before/after, after/before, before/after, with no
concurrent verification/build in this session during measurement. Each process
performs one warmup and seven measured samples per operation/workload: 21 samples
per version. Input, probe, output SHA-256 and output byte counts match across all
runs. The [raw report](rust-selected-reference-index.json) retains every sample,
source/binary hashes, check-log hashes and pooled medians.

Host: Apple M4, macOS 27.0.1 arm64, Rust 1.98.1; release with thin LTO and locked,
offline dependencies. Fixtures are deterministic synthetic version-3 snapshot
objects, not end-to-end imported documents. They exercise a small control, many
unrelated scoped groups, and dense shared references; each also has a global
visual. Selected-context output equals the corresponding fully expanded row.

| Questions / groups / references per group | Operation | Before median | After median | Reduction |
| --- | --- | ---: | ---: | ---: |
| 20 / 2 / 1 | Selected context | 0.002125 ms | 0.002250 ms | -5.9% |
| Same | Full thaw | 0.009084 ms | 0.008375 ms | 7.8% |
| 1,000 / 1,000 / 1 | Selected context | 0.112375 ms | 0.053750 ms | 52.2% |
| Same | Full thaw | 0.488584 ms | 0.474250 ms | 2.9% |
| 500 / 20 / 500 | Selected context | 0.282959 ms | 0.162667 ms | 42.5% |
| Same | Full thaw | 43.558583 ms | 41.537292 ms | 4.6% |

Both larger selected-context cases improve in all three pairs. The small control
is slower by 0.000125 ms; no small-input improvement is claimed. Full-thaw results
are controls, not evidence of a reliable full-expansion speedup: dense full-thaw
is slower in the first pair. Timing includes result construction, but excludes
fixture setup, output hashing/serialization, assertions and result destruction.
No peak-RSS, SQLite, disk, IPC, WebView, startup or user-perceived latency claim
is made. No wall-clock threshold is added to CI.

## Acceptance

- New reference-order regression passed against the baseline before production
  edits and again in the complete candidate suite. It covers outside references,
  duplicate references, Unicode IDs, empty groups, global/scoped visuals,
  immutable input and validation of an empty snapshot with malformed metadata.
- `VITEST_MAX_WORKERS=2 make app-check AI_PYTHON="$(uv python find 3.14)"` passed:
  shared contracts/fixtures, TypeScript, ESLint, 464 frontend tests, Rust fmt,
  217 native tests and Clippy `--all-targets -- -D warnings`.
  Three frontend cases and 17 native opt-in/helper cases remain skipped in the
  ordinary suite; the new ignored benchmark passed separately six times.
- `make app-build AI_PYTHON="$(uv python find 3.14)"` passed: macOS arm64 `.app`
  and `.dmg`. This builds the current checkout including pre-existing frontend
  edits; those edits were not changed by this optimization.
- `app/scripts/check-bundle.py` passed against the built app's
  `Contents/Resources/bundled`: metadata/notices only, no embedded AI engines.
- `git diff --check` passed. Local logs and saved executables remain under the
  ignored `app/.build/rust-selected-references/` directory.

No Windows/Android runtime/build, native UI, hosted CI, other ignored performance
probe or real-model acceptance was performed. Databases and credentials were not
used by the benchmark; regression tests use disposable databases.

## Reproduction

Build/save the baseline executable with this probe, then build/save the candidate
using the same flags. Run saved executables alternately, rather than rebuilding
during measurement:

```sh
TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo test --release --locked --offline \
  --manifest-path app/src-tauri/Cargo.toml --lib selected_snapshot_references --no-run
PRACTIQ_BENCH_OUTPUT=/absolute/path/report.json /absolute/path/saved-test \
  performance::selected_snapshot_references --exact --ignored --nocapture --test-threads=1
```

Rollback is limited to the reference-map initialization and insertion in
`thaw_questions`; no data migration or cleanup is necessary.
