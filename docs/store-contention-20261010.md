# Backup/export Store contention measurement

Issue #190 compares source `628f776a382a7f157b283121ad7147059a557cf9` with a small archive change: store already compressed image and non-WAV audio entries directly, retaining Deflate for WAV, JSON and SQLite. The Store mutex, checksums, resource decoding, snapshot, fsync and publication order remain intact.

## Workload and method

The opt-in `performance::archive_contention` native test creates 500 valid synthetic questions, 16 deterministic random 512×512 PNG images (12,593,152 resource bytes), and a practice draft in a temporary schema-11 store. While a worker holds the real `Mutex<Store>` for backup or bank export, a concurrent thread saves that draft. It records lock hold/wait and complete save latency, verifies ZIP CRCs, rejects a damaged resource without publishing a destination, and verifies the draft after reopening the store.

Three alternating baseline/candidate release-binary pairs each contain three samples per operation: nine samples per variant/operation. The fixed input SHA256 is `39592107e07d6c003af55fbc42e4f6de2b63a8487195cdb2ceb8ab02b6164a23`. Both variants use the same measurement probe; two needless borrows were subsequently removed for Clippy, without changing the workload. [Raw reports and source hashes](evidence/2026-10-10-store-contention/metadata.json) retain all six paired runs.

Environment: Apple M4 arm64, macOS 27.0.1 (26A434), Rust 1.98.1 (48a229cea, 2026-09-01). These are native synthetic measurements, excluding picker/IPC/WebView and physical Windows/Android devices. Component probes measure SQLite snapshot, question reads, resource hash/decode and exported ZIP CRC checking separately; their times cannot be added to reconstruct lock time. `databaseSnapshot.jsonBytes` measures the diagnostic JSON payload, not SQLite file size.

## Results

Pooled median milliseconds:

| Operation | Baseline draft save | Candidate draft save | Baseline range | Candidate range |
| --- | ---: | ---: | --- | --- |
| Idle | 0.835 | 1.775 | 0.618–15.180 | 0.692–24.743 |
| Backup | 151.217 | 60.589 | 143.550–183.074 | 44.720–69.425 |
| Bank export | 251.997 | 109.697 | 238.338–345.758 | 81.192–180.565 |
| Damaged backup | 28.364 | 11.802 | 27.198–45.612 | 9.252–14.864 |
| Damaged export | 16.853 | 25.977 | 15.440–19.808 | 15.221–33.420 |

Successful backup/export contention decreases in this workload. Failure-path and idle observations are noisy; damaged-export latency increases, so no general failure-path or device responsiveness improvement is claimed. The mutex still serializes saves with archive work.

The decoded bank-entry names and SHA256 values have identical aggregate hash `81d4915227fb6fd87038d70c57bbcc371b52aff98d71823405b0fabc15c3584b` in all runs. Export size changes from 12,604,131 to 12,600,211 bytes. The full native regression also reads both archives, checks compression methods, hashes and media formats, and imports/restores resources. Ordinary package formats and schema remain unchanged.

## Reproduce and limits

On a supported native host, after the normal App setup:

```sh
TAURI_CONFIG='{"bundle":{"resources":[]}}' PRACTIQ_BENCH_OUTPUT=/tmp/practiq-archive.json \
  cargo test --manifest-path app/src-tauri/Cargo.toml --release \
  performance::archive_contention -- --ignored --exact --nocapture
```

For comparison, run the identical probe on the recorded baseline and candidate source; compare input and decoded-entry hashes before interpreting timings. The recorded baseline used the pre-Clippy probe identified in metadata. Preliminary runs taken during other checks were excluded from this paired comparison; no production alternative was installed for them.

Releasing the mutex around snapshot/resource work was considered but not implemented: current garbage collection and restore can change resource lifetime, so independent preprocessing has not been established. This bounded compression change avoids that additional concurrency contract. Large WAV workloads, multiple simultaneous archives, actual command dispatch and target-device latency remain unmeasured; retain the mutex until a separate snapshot/lifetime design has evidence.
