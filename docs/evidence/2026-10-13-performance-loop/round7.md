# Round 7: avoid cloning questions for schema validation

Baseline is the retained code after earlier rounds, with the same new contract regression tests and backup/restore benchmark in both release binaries. `round7-baseline-probe.json` measured a 2,251.0 ms first restore on the fixed load; this single probe is a clue, not acceptance evidence. Reading backup validation established that both current questions and each immutable session snapshot call the shared `validate_tree` / `validate_question` path. That path deep-cloned every question into a one-question schema wrapper.

Hypothesis: temporarily moving the normalized question into the existing wrapper avoids that clone without reducing validation. Candidate keeps the wrapper, schema validator and `result` error prefix unchanged. It captures `schema_check`'s owned result, restores the question with `take`, then propagates the error. The question therefore remains normalized and populated on schema rejection; all subsequent answer, material, relationship and quality validation still runs. This is one shared change, also reached by ZIP/JSON import, backup validation, editor saves and answer validation.

Fixed load: a 76,369,920-byte temporary schema-11 SQLite database with 10,000 true/false questions, 100 sessions, 1,000 immutable snapshot questions per session and 100,000 attempts. There are no image/audio assets or service-settings override. Backup and recovery archives are 5,861,245 bytes. Setup, assertions, logical fingerprints, reopening and report serialization are outside timing; the complete `Store::backup` / `Store::restore` methods, including validation, recovery archive, replacement and fsync work, are inside. No user database, migration or model call.

Five sequential alternating AB/BA pairs execute saved macOS arm64 release binaries with one test thread. Each worker performs three backups followed by three restores, reporting the first invocation separately and the median of two later warm samples. The machine/runtime versions are in `environment.json`. Fixture construction and whole-database hashing warm files, and OS caches are not flushed.

| Complete native method | Baseline warm median ms | Candidate warm median ms |
| --- | ---: | ---: |
| Restore | 2073.556 | 1797.628 |
| Backup control | 297.151 | 300.187 |

Decision: retain. All five restore pairs improve by 10.7–14.6%; median reduction is 13.3%. Warm pair ranges are disjoint: baseline 2014.1–2154.4 ms, candidate 1791.6–1844.5 ms. Backup changes vary in sign across pairs; its median is 1.0% slower within overlapping variation, with no reliable improvement or reproducible material regression. First restore invocation medians are separately 2063.799 / 1869.774 ms; first backup medians are 304.067 / 298.881 ms. These are method invocations after fixture setup, not cold startup measurements.

All 30 restore samples preserve the complete typed-row fingerprint and row counts of all 32 application tables, both immediately and after reopening the Store. The fingerprint includes NULL, integer, floating-point, text and blob type tags and full values; immutable session-document text is included. Every paired input SHA-256 and snapshot SHA-256 matches. The application-table fingerprint is `929960b24cb05d64ed6777f7f081f5edcafe9b8e93c8ae7295e5ff598442332f`; the 1,000-question snapshot hash is `3ed944703dd50a218e5c4031d83b20dd311e169c77e96e7305c7ccb0c6da6cf1`. Recovery archives exist, schema remains 11 and reopened service settings remain absent. Archive byte counts are recorded; the comparison's `outputSha256` is a logical database hash, not a ZIP-byte identity assertion.

`round7-regression.log` records three focused contract tests passing and one existing synthetic benchmark ignored. They check exact schema-error paths and question context, restoration of normalized nested content after rejection, supplied false answers, nested nulls and unchanged review flags, plus repeated successful validation. A read-only review traced all callers and found no error/restoration issue. These checks and the full-method fingerprint assertions cover this experiment; broader app checks and UI interaction remain pending.

Raw first/warm samples are `round7/0-baseline.json` through `round7/4-candidate.json`, with per-worker logs and `round7/comparison.json`. Source/test changes are `round7-retained.patch`; the identical benchmark is `performance::backup_restore_stress` in `app/src-tauri/src/performance.rs`. The saved binary SHA-256 values are:

- Baseline: `3e3ba0eb2de6c5ff66835b7633044338b1fbda727957a8481142d89f1f143320`.
- Candidate: `45e5599de3000120c175e79daf2868b261ccdb8ce2a2e2a10b4a8faa3238418b`.

The paired command from the repository root is:

```sh
python3 docs/evidence/2026-10-13-performance-loop/native_compare.py \
  /var/folders/1b/b19xbzjx7xqc4kl0k9x_y4y80000gp/T/practiq-perf-loop-qrdu2192/round7-baseline \
  /var/folders/1b/b19xbzjx7xqc4kl0k9x_y4y80000gp/T/practiq-perf-loop-qrdu2192/round7-candidate \
  performance::backup_restore_stress PRACTIQ_BENCH_OUTPUT \
  docs/evidence/2026-10-13-performance-loop/round7
```

The runner invokes each binary with `--exact --ignored --nocapture --test-threads=1` and an absolute output path. Saved binaries and `round7-baseline-contract.rs` live in the temporary snapshot directory; preserve them or reconstruct the recorded versions before reproduction.

This is an end-to-end native Store-method measurement on a snapshot-heavy synthetic database. It is not an isolated Rust clone microbenchmark and does not establish ZIP bank import, image-heavy restore, picker/IPC, WebView, Windows or Android latency. Filesystem integrity, atomic replacement, recovery and sidecar production code are unchanged. Final `make app-check` and isolated application interaction remain pending.

Final acceptance outcomes and interaction limits are recorded in [README.md](README.md) and [native-interaction.md](native-interaction.md); earlier pending notes above describe the per-round checkpoint.
