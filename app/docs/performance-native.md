# Native question-data performance

This guide includes native recommendations **7, 6, 8 and 10** from the performance review of `5b673a6e` and subsequent measured changes.
They do not change IPC contracts, schema 11, database objects/indexes, snapshot format or cache limits.

## Manual preview membership (October 29)

`Store::preview_paper` used to scan all candidate roots for each manually selected
ID. It now keeps the requested IDs in a temporary set and removes matches in one
candidate pass, stopping when none remain. The returned IDs still come from the
original request, preserving order. Empty/duplicate selections, child-only
selections, stale IDs, foreign banks and changed filters retain their rejection
paths. The set borrows IDs and adds no persistent cache or dependency.

The existing `performance::paper_preview_stress` probe now includes the first and
last 1,000 roots in reverse selection order, with and without candidate shuffling.
Both release binaries use the same probe: baseline `2099f77a` and the candidate
membership change. The [raw report](../../docs/evidence/2026-10-29-performance-audit/native.json)
includes all six process runs, source/probe/binary hashes and matching complete
output hashes for every workload. Each variant has nine samples per workload;
the table reports medians in milliseconds.

| Bank roots / selection | Before | After |
| --- | ---: | ---: |
| 10,000 / first 1,000, ordered candidates | 34.002 | 33.948 |
| 10,000 / last 1,000, ordered candidates | 54.007 | 36.069 |
| 100,000 / first 1,000, ordered candidates | 205.590 | 200.607 |
| 100,000 / last 1,000, ordered candidates | 491.033 | 211.086 |
| 100,000 / first 1,000, shuffled candidates | 328.504 | 204.486 |
| 100,000 / last 1,000, shuffled candidates | 329.577 | 313.760 |
| 100,000 / count 20, ordered control | 181.710 | 182.233 |
| 100,000 / quota 1,000, ordered control | 201.610 | 201.982 |

These are complete native preview calls on macOS arm64 with Rust 1.98.1 and
temporary SQLite databases, excluding setup, assertions and report serialization.
The first pair overlapped other tests; the next four runs used a coordinated quiet
window in candidate/baseline/baseline/candidate order. All samples are retained,
including variable shuffled-tail timings. OS caches were not flushed. There is
no picker, IPC, WebView, live-provider, user-data or allocator/RSS evidence here.

Reproduce by building the same probe with baseline and candidate `paper.rs`,
retaining each Cargo test executable, then alternating the executables:

```sh
TAURI_CONFIG='{"bundle":{"resources":[]}}' \
  cargo test --release --locked --manifest-path app/src-tauri/Cargo.toml \
  --lib paper_preview_stress --no-run
PRACTIQ_BENCH_OUTPUT=/tmp/paper-preview.json "$TEST_BINARY" \
  performance::paper_preview_stress --exact --ignored
TAURI_CONFIG='{"bundle":{"resources":[]}}' \
  cargo test --locked --manifest-path app/src-tauri/Cargo.toml --lib paper::tests
```

The focused regression also verifies exact rejection messages. Complete app
checks and browser acceptance are recorded separately in the PR.

## Scoped detail tables (October 29)

`questions::read_scoped` collects modes from its selected rows and queries only
their detail tables. A judgment-only selection previously queried all eleven
tables; it now queries one. Descendants contribute their own modes, so mixed
composite trees still load every required detail. Empty reads retain their early
return; incomplete null-mode questions remain reviewable. A missing selected
detail retains the existing error.

The four-line change reuses the existing `HashSet` import. It adds no schema,
index, dependency, persistent cache or native command. Scope selection, bank
ordering, options/items, sources, warning associations, latest attempts,
transactions and resource verification are unchanged. The same helper serves
detail/list reads, preview/start/edit, merge/export and backup validation.

The [raw release report](../../docs/evidence/2026-10-29-scoped-reads/native.json)
compares baseline `125dae03a9594bd8892818819982df578412e87c` with the candidate on
macOS arm64. Both test executables contain the same probe. Three isolated process
pairs run before/after, after/before, before/after; each workload has one warmup
and seven measured reads per process. All complete row-array output hashes match.
Fixture setup, assertions and hashing are excluded from timing. Connections are
reused within each workload and OS caches are not flushed. These measurements
exclude connection setup, IPC, WebView, full import and backup latency.

