# Rust source performance review, October 17, 2026

The review found two unnecessary deep-copy stages in immutable snapshot creation.
`questions::freeze` now copies retained question fields and deduplicates borrowed
groups/visuals before copying them. `paper::digest` freezes once, then removes
mutable favorite/result fields from that owned document. It previously copied
every expanded row before freezing it again.

These shared paths serve paper preview/start, retry snapshots, question-bank ZIP
export and backup validation. No schema, IPC field, dependency, cache, resource
validation or model-call behavior changes.

## Source coverage and decisions

The inventory covers all 22 runtime/build Rust files and the nine native test and
benchmark modules under `app/src-tauri/`. The measurement report records the
31-file source hashes. Review includes callers and existing regression coverage,
not just the modified functions.

| Source area | Finding and decision |
| --- | --- |
| `questions.rs`, `paper.rs` | Expanded rows repeat shared metadata. Copying all of it immediately before discarding duplicate context wastes time and allocations. Implement the two shared copy removals; preserve ordering, first occurrence, selected references, mixed-bank global-image scope, nulls and review/source fields. |
| `exams.rs` | Start/retry/submit execute repeated SQL statements in transactions. Preparing once may help large papers, but it is not isolated by this copy benchmark. Leave this follow-up unimplemented rather than assign it the measured gains below. Preserve integer scores and complete material groups. |
| `store.rs`, `question_metadata.rs` | List pagination/projections and metadata-first paper selection already avoid full question hydration. The immutable-document and mutable-attempt caches are bounded and invalidated on restore. Do not add another cache or persistent SQLite connection: restore can replace the database file. |
| `sessions.rs` | Immutable context interning and keyed response deltas already reduce payload copies. History pages are selected before aggregation. Preserve grading/null semantics and answer/transcript hiding. |
| `contract.rs` | Schemas are initialized once; input limits and ancestry/reference validation remain required. No demonstrated gain justifies changing validation order or removing checks. |
| `assets.rs`, `audio.rs` | Preserve content hashes, bounded decoding, duration checks and fsync before database references. A cross-operation media cache could hide corruption. The apparent repeated audio-persistence work is not reachable for multiple listening roots in the sole validated edit-tree caller; a multi-root benchmark would be invalid. Playback progress already avoids rehashing audio on every update. |
| `audio_import.rs` | DNS validation/IP pinning, redirect/time/size bounds and bounded QR/HTML processing protect remote imports. Do not pool away per-hop validation. No remote-service latency measurement is claimed. |
| `bank_zip.rs`, `backup.rs` | Already compressed media is stored without redundant ZIP compression. Staging, checksum/format validation and rollback remain necessary. Archives still occupy the Store lock; shortening it needs resource-lifetime and concurrent delete/restore evidence, beyond this patch. |
| `selected_file.rs`, `filesystem.rs` | Picker authorization, bounded Android snapshots, complete-file publication, no-clobber semantics and platform durability cannot be removed as an optimization. |
| `settings.rs`, `credentials.rs` | Versioned sidecar validation, pending recovery and native credential isolation remain. Do not cache secrets or bypass passive-read/no-create rules. |
| `ai.rs` | Grading releases the Store mutex during HTTP work; configuration/restore leases preserve ownership. Provider latency and token access are outside these measurements. No model call is made. |
| `lib.rs`, `main.rs`, `build.rs`, `language.rs`, `session_clock.rs` | Native work already uses blocking workers; error lookup is lazily initialized. Keep OS clock and supported-target behavior. No measured startup improvement supports additional synchronization or caching. |
| Native test modules | Reuse the existing opt-in release probe pattern and disposable databases. Run the full host regressions, including ZIP/restore, immutable history, redaction, scoring and recovery failures. |

## Measurement method

Baseline runtime: `9f312f59a2f1bcefcca050e75f3c966765a0baf4`.
Both release executables use the identical `performance::snapshot_metadata_copies`
probe and locked toolchain/dependencies. Three alternating baseline/candidate
process pairs each perform one warmup and seven timed samples: 21 measured
samples per version, workload and operation. The initial baseline smoke run is
excluded from the comparison.

The deterministic source document passes the real contract parser and its 32 MiB
bound. All databases are disposable. The large case has 1,000 independent
answerable questions, four shared groups with 5,000-byte instructions, and no
media. Its *expanded native rows* contain about 53 MB because each row carries
the same selected metadata; the source document remains within its limit. This
is a valid metadata-heavy stress case, not a typical-document claim. Two 20-item
controls cover absent and modest shared context.

Freeze/digest timings exclude fixture setup, checks, output serialization/hash
verification and result destruction. Digest's own serialization/hash is timed.
`startPaper` runs the real `Store::start_paper_data`, including native reads,
digest validation, durable SQLite inserts and compact session construction.
Cleanup and response checks are outside that clock. Its output comparison strips
only generated session ID, creation time and revision keys. Input, probe and
remaining output SHA-256 must match across every pair.

