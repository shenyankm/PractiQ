# Deep test audit — October 18, 2026

PractiQ combines a personal, self-hosted import service and Web client with an
offline practice app. This audit assumes that existing deployment model. It
traced production entry points, test/configuration references and historical
retirement evidence across Python, Rust, App/Web TypeScript and packaging/CI
scripts. Four component audits and independent cross-reviews informed the patch.

The starting revision was `b8e092c659d41284915b40bb1ff89dadbdb2bd14`.
The results below were recorded before publication. No dependency, database
schema, HTTP contract, coverage threshold or test timeout was changed.

Concurrent README work advanced the shared checkout to `main` at
`8a69de309086b0cde36e83322f9e9a5aaa1fd831`. The committed difference from the
starting revision contains only the two READMEs and four screenshot images.
All 27 audit source/test file hashes matched their validation fingerprint.

## Removal evidence and preserved coverage

| Removed surface | Evidence | Coverage retained |
| --- | --- | --- |
| Python `split_chunk_spans` and `source_presence_hints` wrappers | Tracked caller searches found only tests; document assembly already calls `split_chunk_plan` and `source_presence_plan`. | Existing assertions now exercise the production plan APIs. A small test helper asserts that its source-presence fixture fits exactly one chunk. All 169 existing tests in the changed Python test modules retain their parameterization and assertions. |
| Duplicate private splitter guard | `_legacy_split_chunk_spans` has one caller, which validates the same bounds before dispatch. The fallback algorithm remains active and is retained. | Zero/oversized targets, oversized questions, offsets, overlap, density and source-presence tests remain. |
| Test-only Rust `Store::resources` folder importer | `PickResources` was retired in `87b93f57`; the entire remaining implementation was behind `#[cfg(test)]`. Current imports use question-bank ZIPs. | All 15 former test calls were migrated or replaced. Standard ZIP fixture question payloads were compared with the old JSON inputs. Backup, reopen, practice, image lifetime and historical missing-resource assertions remain. |
| Office fake `wait_closed` method | No caller exists; the conversion path uses `write`, `drain`, `close` and process `wait`. | All 17 Office service tests remain. |
| App `Option`/`Item` aliases and editor `blankQuestion` re-export | No aliases are consumed; only three tests imported the re-export. The implementation and runtime callers already use `api.ts`. | Tests import the existing implementation directly; no test was deleted. |
| Eleven old English UI messages | Nine had only dictionary definitions; two also occur in retained negative UI assertions. UI lookup keys come from source, separately from persisted native errors. | Current guidance, negative assertions and all native/historical error translations remain. |

Native rejection coverage now runs through the production ZIP reader. Both
`imageRef` and `sourceRef` traversal cases assert the specific unsafe-path error.
The checksum case changes only the declared hash, so it cannot pass merely because
the resource length or image format is wrong. The 25 MiB image acceptance,
byte-exact backup/restore and over-limit rejection checks remain.

Legacy database/backup handling, old-error localization, schema/account upgrade
refusal, retired-route rejection and package checks against embedded AI engines
were retained. Their names or historical inputs do not make them obsolete.
Generated shared contracts, configured shadcn aliases and documented benchmark
entry points were also retained.

## Genuine bugs and weak assertions fixed

1. The Web client rejected oversized or incorrectly typed responses without
   cancelling unread bodies. `Client.request` now awaits its reader and cancels
   the body during cleanup without replacing the original result/error. Three
   regressions failed before the fix and passed afterwards: declared oversize,
   invalid MIME and oversized HTTP error bodies. The authentication test now
   explicitly requires rejection instead of passing when its `try` block succeeds.
2. PostgreSQL and RabbitMQ test fixtures registered container cleanup only after
   `docker run` succeeded. A startup timeout or failure could therefore leave a
   container without a cleanup callback. Registration now precedes startup;
   exceptions still propagate. Four fault-injection cases failed before the fix
   and passed afterwards, checking cleanup of the exact allocated container name.

## Validation

Raw local logs and deletion proofs are in
`server/reports/checks/deep-test-audit/`. Counts below describe separate checks;
the focused and packaging runs overlap the full service suite.

| Check | Result |
| --- | --- |
| Service `make verify` with explicit Python 3.14.7 and `PYTHONPATH="$PWD/server/src"` | 2,685 passed, no skips; 94.97% lines and 90.25% branches. Lock, Ruff, Pyright, 33 evaluation fixtures, probe gate, wheel/sdist build and source/lock archive integrity passed. |
| Focused service regressions | 442 passed; standalone Ruff and explicit-interpreter Pyright passed. |
| Packaging/CI baseline | 752 passed; two expected duplicate-ZIP-entry warnings. |
| App types, lint and coverage | 417 passed, one opt-in editor benchmark skipped; 93.57% lines, 85.48% branches. |
| App Chromium browser suite | 106 passed, including built touch navigation and both Android viewport projects. |
| App frontend production build | Passed. |
| Host Rust tests | 192 passed, 14 pre-existing ignores; binary and doc-test targets passed. |
| Rust format and Clippy, all targets with warnings denied | Passed. |
| Shared generated contracts and fixtures | Export check passed; 49 contract cases and the sample validated. |
| Web types, lint and coverage | 88 passed; 97.20% lines, 88.99% branches. |
| Web Chromium browser suite and production build | 32 browser tests passed; build passed. |
| Maintainer workflow unit tests | 25 passed. |

The first App coverage run timed out in three `QuestionRefresh` race cases while
other checks were running. The unchanged five-case focused run and unchanged
complete coverage run both passed. No assertion, timeout or threshold was
relaxed. The first log is retained as `app-check-ui-first.log`; timing under
concurrent load remains a reliability risk, not a reproduced stale-query bug.

A diagnostic Pyright command without an explicit interpreter reported missing
dependencies. The project command using the existing Python 3.14 interpreter
passed without source changes. Both diagnostic logs are retained.

The Rust ignores comprise ten opt-in performance profiles, two subprocess entry
points exercised by passing parent tests, the explicit 512 MiB backup boundary
and the native Keychain round-trip. None was newly ignored by this patch.

`final-validation.json` records counts, coverage, source identity and preservation
results. The service XML/probe outputs were copied to `server-final-*` files so
later standard checks cannot overwrite this run's evidence. Final whitespace
checks passed. No local check remains failing.

## Evidence boundaries

These are local checks with synthetic model responses. Browser suites use mocked
native commands or authenticated fake HTTP services. Windows/Android execution,
native UI/Keychain, clean-machine installers, live-model fidelity and remote CI
are outside this local run. Publication and current-head CI/review results are
tracked separately in the audit pull request.

The probe gate reports `PASSED` with no gate reasons and all four probe metrics
at 100%. It separately reports `durableCrashRecovery: NOT_ASSESSED`; this audit
does not promote that result to completed durability acceptance.

Of the original 2,186 untracked evidence files, 2,185 retained their original
hashes. The existing README gallery `pr-body.md` changed during concurrent
README work; it was left intact, and both hashes are recorded. This audit did
not edit or revert that file. Existing service check reports were copied aside
before `make verify` refreshed them.