| Bank contents / selected rows | Before median ms | After median ms |
| --- | ---: | ---: |
| one mode / 1 | 0.229 | 0.155 |
| one mode / 30 | 0.461 | 0.300 |
| one mode / 1000 | 8.059 | 6.055 |
| two modes / 1 | 0.212 | 0.136 |
| two modes / 30 | 0.444 | 0.316 |
| two modes / 1000 | 8.661 | 6.755 |
| all eleven modes / 26 | 0.490 | 0.489 |

The one/two-mode banks contain 10,000 deterministic questions; a one-row selection
contains only one mode even in the mixed bank. The all-eleven-mode control uses
the 26-question `all-types.zip` fixture and exercises the path that skips no
detail table. Benefits are limited to selections with fewer modes.

Validation on the same macOS host:

- The added regression checks every type in `all-types.zip`, composite subtree
  reads, null-mode questions and missing selected-detail errors.
- `make app-check` passed generated-contract parity, 51 shared fixtures plus the
  sample, frontend types/lint, and 500 frontend tests (three skipped). Native tests
  had 230 passes, 16 failures and 22 ignored benchmarks. Every failure was a
  mock-HTTP listener denied by this sandbox; a representative failure reproduces
  in the baseline executable. The 5,400-asset backup/recovery round trip passed.
- Full `app-check` is **not accepted**: its native failures prevent the final
  Clippy step. Clippy and the focused native regression are checked separately
  after the final benchmark-only control was added. Hosted CI is separate.
- No user database, credential store, live provider, GUI acceptance or final
  installer was exercised. No UI or packaging behavior changed.

Build the probe without running it:

```sh
TAURI_CONFIG='{"bundle":{"resources":[]}}' \
  cargo test --release --locked --manifest-path app/src-tauri/Cargo.toml \
  --lib scoped_detail_read_stress --no-run
```

Build this same probe with the baseline and candidate `questions.rs` in isolated
checkouts and retain both executables printed by Cargo. Set `TEST_BINARY` to each
retained executable and use fresh output paths, alternating the variants:

```sh
PRACTIQ_BENCH_OUTPUT=/tmp/scoped-detail-read.json "$TEST_BINARY" \
  performance::scoped_detail_read_stress --exact --ignored
make app-check
cargo fmt --manifest-path app/src-tauri/Cargo.toml -- --check
TAURI_CONFIG='{"bundle":{"resources":[]}}' \
  cargo clippy --locked --manifest-path app/src-tauri/Cargo.toml \
  --lib --all-targets -- -D warnings
```

Run timing separately from builds/tests. This test uses temporary databases and
has no timing threshold. Ordinary native suites intentionally leave it ignored.

## Sparse history and bank overview reads (October 25)

History excludes the exact JSON text `null` before transferring draft answers to
Rust. Every remaining answer still uses `exams::has_answer`, including whitespace
JSON nulls, nested empty values, Boolean false and numeric zero. The query and its
release probe share `sessions::DRAFT_ANSWERS_SQL`. Bank choices use the existing
bank-order index and a per-bank indexed count instead of a joined aggregate plus
sorting. Empty banks, composite parents, descendant leaf counts and stable tie
ordering are unchanged; no schema/index or cache was added.

`tests.rs` covers both behaviors. `performance::runtime_read_stress` compares the
old and new native reads in temporary databases (100 banks / 100k questions and
30 sessions / 30k attempts), checks matching bank output hashes and draft counts,
and reports timing without timing assertions. It measures the draft pass, not
whole history-page or WebView latency. See the
[acceptance record](../../docs/history/performance/runtime-optimizations-20261025.md).

## Changes and correctness checks

- **7 — shared visual search:** search each relevant visual ID once, then map matching IDs back through the original eligible nodes. Bank scope, root order, `documentOnly`, mode and same-node favorite/wrong filters remain intact. The search regression includes scoped/shared/foreign/document-only visuals, an ineligible sibling and a cross-bank association. A test-only thread-local counter measures visual JSON searches.
- **6 — selected snapshot copies:** `thaw_questions` consumes its owned question array instead of cloning it again. Full `thaw` still copies from the immutable document once. A 100,000-byte owned stem retains its allocation address through thawing. Existing context-equivalence tests now include long stems/material and still verify ancestors, exclusive siblings, metadata order/duplicates and unchanged source documents.
- **8 — association writes:** use the existing `prepare_cached(...).execute(...)` pattern for the six fixed association INSERT statements. Parameters, conflict policy, iteration order, foreign keys and the outer import transaction are unchanged. An injected failure on the second source association verifies rollback of banks, imports, questions, warnings, sections, visual associations, sources and asset references, plus orphan-file cleanup.
- **10 — audio duration validation:** after the unchanged full database-content validation, read only `audio_ref`, `start_seconds` and `end_seconds` from current listening rows. Parse historical documents one at a time and inspect their raw questions without thawing shared context. The existing duration validator is unchanged. Restore tests reject invalid current segments and history-only segments after deleting the source bank; valid history-only audio restores successfully. A rejected restore preserves the destination database bytes, historical content and audio bytes. View keys may still be invalidated, as before.

