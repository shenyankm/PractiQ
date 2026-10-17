# Independent review and remediation — 2026-10-17

The user requested independent review of authentication, legacy data protection and remaining account/billing functionality, followed by local fixes and renewed acceptance. Three independent read-only reviewers examined those areas and reviewed the fixes. No commits, pushes or production migrations were performed.

## Findings and fixes

1. **P1 — Unsettled legacy call evidence could be deleted after upgrade.** Schema 3/4 with no remaining customer task/upload but a `pending` or `unknown` `import_calls` row was accepted as personal schema 5. Subsequent orphan cleanup deleted its Store call/result evidence while leaving the unresolved accounting row. A reviewer reproduced this with a disposable PostgreSQL database: two evidence records became zero. Upgrade now refuses these databases before mutation, including calls whose task has been deleted. The original deployment and matching data must be archived together; no accounting implementation was restored.
2. **P2 — Incomplete legacy schemas were accepted.** A schema-4 database missing `import_uploads` was treated as having no uploads and upgraded. Upgrade now validates the full historical account table set for schemas 3/4 and rejects account objects mixed into pre-account schemas 1/2. Tests use a fixed copy of the actual historical DDL, rather than a minimal synthetic ledger/table setup.
3. **P3 — Error recovery still mentioned accounts and orders.** Web render-failure copy and its test now refer to reconnecting the personal service and querying the original task.
4. **P3 — Historical fixture documentation described a deleted producer.** The historical ZIP remains unchanged for Rust import compatibility. Its README now identifies it as a fixed historical archive, removes the broken regeneration command and accurately distinguishes current personal export coverage.

No independent reviewer found a concrete new authentication bypass. Every protected `/api/` method (16 methods) rejects missing, wrong Bearer and retired Account credentials: 48 requests in a permanent regression test, without starting the runtime or accessing storage. Artifact reads still validate the authorized task, full reference membership, path, size and checksum. Web tokens remain in memory and same-origin requests reject redirects.

The two legacy-data fixes passed independent re-review. Affected upgrade failures leave the schema marker, historical rows and Store evidence unchanged. Resolved historical calls, balances and ledgers remain eligible for upgrade and are preserved. The old checkout ownership lock is deliberately retained for offline exclusion; it is not an active payment feature.

## Reproduction evidence

New tests failed against the pre-fix implementation: an unsettled-call case did not raise, and all 14 incomplete/mixed-schema cases were accepted. The local failure log is retained as `review-before-fix.log`. Initial full rechecks stopped at strict typing in two new test expressions; the failure logs are retained as `review-verify-before-type-fix.log` and `review-verify-before-fixture-bytes.log`. The fixture is now executed as bytes, accepted directly by psycopg, and the optional route-method set is handled explicitly.

## Final renewed acceptance

| Check | Result |
| --- | --- |
| `make verify` with this checkout on `PYTHONPATH` and the existing Python 3.14.7 interpreter | Exit 0; Ruff, Pyright, lockfile, 33 evaluation cases, 2,667 tests, recovery probes, wheel/sdist and source/lock integrity passed |
| Coverage | Lines 94.96% (5,991/6,309); branches 90.22% (2,149/2,382) |
| Protected API rejection matrix | 16 methods × 3 invalid/retired credential forms, all 401; no runtime/storage access |
| Personal-mode and upgrade regression tests | 31 personal-mode tests and 9 queue/upgrade/recovery tests passed within the full run |
| Web check / build | 85 tests, types, lint, coverage and production build passed; lines 97.18% |
| Chromium acceptance | 32 passed, including token lifetime, explicit recovery, task controls and error isolation at 1440px/390px |
| App check | 415 frontend tests passed/1 existing skip; 192 host Rust tests passed/14 existing ignored; shared contracts, formatting and Clippy passed |
| Local hygiene | `git diff --check`, 157 changed-document local links and backup shell syntax passed; disposable test containers removed, pre-existing containers preserved |

Final logs are retained locally as ignored `review-*.log` files. The pre-existing dependency audit and alert-rule checks from the initial removal remain valid; those inputs were unchanged by this review. No further source changes were made during the successful full run.

Package SHA-256:

- Wheel: `42bb23fbb5a15b53abb99079ee05221a6400e267d7ce2abd1ab8dbd282d39c2c`
- sdist: `c9622784adea80b510044c9b4fbe3838918cec6b318b069e7d6be849af8245b7`

## Acceptance boundaries

All database exercises use disposable PostgreSQL/RabbitMQ state and synthetic model responses. No private database, storage, credentials or unrelated acceptance screenshots were changed. No real provider, production migration, Windows/Android native run, installer/image build or remote CI/review/merge is established by these checks.

Browser recovery screenshots: [390px](web-render-recovery-390.png), [1440px](web-render-recovery-1440.png). Both show the corrected personal-service wording.
