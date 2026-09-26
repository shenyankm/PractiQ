# SQLite and macOS desktop delivery record

> Historical report: results, package sizes, hashes, and dependency descriptions apply to the version tested at the time. The current version has removed Word and LibreOffice. The Import page manages AI parsing tasks; bank ZIP import is under Settings → Restore backup. See the [project overview](../../README.md) and [service guide](service-guide.md) for current usage. Historical evidence does not establish acceptance of the current version.

Validation date: 2026-09-19. Target: Apple Silicon macOS. The local system was macOS 27.0; the app declared macOS 14 as its minimum, but that version had not been tested. Nothing was committed, pushed, or published. Existing workspace changes and old PostgreSQL data were preserved.

## Scope

- Replaced the task queue with aiosqlite and used the official SQLite checkpoint and Store implementations, in three separate database files. All service connections use WAL, FULL synchronization, foreign keys, and a five-second busy timeout. The service and offline maintenance share an exclusive flock lock. Idempotency, run constraints, budgets, expiry, and recovery semantics remain intact.
- The standalone service uses `AI_DATABASE_DIR` for local data and requires explicit `init-db`; the desktop initializes its dedicated directory automatically. Old `DATABASE_URI` configuration fails explicitly, without migrating or deleting old data. Interrupted initialization can retry; unknown databases and versions are rejected.
- Rust manages a PyInstaller onedir service at a fixed resource path, passing a random token and Keychain credentials through private stdin. Python binds a random loopback port. The WebView uses only typed commands. App exit or parent disappearance triggers shutdown; isolated extraction subprocesses exit when their pipes close.
- Added desktop dual-model settings, document selection, paginated tasks, stage/completion counts, failure details, usage, pause/resume/interrupt/retry/partial-result acceptance, and reuse of the bank-import preview. Configuration changes stop the old service. Incompatible execution signatures prevent resume. Tasks wait for explicit resume after restart.
- Migrated desktop BLOB images individually to SHA-256 files, writing and syncing before committing database references and retaining an upgrade-recovery copy first. Images are copied from AI storage into bank storage, so practice snapshots do not depend on AI retention. ZIP v2 includes a manifest, database, and images, retains v1 restore support, and excludes AI tasks, source documents, checkpoints, and Keychain credentials.
- Removed Excel source parsing, worksheet graphs, contract routes, evaluation samples, and openpyxl as requested. XLS/XLSX uploads return 422, and file pickers no longer offer them. Deprecated worksheet-association fields in old JSON/backups are ignored only during desktop reads; they do not enable parsing. Historical acceptance records remain with scope notices.

## Packaging

Python 3.14.7 and PyInstaller 6.22.3; LangGraph SQLite 3.1.1 and aiosqlite 0.22.1. The full dependency lock is `server/uv.lock`; the actual bundled distribution manifest is `Contents/Resources/bundled/build-manifest.json`.

The package included full LibreOffice 26.2.6 arm64, with a pinned download URL and SHA-256: `94bb3248df074c225490a8a6d1d9dc87c7d6783dbb7a8e9f0d0c3d94348552af`. It retained the complete upstream app, licenses, third-party notices, and source links. The upstream suite therefore still included Calc, although PractiQ no longer had an Excel parsing entry point, implementation, or Python dependency. Word used bundled Writer with a separate profile directory for each conversion. The service container installed only Writer.

To preserve PyInstaller's onedir layout, packaging used Tauri `bundle.resources` and a fixed-path Rust subprocess instead of moving the executable alone into `externalBin`. No generic shell or HTTP command was exposed.

Reproduction commands:

```sh
make install-locked app-install-python AI_PYTHON=/path/to/python3.14
make app-install
make verify AI_PYTHON=/path/to/python3.14
make app-check AI_PYTHON=/path/to/python3.14
make app-build AI_PYTHON=/path/to/python3.14
/path/to/python3.14 app/scripts/check-bundle.py \
  --bundle app/src-tauri/target/release/bundle/macos/PractiQ.app/Contents/Resources/bundled
cargo test --manifest-path app/src-tauri/Cargo.toml native_keychain_roundtrip -- --ignored
```

## Engineering validation

