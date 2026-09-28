> Historical evidence: behavior, measurements and validation apply only to the dated baseline below. They are not current usage instructions or acceptance of the current release.

# Review fixes — 2026-09-28

This tracks ISSUE-001–016 from the full-project review of `f999b4dbccc004b2302b32232e9d10c2bfd22ef4`. Validation below records local results; current remote CI status is reported on the pull request. Regression coverage describes the checks added for each fix, not release acceptance.

**Validation status: local checks passed.** `make verify` passed with 669 Python tests, 2 skipped, 92% coverage, Ruff, Pyright, 22 evaluation fixtures, recovery probes and wheel/sdist builds. `make app-check` passed with 213 frontend tests and 125 Rust tests (2 ignored), shared-contract/fixture checks, TypeScript, ESLint, rustfmt and Clippy. The Vite production build, the original bilingual Chromium browser check and `git diff --check` passed. These are local results on macOS; no real model calls or user learning data were used.

Python runtime/dev/desktop dependency auditing reported no known vulnerabilities. Cargo auditing completed with seven informational warnings, detailed below. Two early browser runs timed out, one overlapping UI edits and hot reloads; a diagnostic rerun and the unchanged original browser check subsequently passed. No browser assertions were removed. The original legacy-image test fixture was corrected to construct the actual historical schema; current-schema orphan cleanup has separate passing coverage.

Before opening the pull request and again after the review follow-up, `make app-package-check` passed on Apple Silicon macOS: native `.app` and `.dmg` builds completed, and the packaged service passed its synthetic-local-provider parsing, grading and read-only restart checks. This does not replace clean-machine installation or live-model acceptance.

## PR 76 review follow-up

The review follow-up fixes four functional comments and the Windows test failure: annotated variant/count omissions in the scorer, dangling partial-passage links after conflicting units, tree-wide keyword matching with pending review, and credential removal from unsaved settings. Windows preserved CRLF in SQLite CREATE statements while legacy fixtures used LF; schema comparison now normalizes only that line-ending difference, retaining all other definition checks.

The added recovery tests cover duplicate IDs and composite continuations across text/page units, both review policies, retained checkpoint evidence and explicit retry. Settings removal requires a successful autosave and affects only the current saved endpoint; historical endpoint keys are not automatically cleared. An intermediate local verification was blocked because tests changed during the run, triggering the source-fingerprint guard; the stable-source rerun passed. No probe or coverage gate was disabled.

## Issue tracking

