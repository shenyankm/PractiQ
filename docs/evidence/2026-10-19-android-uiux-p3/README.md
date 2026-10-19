# P3 Android UX follow-up

Compact root headers keep the navigation menu; question lists, practice/review and service settings have their return action without a competing hamburger. Desktop sidebar behavior stays available. Language/genre metadata gets explicit localized labels while question text and unknown source values remain unchanged. Listening shows elapsed/total segment time with aligned controls and an accessible, non-live time label; restricted exam seeking/speed remain unavailable. An unchanged bank offers Cancel; dirty footer dismissal uses the existing discard confirmation.

## Validation

- TypeScript production build and ESLint: passed.
- Vitest with coverage: **436 passed**, one pre-existing skipped test; configured thresholds met. After the accessible playback-time label refinement, **44 focused listening, localization, bank-editor and Android navigation tests passed** again.
- Playwright desktop/touch/bilingual/built regression: **99 checks passed** in the complete run. After correcting navigation-readiness and discard-confirmation test callers and rerunning after development HMR settled, **all 17 selected/dependency checks passed**, covering the 13 remaining cases plus four built-navigation dependencies. Together these cover the 112-check suite. Existing error/draft coverage now uses subpage return instead of an absent menu and checks that a failed settings save stays visible.
- Actual Android API 35 arm64, isolated Pixel 7 AVD: question/service subpage Back controls, root menu, explicit English metadata labels with unchanged source text, visible 0:00 / 0:03 audio duration and completed 0:03 / 0:03 progress, unchanged-bank Cancel and dirty-bank discard confirmation: passed. No native exam/session was started; restricted playback persistence is covered by existing unit/browser tests rather than a new native exam.
- [APK identity](native-apk.json): the current production frontend index is embedded in the UI-only Debug APK. Optional bundled notices/resources are omitted, and native cache/generated Kotlin bridge are reused; strict packages and current-head remote CI are separate gates.
- [Data report](data-preservation.json): all rows in 32 practice tables remain unchanged; 1 bank, 26 question rows, 2 assets and no sessions, attempts or grade requests. Passive navigation and playback made no additional health calls beyond the two explicit loopback tests from the preceding QA group. The original AVD was never booted or altered.

## Evidence and limits

Open [the comparison gallery](index.html). Before frames use preceding scoped candidates with the same isolated example bank; separate groups can have different unrelated UI details. Native and browser evidence are separate. The global Android crash buffer contains two UiAutomation dumper `Bad file descriptor` failures ([summary](automation-log-summary.txt)); no app crash was observed, and the app remained responsive. This is not an empty global crash buffer.

No database, credential, APK or emulator image is committed. No actual grading/model request ran in native QA. macOS/Windows native acceptance was not repeated locally; remote platform CI and Android strict-package checks remain separate gates.
