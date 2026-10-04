# Roadmap evidence and completion boundaries

Tracks [#89](https://github.com/shenyankm/PractiQ/issues/89). The issue and its native sub-issues remain the authoritative roadmap; this record connects the repair and acceptance PRs and explains outstanding validation. Updated 2026-10-04 against main `9985104091be4fc7161573f4df95ae2742103679`. At this snapshot, PRs #118, #119, #120, #122, #125, #126 and #128 have merged; the linked PRs provide their live status. PR submission and ordinary CI do not establish acceptance or close a rolling roadmap.

## Now / Next / Later

| Priority | Workstream | Current deliverable | Remaining requirement before completion |
| --- | --- | --- | --- |
| Now | [#90 import quality](https://github.com/shenyankm/PractiQ/issues/90) | [PR #115](https://github.com/shenyankm/PractiQ/pull/115): checksummed source/candidate worksheet and legacy DOC/PDF formula repair through temporary DOCX normalization, with shared limits, CRC/XML checks and unchanged source files | Independent source-checked annotations, explicit live-run authorization/model/cost ceiling, current source-aligned model report and native round trip. User declined live calls for this work. |
| Now | [#91 final packages](https://github.com/shenyankm/PractiQ/issues/91) | [PR #116](https://github.com/shenyankm/PractiQ/pull/116): explicit final-installer restaging from a read-only snapshot, four strict gates, embedded-notice checks and SHA-bound evidence; platform/manual/signing matrix | Selected main candidate/tag, actual final installers/hashes, all strict gates, signing status and clean-machine native evidence per public platform. No publication requested. |
| Next | [#92 consented trials](https://github.com/shenyankm/PractiQ/issues/92) | [PR #117](https://github.com/shenyankm/PractiQ/pull/117): consent, offline and optional AI task protocols, approved artifact versions, per-attempt outcomes and retest/summary rules | Tested distributable build, explicit recruitment/contact authorization, actual voluntary participants and reviewed sanitized outcomes with denominators. No participants contacted. |
| Later | [#93 contribution/continuity](https://github.com/shenyankm/PractiQ/issues/93) | [PR #118](https://github.com/shenyankm/PractiQ/pull/118): isolated-checkout setup checks, starter issues #112–#114 and handover/access checklist | Independent onboarding/contribution and review evidence; explicit consent/access checks for any backup maintainer. No backup role recorded. |

These are dependency priorities, not promised dates. Keep unresolved work visible in the existing sub-issues. New starter tasks are opt-in fixture contributions; they do not expand the current repair batch into an unbounded issue sweep.

## Evidence rules

For every completion record include the exact source SHA, platform and architecture, date, artifact/corpus hashes, command or manual task, outcome and immutable report link. Preserve failures and unknown usage; identify **not run** separately from **passed**. Do not use historical model reports as current acceptance, exportable PARTIAL results as complete recognition, model substitutes as live quality, browser IPC mocks as native dialogs/credentials, or installer builds as clean-machine release acceptance.

A reviewed PR counts as integrated implementation on main only after it merges. Required CI checks must match the current PR head; a previous green run does not validate a later patch. Signing/repackaging or a new candidate invalidates final-byte hashes and calls for repeated package gates. User/contributor claims require actual opt-in participation and consented records, never task-list or download counts alone.

## Current repair batch

The 2026-10-04 repair batch is the ten existing code issues #94–#102 and #110; each gets a focused independent PR against main. The links below record implementation and its validation scope. The user authorized merging each PR after its latest-head CI and reviews pass. This authorization does not include tagging, publishing, contacting people or live/external model calls. Real model calls remain explicitly declined.

| Issue | Independent implementation PR | Validation scope |
| --- | --- | --- |
| #94 | [#122](https://github.com/shenyankm/PractiQ/pull/122) | Interrupted grading call ledger; fake models and durable restart/failure regressions; service verification |
| #95 | [#127](https://github.com/shenyankm/PractiQ/pull/127) | Unsaved editor drafts, dismissal and child ordering; UI/browser checks |
| #96 | [#119](https://github.com/shenyankm/PractiQ/pull/119) | Persistent current-query read errors/retry; UI and mocked-browser checks |
| #97 | [#124](https://github.com/shenyankm/PractiQ/pull/124) | Obsolete mutation refresh guards; delayed-response UI/browser regressions |
| #98 | [#121](https://github.com/shenyankm/PractiQ/pull/121) | In-place study setup retry without selection/configuration loss; UI/browser checks |
| #99 | [#123](https://github.com/shenyankm/PractiQ/pull/123) | Preview filter/review parity, recursive descendants and imported warnings; offline UI/browser checks |
| #100 | [#120](https://github.com/shenyankm/PractiQ/pull/120) | Non-color answer markers; status matrix, both themes and keyboard/large-card browser checks |
| #101 | [#128](https://github.com/shenyankm/PractiQ/pull/128) | Reduced-motion open/closed overlay styles and focus; UI/native/browser checks and a local macOS development package/bundled-service smoke check |
| #102 | [#125](https://github.com/shenyankm/PractiQ/pull/125) | Generated task detail contracts; service/UI/native/browser checks |
| #110 | [#126](https://github.com/shenyankm/PractiQ/pull/126) | Single self-assessment command; strict legacy field rejection, submit/result/snapshot regressions; UI/native/browser checks |

Each issue retains its own PR. Remaining branches incorporate reviewed main changes when needed to resolve conflicts. A pairwise text-merge check identified the following overlaps; the check itself does not establish combined behavior. Preserve both concerns during integration and run their regression checks against the resulting source.

| PR pair | Overlap | Resolution requirement |
| --- | --- | --- |
| #117 / #118 | `CONTRIBUTING.md` | Retain both trial and contributor-guide links. |
| #127 / #123 | `app/scripts/check-preview.mjs` | Retain editor-draft and preview-parity browser cases. |
| #119 / #124 | `app/src/App.tsx` | Keep one `questionRevision` plus `questionError`; rerun both retry and delayed-refresh suites. |
| #121 / #120 | `app/scripts/check-preview.mjs` | Retain study-setup retry and answer-card browser cases. |
| #121 / #126 | `README.md` | Retain both study-setup retry and self-assessment documentation. |

These mechanical overlaps do not change standalone PR evidence. Integrated checks and current-base review remain necessary before merging.

Keep #89 open while any required workstream acceptance remains pending. After the repair PRs merge, select one main candidate for new acceptance evidence. Keep its source and final-artifact hashes distinct from earlier branch, combined-checkout and development-package results.