Resource verification, full structural validation, immutable history, transactional publication/recovery and explicit paid-work actions are not bypassed. No new runtime dependency or cross-request cache is introduced.

## Reproduce the bounded probes

From the repository root on a supported native host:

```sh
export TAURI_CONFIG='{"bundle":{"resources":[]}}'
cargo test --manifest-path app/src-tauri/Cargo.toml --lib store::search_tests
cargo test --manifest-path app/src-tauri/Cargo.toml --lib questions::
cargo test --manifest-path app/src-tauri/Cargo.toml --lib audio::tests
cargo test --manifest-path app/src-tauri/Cargo.toml --lib association_insert_failure
cargo test --manifest-path app/src-tauri/Cargo.toml --lib shared_snapshots_tests
cargo test --manifest-path app/src-tauri/Cargo.toml --lib backup::
cargo test --manifest-path app/src-tauri/Cargo.toml --release --lib store::search_tests::search_stress -- --ignored --nocapture
cargo test --manifest-path app/src-tauri/Cargo.toml --release --lib association_insert_cache_stress -- --ignored --nocapture
cargo test --manifest-path app/src-tauri/Cargo.toml --release --lib audio_duration_pass_stress -- --ignored --nocapture
PRACTIQ_BENCH_OUTPUT=/tmp/practiq-native-snapshot-release.json cargo test --manifest-path app/src-tauri/Cargo.toml --release --lib snapshot_copy_stress -- --ignored --nocapture
cargo fmt --manifest-path app/src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path app/src-tauri/Cargo.toml --lib --tests -- -D warnings
```

The resource override is the existing native-test pattern; it avoids requiring generated packaging resources in a fresh worktree. All databases and assets used by these tests are temporary. No model, Tencent, user database or credential access is required.

## Example release observations

Apple M4 / arm64 macOS 27.0.1, Rust 1.98.1. These are bounded synthetic observations, not product latency guarantees. Setup and output hashing are outside the timed regions. Search timings include lightweight result assertions and the test-only visual-search counter. OS caches are not flushed. No IPC, WebView or picker is measured.

### Search

10,000 roots, 50 shared visuals with approximately 800-byte descriptions, and one single-question visual; three samples per query:

| Query | Result roots | Visual searches per sample | Median ms |
| --- | ---: | ---: | ---: |
| Missing visual text | 0 | 51 | 37.72 |
| Shared visual text | 10,000 | 51 | 51.78 |
| Scoped visual text | 1 | 51 | 66.81 |

The old missing-text branch would produce **500,001** visual rows/searches for this fixture (`10,000 × 50 + 1`); this is a deterministic work calculation, not a measured old latency. The new count of **51** is asserted in every sample. Result hashes include `e0bce5ed989fca16e56d399947456594a2f7b74cd4beef8cde6b6f6616a0588e` (missing) and `73eba3e620f940cdfcdfe65ec3cccb798bcf9bacbd5cba04c00e01a3cb6323db` (scoped). Mapping and node traversal still require SQL work.

### Association INSERTs

200 questions, 100 groups, 20 visuals and source/warning rows: **24,323 inserted rows**, six distinct INSERT statements. The paired probe uses the same implementation with statement-cache capacity zero (reprepare each execution, like the previous path) and 16. It measures only `put_context`, not resource persistence or transaction commit.

- Cache disabled: **69.69, 66.38, 72.59 ms**.
- Cache enabled: **29.87, 33.50, 28.71 ms**.

Both paths have identical ordered normalized content SHA-256 `ea10da2681713075d0b998273a2823751c5833b263acff19d0ed907e510741b5`, exact association/warning/source counts and no foreign-key violations. Generated section/visual IDs are excluded from normalization. SQL compilation counts are inferred from cache behavior, not instrumented SQLite compiler events.

### Selected context and drafts

One untimed warmup, then seven samples; median milliseconds below. Each direct/read-through/cached context path asserts the same output hash, and the document stays unchanged. The allocation-address regression separately proves that consuming the owned subset performs no second deep copy of its stem. These timings describe the new path, not a paired old/new latency comparison.

