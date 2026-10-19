# App practice, editor and history acceptance

Original comparison captured on 2026-10-19 against baseline `b20b937a60973d86179d03e866c6e08adbb80ce9`. These refinements preserve the octopus brand, purple light/dark themes and existing functionality. They affect the practice toolbar, question editor and history hierarchy, without changing native storage, AI contracts or service behavior.

## Integration on current main

The implementation was rebased onto `58b726f1`, preserving its new question-action menu, create/edit titles, trigger focus restoration and question-first editor order. Current integrated captures: [practice](integrated/practice-1440.jpg), [editor](integrated/editor-1440.jpg), [history](integrated/history-1440.jpg). The original nine pairs below remain historical evidence of the initial implementation; they predate those intervening main changes.

- Integration `npm run check:ui`: passed; details in [integration-frontend.log](integration-frontend.log).
- Integration `npm run build`: passed; details in [integration-build.log](integration-build.log).
- The complete publication browser suite is recorded separately in the PR validation status once it finishes. Earlier browser results below retain their original scope.

## Screenshot comparison

Open [the comparison gallery](index.html) for nine pairs: practice, editor and history at 1440×1000, 1024×900 and 390×844. Each pair uses the same dark theme, Chinese locale and synthetic scenario. Click an image for its original resolution. Additional light-theme and post-submission captures are included.

[screenshots.json](screenshots.json) records dimensions and SHA-256 hashes for all 18 comparison images. Captures use the Codex in-app browser and React design preview; their original format is JPEG. Timestamps, elapsed timers, focus and browser antialiasing may differ between captures.

Three initially truncated baseline mobile images are retained locally and excluded from the published comparison. The replacement mobile baseline came from an isolated archive of the original commit, with a temporary Vite allowlist permitting the same installed math fonts. That temporary archive and its preview server were removed after capture. The original localhost gallery was not changed.

## Changes and acceptance

| Area | Change | Acceptance |
| --- | --- | --- |
| Practice | Group submit, skip and question navigation in one persistent toolbar; make Next the primary action after submission. Retain a separate navigation row on narrow screens and a compact row in short landscape layouts. | Submit, Next and Skip worked in the synthetic browser flow. Existing draft persistence, finish/hand-in confirmation and answer-card focus navigation remain intact. |
| Editor | Put the question, options and reference answer ahead of optional metadata. Group answer mode and variant. Move optional type/instruction fields to “更多设置” (More settings), expanding existing English/listening content. | Optional edits survived collapse, save and reopen. Folding does not unmount audio controls or remove URL-draft, audio-lease and unsaved-edit protection. Desktop selects align; narrow-screen controls remain touch sized. |
| History | Separate title/status, result and time/progress; remove the duplicated pending-score badge. | Preserve accuracy denominators, pending/unassessed/skipped counts, submitted totals, time, grading details, filters and recovery actions. |

All three pages were checked for horizontal overflow at the three screenshot widths. Existing components and theme tokens are reused; no dependency was added.

## Validation recorded before publication

- `npm run check:ui`: Passed types, lint and 438 tests; one existing opt-in performance benchmark skipped. Line coverage: 93.67%. See [frontend log](frontend-checks.log).
- `npm run build`: Passed. See [build log](production-build.log).
- Initial browser run across preview, android-390, android-360 and built-navigation dependencies: 98/99 passed. One desktop answer-card-link check failed after the link was hidden; restoring it preserved keyboard focus navigation. The unchanged related cases then passed at 375, 768 and 1440px. See [recheck log](browser-recheck.log) and [failure/correction record](initial-browser-failure.md). The initial run was not wholly green.
- Coverage includes both languages, both themes, drafts, reference answers, audio URL edits, nested editors, error recovery, touch navigation and finished-session review. Touch input is synthesized in Chromium, not tested on physical hardware.
- Final targeted Impeccable scan returned zero findings: [detector output](design-detector.json). An independent diff review found no concrete regression.

## Limits

These are React preview and synthetic browser results. No personal study database was read or modified; no live AI calls were made. Native Tauri, APK/emulator execution, physical Android hardware, Windows and native macOS WebView were not accepted in this run. Rust and server tests were not run because no native or server behavior changed. Remote CI and review are separate publication gates.
