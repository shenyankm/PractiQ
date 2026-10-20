# Frozen reference membership — 2026-10-20

`questions::freeze` used JSON serialization to build and query ID sets for selected questions, sections and visuals. Borrow the existing immutable JSON values as set keys instead. This removes temporary ID strings without changing the frozen document, reference ordering, nulls or mixed-bank image scoping. Section and visual IDs remain separate namespaces.

The existing ignored `snapshot_metadata_copies` native probe adds a valid 100-question/100-shared-section case: 133 KB of validated source expands to 8.7 MB of native rows and one million repeated question references. Baseline and candidate use identical probes and disposable SQLite, with matching input hashes, frozen documents, digest hashes and normalized full start-paper responses. Save both release executables before measuring; alternate three pairs with one warmup and seven samples per operation. Setup, checks, hashes and cleanup are excluded.

The [report](rust-reference-sets-round2-20261020.json) retains all samples, pooled medians and each pair's medians. Reference-heavy freeze medians improve in all three pairs (1.482→1.008 ms, 11.188→1.268 ms and 3.058→1.833 ms). However, substantial wall-clock noise also appears in unchanged small controls and complete start-paper calls. Do not interpret the pooled full-operation percentages as a causal end-to-end speedup. The narrower acceptance is removal of reference serialization plus equivalent outputs and consistently faster reference-heavy freeze in these local samples. No IPC, WebView or physical-device performance is established.

The regression covers escaped Unicode IDs, a shared ID used by both sections and visuals, repeated contexts, outside references, retained reference order, nulls and unchanged inputs. Existing snapshot, exam, export, restore and multi-bank tests exercise the connected paths.

```sh
TAURI_CONFIG='{"bundle":{"resources":[]}}' \
PRACTIQ_BENCH_OUTPUT=/absolute/path/report.json \
cargo test --release --locked --manifest-path app/src-tauri/Cargo.toml \
  snapshot_metadata_copies -- --ignored --exact performance::snapshot_metadata_copies --nocapture --test-threads=1
```
