# Study setup UX follow-up: audit items 8–10

Study setup separates basic settings from exam score review. Android gets a full-screen panel with an independently scrolling body and fixed actions. Count shortcuts sit next to the count field; minutes, question counts and points have explicit units. Score review shows a live allocated/target total and compact point buttons until editing. Returning to setup and viewing the same preview preserves score edits, while changing selection or total invalidates the preview. Existing practice start, complete material groups, manual/quota selection, score budgets, paging and retry behavior remain supported.

## Validation

- TypeScript production build and ESLint: passed. A follow-up exposes compact score values through accessible descriptions; all 23 StudySetup tests passed after that markup change. Native screenshots remain visual evidence from the preceding UI-equivalent candidate.
- Vitest with coverage (`vitest run --coverage --maxWorkers=2`): **434 passed, one pre-existing skipped test**. Coverage remains above the configured thresholds.
- Playwright: **112 existing regression checks passed**, including desktop, 360/390px touch and built-production navigation. The **3 new step/score persistence checks passed** in a focused preview run at 360, 390 and 1280px, after using the existing select-control test helper. [Browser screenshots](browser/) are separate from the native captures.
- Actual Android: API 35 arm64, separate disposable Pixel 7 AVD `PractiQ_Followup_QA`, native example bank (20 answerable questions). Open timed setup, preview, focus a score with the Android keyboard, change 5 to 4 points, observe **99 / 100**, return to setup and view scores again: passed. No session was started. The crash buffer stayed empty.
- Native APK identity and build scope are recorded in [native-apk.json](native-apk.json). This is a UI-only Debug build with optional bundled notices/resources omitted; strict final-package acceptance is a separate remote CI gate. The local Cargo cache and matching generated Kotlin bridge were reused.

## Evidence and data

Open [the comparison gallery](index.html). Before images are explicitly historical audit captures; after images come from the disposable AVD. This is visual acceptance, not a controlled performance or content-equivalence benchmark. Browser fixtures and native execution are separate checks. The original AVD was never booted, installed over, uninstalled or cleared; its data and credentials remain untouched. Source databases, APKs and emulator images are excluded.

This change does not alter native commands, stored session/score snapshots, schema, backup format or model-call triggers. macOS/Windows native execution was not repeated locally; desktop browser interactions and remote platform CI remain separate evidence.