Measurements exclude Tauri IPC, WebView rendering, cold application startup,
installation and external services. They establish local operation latency, not
an App-wide speedup or reduced peak RSS.

Host: Apple M4, macOS 27.0.1 arm64, Rust 1.98.1, release profile with thin LTO.
All medians below pool the 21 samples. Negative reductions are retained rather
than excluded.

| Workload | Operation | Before median | After median | Reduction |
| --- | --- | ---: | ---: | ---: |
| 20 questions, no groups | Freeze | 0.0534 ms | 0.0564 ms | -5.5% |
| Same | Digest | 0.1142 ms | 0.0969 ms | 15.1% |
| Same | Start paper | 1.7203 ms | 1.8274 ms | -6.2% |
| 20 questions, two 1,000-byte groups | Freeze | 0.0817 ms | 0.0605 ms | 26.0% |
| Same | Digest | 0.1719 ms | 0.1104 ms | 35.8% |
| Same | Start paper | 2.0483 ms | 1.9029 ms | 7.1% |
| 1,000 questions, four 5,000-byte groups | Freeze | 72.2400 ms | 4.2667 ms | 94.1% |
| Same | Digest | 142.0456 ms | 6.6558 ms | 95.3% |
| Same | Start paper | 613.6152 ms | 417.7590 ms | 31.9% |

The no-group control has no demonstrated start-paper improvement: its median
increases by 0.1071 ms, and freeze increases by 0.0030 ms. These small absolute
differences include scheduler/filesystem variability; no significance test or
user-perceived latency claim is made. The patch targets redundant shared-context
copies. Reading and expanding metadata and building session responses still cost
time; it does not remove all work from the large case.

The [measurement report](../../../server/reports/app-rust-performance-20261017.json)
retains all six process reports, raw samples, min/max values, matching hashes,
process order, toolchain, binary hashes and full source inventory. Saved binaries,
individual logs and the local runner remain in
`app/.build/rust-performance-20261017/`; those ignored files are local evidence,
not downloadable release artifacts.

## Acceptance

The new regression passes against both original and optimized implementations.
It verifies an explicit expected mixed-bank snapshot, selected references,
deduplication/order, null answers, review/source metadata, preserved favorites,
excluded live metadata, immutable inputs, empty snapshots and the existing error
for malformed digest rows. Mutable favorite/result/score changes keep the digest
stable; changing an answer invalidates it. Paired output hashes additionally
verify byte-compatible snapshots, digests and normalized real session responses.

| Check | Result |
| --- | --- |
| Regression against baseline runtime | The explicit mixed-bank snapshot/digest test passes before production edits. |
| `make app-check AI_PYTHON=...` | Pass: shared contracts/fixtures, TypeScript, ESLint, 415 frontend tests, Rust fmt, 192 native tests and Clippy `--all-targets -- -D warnings`. |
| Ignored ordinary-suite cases | 14 native opt-in/entry-point cases and one frontend performance probe remain excluded from ordinary runs. The new Rust performance probe passes separately in all six paired processes; subprocess recovery helpers are exercised by their parent tests. No claim is made for the other ignored performance/boundary/Keychain cases. |
| Paired release probes | 21 samples per version/workload/operation; all input, probe and normalized output hashes match. |
| Source provenance | All 31 final Rust source hashes match the measured candidate inventory. |
| Existing screenshot evidence | All 658 PNGs in the previous 791-file acceptance inventory retain their hashes; no file is missing. Only the still-running native QA runtime log has appended output. |
| Diff and documentation | `git diff --check` passes; report links resolve locally. |

The [acceptance record](../../../server/reports/app-rust-performance-20261017-acceptance.json)
records check/log hashes and the preserved-image check. Full check output remains
in the ignored local evidence directory named above.

No Windows/Android runtime, native WebView, installer, remote CI or real model
acceptance is claimed. This is a local macOS Rust/SQLite acceptance; source and
storage formats are unchanged. Previous UI acceptance screenshots are preserved.

## Reproduction

Build the test executable once against baseline runtime sources with the new
probe, save it outside `target/`, then build/save the candidate with the same
probe and flags. Alternate saved executables rather than recompiling during
timed runs:

```sh
TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo test --offline --release --locked \
  --manifest-path app/src-tauri/Cargo.toml --lib snapshot_metadata_copies --no-run
PRACTIQ_BENCH_OUTPUT=/absolute/path/to/report.json /absolute/path/to/saved-test \
  performance::snapshot_metadata_copies --ignored --exact --nocapture --test-threads=1
```

No wall-clock threshold is added to ordinary CI. Keep the original input/probe
hashes and all seven samples per process when repeating the experiment.
