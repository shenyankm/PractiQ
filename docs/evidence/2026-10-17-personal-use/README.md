# Personal self-hosted use — 2026-10-17

This local working-tree change removes PractiQ account management and built-in billing. It does not migrate an existing deployment or establish remote CI/release acceptance.

## Result

- Removed phone/account-token authentication, account management commands, point rates, balances, ledgers, products, checkout routes/UI, payment SDK dependencies and related operational settings.
- The Web importer and explicit App grading share the existing service Bearer token. Web credentials remain in page memory; provider keys remain server-side.
- Retained source validation, bounded uploads, task receipts, model-call budgets/usage, unknown-result recovery, partial ZIP export and offline practice.
- New service databases use schema 5 without account/payment tables. Explicit offline upgrades preserve historical tables and refuse adoption of customer tasks, upload records or unsettled accounting calls; incomplete/mixed historical schemas are also refused. Existing private databases, storage and credentials were not modified.
- Updated generated Web/App contracts, active guides, repository guidance and the [README connection screenshot](../../assets/new-web-import.png). Unrelated acceptance screenshots were preserved.

See [personal deployment and safe migration](../../../server/docs/personal-use.md) for schema, storage and checkpoint compatibility.

The subsequent [independent review and remediation](independent-review.md) records the legacy-data fixes, residual-copy cleanup and renewed acceptance.

## Validation

| Check | Local result |
| --- | --- |
| Service `make verify` | 2,667 passed; 94.96% line coverage, 90.22% branch coverage; 33 evaluation cases, recovery probes, wheel/sdist build and archive source/lock integrity passed |
| Web types, lint and coverage | 85 passed; 97.18% line coverage |
| Web Chromium browser suite | 32 passed, including desktop/narrow layouts, token lifetime, explicit mutations, partial ZIP export and recovery |
| Web production build | Passed |
| App shared contracts/fixtures, types/lint, frontend and host Rust checks | 415 frontend tests passed, 1 skipped; 192 Rust tests passed, 14 ignored; formatting and Clippy passed |
| Locked Python runtime/dev/build dependency audit | Passed; no known vulnerabilities reported |
| Prometheus alert tests and example configuration syntax | Passed |
| Changed documentation links and backup shell syntax | Passed |

Commands used the existing Python 3.14.7 interpreter. `make verify` used `PYTHONPATH=/Users/sheny/Developer/code/PractiQ/server/src` so evaluation scripts imported this checkout rather than an unrelated editable installation. No project virtual environment was created. An earlier full run exposed six stale fixture expectations (old Bearer denial, account-forced serial dispatch and a synthetic token mismatch); all 40 related tests passed after correction, followed by the successful complete rerun. Its original failure log is retained locally. Local command logs are retained alongside this record as ignored `.log` files.

## Limits

Service and browser checks use model/provider substitutes. No live provider call, real-customer migration, production deployment, new installer/image build, Windows/Android native acceptance or remote CI/review/merge was performed. The App's SQLite schema 11, v4 storage and platform credential behavior were not changed. Old execution signatures require the original deployment for continuation or an explicit new parse under the new version; eligible saved results remain readable/exportable.
