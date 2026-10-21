# Traditional Chinese acceptance — 2026-10-21

This record covers the existing locale work synchronized onto main at `fb91d2cf`, the UI conflict resolutions, and the database/backup hardening added during review. All screenshots use synthetic fixtures and mocked native commands; they are browser evidence, including touch emulation, rather than native Android or Windows acceptance.

## Database and backup checks

- The exact legacy schema-11 settings constraint is accepted; unrelated schema changes remain rejected.
- The complete schema is validated under an immediate SQLite transaction before rewriting settings. Rechecking after acquiring the lock handles another instance upgrading first. Transaction failure rolls back the table rewrite.
- The expanded rejection regression failed before the fix: startup rejected an altered legacy database after changing its bytes. It now passes for 14 alterations × two line endings × current/legacy settings, asserting unchanged database bytes and no live replacement on restore.
- A deliberately invalid legacy locale forces an insertion failure during upgrade and verifies the original database bytes survive the rollback.
- Old backups retain bank content, saved language and legacy provider fields; after restoration they can save `zh-TW`, create another full backup, restore through resource recovery, and reopen successfully.
- Existing pending-restore, image/audio integrity, immutable practice and grading-receipt tests remain in the full native suite. The extended frozen-language regression also passes: explicit retry can select `zh-TW`, and a subsequent replay after changing the UI/request language preserves the same Traditional Chinese payload, digest and request ID.

The schema version remains 11 and the backup container version remains 4. Older app builds reject the expanded settings constraint; keep pre-upgrade backups for rollback.

## Local verification

Environment: macOS arm64, Node.js 22.23.2, Python 3.14.7, Chromium, Rust host toolchain. `AI_PYTHON` denotes the existing Python 3.14.7 interpreter; no project virtual environment was created. Python scripts use `PYTHONPATH="$PWD/server/src"` to select this checkout.

| Check | Result |
| --- | --- |
| Shared contract exporter `--check` and fixture checks | Passed: 49 shared cases and sample fixture. No generated-contract drift. |
| App TypeScript and ESLint; `npm --prefix app run test:coverage -- --maxWorkers=2` | Passed: 464 tests; three existing skips. Statements 90.63%, lines 93.74%. The first unrestricted parallel run timed out in the 1000-button performance test; the complete coverage rerun passed with two workers and unchanged timeout. |
| `TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo test --manifest-path app/src-tauri/Cargo.toml --locked` | Passed: 214 tests, 16 existing ignored benchmarks/explicit integration checks; binary/doc test targets also passed. Temporary databases only. |
| `cargo fmt --manifest-path app/src-tauri/Cargo.toml --check` and Clippy `--locked --all-targets -- -D warnings` | Passed. |
| App `npm run test:browser -- --output=.build/zh-tw-browser --reporter=json`, followed by focused changed cases | Passed across all 146 unique cases after corrections; see [run summary](browser-summary.json). The first run passed 140 and failed six stale selectors. Follow-up corrections cover renamed empty-state/grade labels, scoped Traditional Chinese settings selection, and keyboard traversal through all three language choices. The final focused run passed all nine selected/dependency cases. |
| Web TypeScript, ESLint and coverage checks | Passed: 163 tests. Statements 94.77%, lines 97.30%. |
| Web browser suite and focused import-flow rerun | Passed across all 43 cases: 41 initially passed; two import-flow cases passed after updating the renamed Tencent/App text assertions. |
| App and Web production frontend builds | Passed. |
| `PYTHONPATH="$PWD/server/src" make verify AI_PYTHON="$AI_PYTHON"` | Passed: 3010 tests, eight warnings, configured total coverage 93% (line coverage 94.25%, branch coverage 88.99%); lock consistency, Ruff, Pyright, evaluation fixtures, PostgreSQL/RabbitMQ recovery probes, source/wheel build and package integrity all passed. The first attempt was blocked by a stale Docker backend and an unrelated broken editable-install path; restarting the backend and selecting this checkout through `PYTHONPATH` resolved the environment issues. |

The App browser checks cover a production-built touch drawer at 360px and 390px in all three languages, sidebar alignment and keyboard focus, saved preferences after reload, and no unexpected native/model calls. New system-language cases respect explicit Hans/Hant scripts even when the region differs. Grading tests use model substitutes.

## Screenshots

| Screenshot | Evidence |
| --- | --- |
| [360px navigation](APP-ZHTW-360-navigation.png) | Production-built frontend, touch emulation, Traditional Chinese, synthetic native-command responses. |
| [390px navigation](APP-ZHTW-390-navigation.png) | Same boundary at 390px. |
| [Desktop settings](APP-ZHTW-960-service-settings.png) | 960px desktop frontend, Traditional Chinese service settings, synthetic endpoint and no real token. |

## Limits

This is local functional/storage and browser acceptance. Native Windows/Android flows, physical devices, system file pickers/IME, credential-store behavior on those platforms, signed packaging, and live-model quality were not exercised. Remote CI, review and merge status must be read separately from the PR.