| Issue | Change | Regression coverage |
| --- | --- | --- |
| ISSUE-001 | Restore recognizes the supported schema-10 column/table variants and LF/CRLF checkout line endings before normalizing a staged database. Unknown schemas, triggers and index definitions remain rejected. | All 16 combinations of legacy visual/playback/activity fields and the review table, before and after startup migration; bank/history preservation; LF/CRLF restore and re-backup round trips; malformed backup rejection under either line ending without changing the live database. |
| ISSUE-002 | Mixed-bank snapshots and copied banks turn document-level visual scope into explicit source-bank question IDs. Single-bank snapshots and ZIPs retain the original unassociated-document warning. | Mixed-bank freeze/thaw, copy/merge and single/merged-bank ZIP round trips retain the appropriate scope. Existing immutable historical snapshots are not rewritten. |
| ISSUE-003 | Duplicate IDs inside one model response enter bounded output correction. Cross-unit conflicts return the conflicting unit to an explicit retryable review state, retaining successful units. | Real graph/checkpoint tests with fake providers cover text and vision, review/partial policies, successful-unit preservation and explicit retry. |
| ISSUE-004 | Accepting partial results clears unavailable parent/shared-option references. Missing passage children become noninteractive evidence with material review flags; successful checkpoints retain original links for explicit retry. | Failed parents and failed children produce valid partial results without inventing questions or options. Text/page conflicts and incompatible continuations preserve successful evidence; explicit retry restores passage links. |
| ISSUE-005 | Scorer `5.0.1` adds `structureAccuracy` and rejects any annotated structure mismatch; `text-composites` is critical. | Wrong materials, parent/option-owner/blank references, shared options, annotated choice/matching variants and blank counts, missing/extra structures and harmless ID remapping; noncritical errors cannot disappear in averages. A new live baseline is still required. |
| ISSUE-006 | A native continuous session clock drives draft validation and exam deadlines; the UI resynchronizes with it. | Injected forward/backward wall-clock jumps, suspended time, restart rollback and forward expiry preserve saved drafts. Browser clock tests cover resynchronization. See the timing policy below. |
| ISSUE-007 | The shared JSON body limit covers every document-task mutation, including reparse. | Oversized bodies with and without Content-Length, streamed input, unauthenticated requests, and limit-sized authenticated requests. |
| ISSUE-008 | Adding an option chooses an unused label without renumbering existing options or answers. | Delete the middle option, add another, and save valid unique labels while preserving existing references. |
| ISSUE-009 | Reallocating points retains the preview's question IDs/order and validates its content digest. | Random-paper reallocation preserves content; changed source content is rejected instead of silently substituted. |
| ISSUE-010 | Changing a paper removes budgets for types no longer present. | Hidden budgets cannot enter allocation validation or reappear when an old filter is restored. |
| ISSUE-011 | Asset collection removes orphaned question-specific visual metadata before collecting unreferenced bytes. | Deleting questions releases orphaned images; document-level material and immutable-history references remain protected. |
| ISSUE-012 | Explicit local review confirmation uses `reviewedAt` for the complete question tree, separately from imported quality flags. | Pending filters and counts, keyword matches across the complete candidate tree, restart, edit invalidation, full-backup restore, ZIP/copy exclusion, invalid child IDs, and the UI action. See review semantics below. |
| ISSUE-013 | New model output with `confidence < 0.5` deterministically requires review. | Boundary values preserve confidence, answers and source evidence; the rule does not rewrite historical or independently imported banks. |
| ISSUE-014 | Settings removes the key for the current successfully saved endpoint. Unsaved, pending or failed drafts disable removal; ordinary blank edits remain non-destructive. | Successful removal, retry after failure, endpoint changes and reverts, and pending/failed blur saves. Historical endpoint keys are not automatically deleted. |
| ISSUE-015 | English settings instructions describe autosave; Chinese import instructions and the release draft describe local LibreOffice conversion and the service upload boundary. | Documentation compared with the current UI and conversion implementation; release acceptance boxes remain unchecked. |
| ISSUE-016 | Python auditing includes runtime/dev/desktop extras; Linux CI runs a full Cargo.lock audit with pinned `cargo-audit 0.22.2`. | Audit input coverage and nonzero-exit propagation; real Python/Cargo scans. No project lockfile updates or advisory ignores were added. |

The focused checks live with the existing suites: backup/review/session/visual Rust tests, editor/setup/settings frontend tests, and parsing/middleware/evaluation/CI Python tests. Run `make verify`, `make app-check`, and the documented browser and dependency audits for combined validation. Tests using model substitutes establish recovery and validation behavior, not live-model accuracy.

## Review, timing and history semantics

Human review is a local acknowledgement for a root question and all its descendants. `reviewedAt` is separate from `needsReview`, `missingFields`, confidence and source evidence, which remain intact. Confirmation removes the tree from the pending-review filter; it does not establish answer correctness or make incomplete answers automatically gradable. Editing the tree clears its confirmation. Full study backups retain confirmations; shared bank ZIPs, copied/merged banks and practice snapshots do not carry them.