| Mode / child nodes | Passage bytes | Scoped metadata pairs | Direct context | Read-through context | Cached context | Save draft |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Reading / 20 | 1,000 | 0 | 0.0078 | 0.0503 | 0.0079 | 0.4780 |
| Reading / 999 | 100,000 | 0 | 0.0468 | 1.5478 | 0.0479 | 0.6990 |
| Reading / 999 | 10,000 | 999 | 0.1128 | 2.8787 | 0.1038 | 0.6152 |
| Exclusive word bank / 100 | 100,000 | 0 | 0.1925 | 0.3654 | 0.1915 | 0.6876 |

The exclusive-word-bank context hash is `22e0b949ee09058b6c447dc90a447bb0aade2020fc1a205a4f72b7becf20f400`.

### Audio duration pass

517 current questions including valid fixture audio, five historical documents of 517 questions each, and ten shared groups per document. Full structural validation runs before either timed variant. The paired legacy-shaped variant performs `questions::read` and historical `thaw`; the new variant runs the narrow duration pass.

- Full hydration: **218.24, 229.96, 223.03 ms**.
- Narrow pass: **6.04, 5.92, 5.81 ms**.

The database file digest is unchanged after both variants. This measures only the extra duration-validation pass, **not complete restore**. Historical JSON parsing still scales with document size; the initial full validation and resource hashing/decoding are intentionally retained. Historical snapshot hashes vary between probe invocations because the import creates fresh native IDs; comparisons within one invocation use the same documents.

## Contract validator work bounds

`validate_tree` builds one parent-ID → ordered child-index lookup after question
normalization and unique-ID validation. Composite checks and incomplete-parent
detection reuse it; incomplete IDs use a set, without allocating an ID string for
every membership check. Validation still walks questions in input order, retains
the same first-error precedence, and appends `material` only after relational
checks succeed. Blank references, ancestry, shared options, listening exceptions
and pre-existing review flags are unchanged. This applies to imports, edits,
current questions across all banks during restore, and each historical snapshot.

For 10,000 reading groups with four children each (50,000 nodes), the old child
collection alone compared parent IDs 500 million times. The new lookup examines
50,000 parent IDs once, stores 40,000 child indices, and serves 10,000 composite
lookups. These are source-derived work counts, not measured latency or a claim
that every validator operation is linear: ancestry walks and per-group blank
reference/option checks remain unchanged. Additional lookup memory is O(nodes).

`parse` keeps its initial full result-schema pass. It repeats that pass only when
an empty question list caused missing-question/document-only metadata mutation;
nonempty results no longer traverse the unchanged schema twice. All processing,
reference, resource, checksum and restore trust checks remain in place.

Focused regressions cover valid/reversed composite trees, relational rejection
and normalization/error order, empty/invalid result metadata, incomplete reading
and listening parents, and idempotent review marking. The multi-bank backup test
imports four composite banks with incomplete parents, edits current material
after creating a practice snapshot, then checks exact current rows and unchanged
snapshot bytes after restore.

Run the synthetic probes with fresh output destinations (the scaling probe also
checks exact normalized output at 100, 1,000 and 10,000 groups; it has no timing
threshold):

```sh
export TAURI_CONFIG='{"bundle":{"resources":[]}}'
cargo test --locked --manifest-path app/src-tauri/Cargo.toml contract::validation_tests
cargo test --locked --manifest-path app/src-tauri/Cargo.toml backup::schema_tests
PRACTIQ_BENCH_OUTPUT=/tmp/practiq-contract-tree-new.json cargo test --locked --manifest-path app/src-tauri/Cargo.toml --release --lib contract_tree_validation_scaling -- --ignored --nocapture
PRACTIQ_BENCH_OUTPUT=/tmp/practiq-contract-import-new.json cargo test --locked --manifest-path app/src-tauri/Cargo.toml --release --lib import_validation_performance -- --ignored --nocapture
```

The import probe compares the new parser with the same parser plus one full
result-schema pass on an unchanged valid result, not the previously removed
per-question pass. It is a paired traversal-cost approximation, not execution of
the historical parser. Neither probe measures ZIP I/O, complete restore, IPC,
WebView or device latency. Use release builds for latency interpretation;
unoptimized runs establish synthetic correctness/scaling evidence only.

## Limits

No allocator/RSS measurement, Windows/Android device measurement, real-user workload or full application verification is included here. Shared-host timing varies; use the work-count/allocation regressions and equivalence assertions as the stable evidence. Combined application/service verification and independent review remain separate gates.