- `make verify`: 447 tests passed, with 91% coverage. Lockfile, Ruff, Pyright, structural validation of 23 evaluation samples, recovery probes, and sdist/wheel builds passed. No real models were called.
- SQLite regressions covered initialization retry, duplicate requests, concurrent queues, pause/review ordering, failed-unit retry, budgets/unknown usage, expiry cleanup, exclusive-lock rejection, write-lock waits, SQLITE_FULL rollback, and recovery after forcibly killing the actual service process.
- `make app-check`: nine frontend tests, ten Rust tests, and Clippy passed. The native Keychain test, skipped by default, passed separately using only a randomly named temporary entry that was deleted afterward.
- Rust checks covered BLOB migration, shared images, immutable practice snapshots, corrupt images, ZIP paths/links/sizes/checksums, old backups, and restore-failure protection. This was not a complete power-loss fault matrix.
- The native UI was checked for the parsing entry point, dual-model settings, missing-configuration hints, and preservation of existing banks. User model credentials were not changed.
- Final package results were recorded in `../reports/checks/desktop-bundle.json`. Validation used only a local synthetic model, restricted PATH to `/usr/bin:/bin`, and a temporary HOME, invoking the actual `.app` Python, isolated parser, and LibreOffice.

Raw outputs were saved in `server/reports/checks/`. An earlier package check failed because the model stub did not cover the worksheet protocol; that capability was subsequently removed. One conversion-timeout test failed under heavy load; the final full regression passed. Failure records do not support quality or distribution guarantees.

## Database comparison under the same workload

The baseline was an isolated git archive of `cf0b1768b51ab79ac56fac1cc6cc8f75ea090646`. PostgreSQL 16 ran in a temporary Docker container created for this comparison; only that container was deleted afterward, leaving existing databases and volumes untouched. Both versions used the same `scripts/benchmark_runtime.py`, text input, 40 tasks, concurrency of eight, and model stub waiting 0.1 seconds per call. Three rounds alternated between versions, each completing 40 calls and 40 tasks.

| Median of three rounds | PostgreSQL baseline | SQLite |
| --- | ---: | ---: |
| Total duration (seconds) | 5.639 | 2.971 |
| Successful documents/minute | 425.58 | 807.85 |
| Queue wait (milliseconds) | 1553.06 | 1264.11 |
| /ok P95 (milliseconds) | 7.35 | 3.06 |

Full per-round data was recorded in `../reports/checks/sqlite-comparison.json`. Health checks used in-process ASGI requests. PostgreSQL used a Docker port while SQLite accessed local files directly, so topology differed. These results describe only a local synthetic short-text workload, not real-model throughput, long-document capacity, or a production SLO.

To reproduce one round, install the matching dependencies in the corresponding source tree, point `PYTHONPATH` at that version's `server/src` and `server`, and run the current `server/scripts/benchmark_runtime.py --output /absolute/result.json`. The PostgreSQL baseline also requires `TEST_DATABASE_URI` pointing to a dedicated disposable instance. Current SQLite creates temporary databases automatically. Never point this check at a business database.

## Local build artifacts

- `app/src-tauri/target/release/bundle/macos/PractiQ.app`
- `app/src-tauri/target/release/bundle/dmg/PractiQ_0.1.0_aarch64.dmg`
- DMG size: 363.6 MiB; SHA-256: `28988327a2848648bb2fcdafce5bf2c711b7565b892e965bd8997ee7ac9e8b0c`.
- The actual `.app` passed five-format checks, XLSX rejection, authentication, paginated queries, image checksums, and exit cleanup. It contained neither openpyxl nor the PostgreSQL Python backend.
- Python and full LibreOffice resources occupied approximately 935 MiB, mostly from the untrimmed LibreOffice suite.

## Acceptance limits

This delivery was a locally validated package. Structured correction, desktop model parameters, and diagnostics were fixed. The retained version completed 63/63 normal executions and passed strict content quality in 60/63, so quality was not fully passing. A high-resolution candidate was withdrawn after full regression failed; see the [final repair report](../reports/evaluations/vision-fix-delivery-20260919-230113/acceptance.md). Minimum macOS 14, a clean system, all input variants, and the full power-loss recovery matrix were not validated. Synthetic-model results do not establish question, answer, or image-association quality.

No Apple Developer ID or notarization credentials were provided, and formal signing, notarization, and publication were not performed. `scripts/sign-release.sh` provides nested-binary signing, app signing, notarization, stapling, and spctl verification; run and verify it separately in a credentialed distribution environment. These `.app`/`.dmg` artifacts did not pass formal distribution acceptance.