The first session operation establishes one time base from the later of the current wall clock and the latest saved creation/activity/submission/completion time across local sessions. It then advances only with continuous elapsed time, including system sleep; opening old history cannot move that base. A successful full restore resets it. After restart, a backward clock is therefore floored at the latest saved session time. A forward wall-clock jump beyond an exam's persisted deadline still submits the exam with its saved drafts. While the application is closed, it cannot distinguish a deliberate clock change from real offline time; this is a personal-practice policy, not a guarantee suitable for formal examinations. Physical sleep/resume and target-platform acceptance remain pending.

The image-scope fix applies when creating new snapshots or copies. Previously stored immutable snapshots remain unchanged; it cannot reconstruct source scope that an older snapshot did not preserve.

The first upgrade conservatively preserves unassociated visuals from legacy `DEFAULT 0` scope migrations. Those rows no longer retain enough provenance to distinguish document-level material from old orphans, so some old unused files may remain. Newly orphaned question images are still collected; current-schema rows are not reclassified.

## Dependency audit warnings

The local `cargo-audit 0.22.2` scan checked 594 locked crates against 1,271 advisories and exited successfully with seven default-allowed informational warnings. Success does not mean zero advisories:

| Dependency | Advisory | Dependency path and follow-up |
| --- | --- | --- |
| `glib 0.18.5` | [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html), INFO Unsound | Tauri → GTK/WebKitGTK → glib on Linux. The affected `VariantStrIter` implementation is fixed in glib ≥0.20.0. Product reachability has not been demonstrated; upgrading requires a compatible upstream GTK/Tauri dependency path. |
| `proc-macro-error 1.0.4` | [RUSTSEC-2024-0370](https://rustsec.org/advisories/RUSTSEC-2024-0370.html), unmaintained | Tauri → GTK/glib → gtk3-macros/glib-macros. Track the upstream replacement. |
| `unic-char-property`, `unic-char-range`, `unic-common`, `unic-ucd-ident`, `unic-ucd-version`, all `0.9.0` | [2025-0081](https://rustsec.org/advisories/RUSTSEC-2025-0081.html), [2025-0075](https://rustsec.org/advisories/RUSTSEC-2025-0075.html), [2025-0080](https://rustsec.org/advisories/RUSTSEC-2025-0080.html), [2025-0100](https://rustsec.org/advisories/RUSTSEC-2025-0100.html), [2025-0098](https://rustsec.org/advisories/RUSTSEC-2025-0098.html), unmaintained | Tauri → tauri-utils → urlpattern → unic. Track compatible upstream replacements. |

The gate retains these warnings and fails on vulnerability errors. It does not silently suppress advisories or automatically upgrade dependencies. This closes the missing-audit coverage issue, not the upstream maintenance warnings.

## Acceptance still outstanding

- **G-01 — Live extraction:** scorer 5 requires a new passing baseline with at least three live-model repetitions before quality comparisons. None were run here. Historical scorer-4 reports remain historical and cannot supply that baseline.
- **G-02 — Office fidelity:** the existing eight conversion cases do not establish complete layout/content fidelity. Historical DOC fraction loss and table-ending DOCX text-export failures still need preserved regression inputs and current-engine verification.
- **G-03 — Release/platform acceptance:** no new RC/tag, signing/notarization, clean-machine install/upgrade/uninstall, native-dialog or complete target-platform acceptance was performed. Previous CI success belongs to the reviewed commit; these changes require their own remote checks.
- **G-04 — Failure injection:** complete disk-full, read-only, database-lock, forced-exit and interrupted-restore acceptance remains outstanding.
- **G-05 — Grading quality:** repeated live grading with independent human anchors and score-variance analysis remains outstanding.
- **G-06 — Scale and interaction:** large realistic banks/history, sustained memory/audio use, accessibility and target-WebView layout checks remain outstanding.
- **G-07 — Open-source maintenance:** support/security policy, a documented dependency-update process and complete third-party license verification remain outstanding. The new advisory gate is not license verification.

These changes do not establish Stable readiness or complete the original review checklist's release-acceptance conditions.
