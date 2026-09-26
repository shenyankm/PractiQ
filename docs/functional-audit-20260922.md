> Storage update: the current version uses local files only; the OSS backend has been removed. References to OSS below are preserved as historical audit or design records.

# Functionality and error-handling audit

Audit date: 2026-09-22. Code baseline: `10722af8710c470dc71610d2309626870ca2bce4`. Existing README and first-release draft changes were preserved. No application code was changed, committed, or pushed.

Conclusion: major features passed existing automation, native storage tests, and macOS package checks, but this does not establish correctness of every feature and error path. Two additional P2 issues were reproduced and recommended for repair before the initial release. Live-model quality, complete native-window workflows, and clean-system installation still require acceptance.

## ZIP redesign follow-up

The original audit findings apply to the baseline above. The subsequent ZIP redesign fixed image recovery on duplicate import: image metadata is written and committed before deduplication, with regressions covering reads and backup/restore after image recovery. Bank ZIP import/export, a language popover menu, and logo switching were added. Final redesign checks passed: 89 frontend tests, 44 Rust tests, Clippy, bilingual browser checks at 960px, macOS packaging, and bundled-service checks with a synthetic model. New ZIP tests used temporary databases without touching personal banks. The original reproductions remain below. The stale-results-on-search-failure issue remained unfixed; that change did not expand scope to address it.

## Confirmed issues

### P2: Duplicate import cannot recover images omitted on the first import

Location: [store.rs](../app/src-tauri/src/store.rs), the duplicate-result return branch in `import_pending` (lines 298–311), before image metadata is written (lines 333–338).

Reproduction:

1. Import `app/fixtures/sample.json` without selecting an image directory and create a bank.
2. Import the same JSON again, selecting `app/fixtures/resources`. The preview correctly reports one loaded image.
3. Append to the original bank and confirm.
4. The receipt reports a duplicate import, but the image remains unavailable and the question still lacks its resource.

Cause: the image file is already on disk, but deduplication returns before registering metadata in `assets`. Image reads and missing-image checks depend on that table, so the file alone cannot restore the question. Backups also omit the unregistered image.

Validation: a Rust reproduction ran in a temporary source copy with temporary SQLite data. The preview count was one and `duplicate=true`; the subsequent assertion that `asset(hash)` should be readable failed because it remained `null`. No personal bank was used.

Proposed fix: transactionally register verified images even for duplicate question imports before returning the deduplication receipt. Preserve question deduplication and historical snapshots. Regressions must check image reads and backup/restore, not only file existence.

### P2: Failed question queries display old results under new filters

Location: [App.tsx](../app/src/App.tsx), the question-pagination error branch (lines 202–218).

Reproduction:

1. Open a question list successfully, such as the sample question “下面哪一个是质数？” (“Which of the following is prime?”).
2. Enter a search term that does not match that question.
3. Make the new `questions_page` request fail, for example through a temporary database lock.
4. The page shows only an error notification and stops loading. The previous questions and count remain while the search box displays the new filter.

Cause: the error branch neither clears old results nor retains their query identity or a persistent failure state. Banks, mistakes, bookmarks, and search share this request path; switching banks can likewise present old data as the new list.

Validation: a React test in a temporary source copy returned a sample question on the first request and threw `database is locked` on the new search. The assertion that the old question should disappear failed, confirming it remained visible.

Proposed fix: distinguish the current query from the last successful result. Hide stale results on failure or explicitly label their filters, and provide an inline error and retry. Cover both search and bank-switch failures.

## Feature results

“Passed” means only that the listed checks passed in this audit, not that every input, hardware condition, or service failure was exhausted.

