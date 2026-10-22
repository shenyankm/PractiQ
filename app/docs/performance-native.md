# Native question-data performance

These changes address native recommendations **7, 6, 8 and 10** from the performance review of `5b673a6e`.
They do not change IPC contracts, schema 11, database objects/indexes, snapshot format or cache limits.

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

Apple M4 / arm64 macOS 27.0.1, Rust 1.98.1. These are bounded synthetic observations, not product latency guarantees. Setup, output hashing and assertions are outside the timed regions. OS caches are not flushed. No IPC, WebView or picker is measured.

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

## Limits

No allocator/RSS measurement, Windows/Android device measurement, real-user workload or full application verification is included here. Shared-host timing varies; use the work-count/allocation regressions and equivalence assertions as the stable evidence. Combined application/service verification and independent review remain separate gates.