| Feature | Evidence | Result and limits |
| --- | --- | --- |
| JSON import, preview, contract validation | 41 shared contract cases, basic/composite samples, Rust import-transaction and deduplication tests | Main path passed; duplicate import after omitted images had the issue above |
| Images, formulas, tables, shared material | Frontend content tests; Rust rich-content import/reopen/backup tests | Existing samples passed; arbitrary document-layout fidelity was not established |
| Bank creation, editing, deletion, copy-merge | Native storage, copy-independence, and historical-snapshot tests | Existing tests passed; deletion preserved historical snapshots |
| Search, bookmarks, mistakes, pagination | Pagination and complete-group filtering tests | Normal paths passed; stale results after request failure were reproduced |
| Seven basic and three composite question types | Contract, local scoring, frontend response, and composite tests | Existing samples passed, including ungraded missing answers and shared option-bank restrictions |
| Draft save, resume, switching, exit confirmation | Frontend save interactions, native reopen/immutable snapshots, inspection of exit-save logic | Tested paths passed; end-to-end disk-full and forced-termination faults were not exhausted on hardware |
| Cross-bank papers, self-tests, timed exams | Paper previews, point allocation, deadlines, submission, and native end-to-end tests | Tested paths passed; native-window sleep/wake acceptance was not run separately |
| Objective scoring, manual overrides, score review | All basic scoring modes, point constraints, manual precedence, and history tests | Tested paths passed; incomplete questions must not all be marked incorrect |
| AI subjective grading | Service grading tests, native request records, bundled service with a synthetic model | Evidence checks, partial credit, request reuse, and unknown outcomes passed; live-model grading quality was not established |
| PDF, TXT, CSV, PNG/JPEG parsing | Service format tests and actual bundled Python service checks | All four source-format categories completed with a synthetic model; Word, Excel, and removed image-format rejection passed |
| Pause, resume, interrupt, failed-unit retry, partial-result review | Scheduling, checkpoints, task APIs, process recovery, failed-unit tests | Tested paths passed, including recovery after a persisted submission lost its wake-up signal |
| Unconfirmed requests, batch import, stop remaining items | Rust `ai_work` tests | Original request identity, per-item failure isolation, stop/resume, and database receipt recovery passed |
| Backup and restore | Corrupt-archive rejection; relationship/contract/digest checks; native restore into a new directory | Existing tests passed; the duplicate-image issue omitted unregistered images from backups |
| Settings and credentials | Configuration validation and native Keychain read/write/delete with an isolated entry | Passed; actual user model credentials were neither read nor changed |
| Chinese/English switching, sidebar, keyboard interaction | Dictionary/interaction tests and Playwright bilingual checks at 960px | Passed; browser mocks of Tauri do not establish full native file-picker acceptance |
| Standalone authentication, upload, artifact access, health | HTTP end-to-end, upload limits, path/digest, and authentication tests | Tested paths passed; real OSS and deployment infrastructure were not connected for acceptance |

## Run results

Python was `~/.local/share/uv/python/cpython-3.14-macos-aarch64-none/bin/python3.14`; no project virtual environment was created.

| Check | Result |
| --- | --- |
| `make verify AI_PYTHON=...` | Passed: lockfile, Ruff, Pyright, evaluation fixtures, 525 tests, 94% coverage, recovery probes, Python package build |
| `make app-check AI_PYTHON=...` | Passed: shared contracts, TypeScript, 87 frontend tests in 11 files, 40 Rust tests, Clippy |
| `cd app && npm run test:browser` | Passed: bilingual layout, sidebar, keyboard switching, focus, and draft preservation; no model requests |
| `make app-build AI_PYTHON=...` | Passed: Apple Silicon `.app` and `.dmg`; a frontend chunk warning above 500 kB was not a build failure |
| `python3.14 app/scripts/check-bundle.py --bundle app/src-tauri/target/release/bundle/macos/PractiQ.app/Contents/Resources/bundled` | Passed: actual packaged Python service checks for text, CSV, image, PDF, removed-format rejection, and grading, using a local synthetic model |
| `TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo test --manifest-path app/src-tauri/Cargo.toml native_keychain_roundtrip -- --ignored` | Passed: one native Keychain test with a separate test entry, removed afterward |
| Two additional defect reproductions | Both expected-behavior assertions failed, confirming the image-recovery and list-error issues above; counted separately from existing passing tests |

Default Rust checks skipped synthetic performance stress and Keychain tests. Keychain ran separately; performance stress did not run in this audit. Service end-to-end tests were included in `make verify`, and native offline end-to-end tests in `make app-check`; they were not counted twice.

Reviewable service reports: `server/reports/checks/probes.xml`, `coverage.xml`, and `probes.json`. Detailed local logs were at `/tmp/practiq-audit-{server,desktop,browser,build,package,keychain,repro-native,repro-ui}-20260922.log`. Temporary reproduction source was at `/tmp/practiq-functional-audit-20260922/`. These are not release artifacts and may be removed by the system.

## Unverified areas

- No external paid models were called. Extraction completeness on real papers, complex layouts, image cropping, and short-answer grading accuracy still require real-data evaluation.
- This was a local package build. Download/install, Gatekeeper, signing/notarization, native file pickers, and complete window workflows were not accepted on a clean Mac.
- Tests cover designed fault points, not every combination of power loss, disk exhaustion, Keychain denial, network timing, and third-party failures.
- Native Windows execution, real OSS, remote CI, and Docker deployment were not verified. Conclusions apply only to the macOS code and local validation environment tested here.

Release recommendation at the time: fix both reproduced issues with focused regressions, then complete native-workflow and live-model acceptance on the final candidate package. The evidence supports continued internal trials, not a claim that all features and error paths are correct.
