# Management UX follow-up: audit items 11–16

Question rows keep Favorite visible and put Edit/Delete in More. The header distinguishes answerable subquestions from matching list items (a material group occupies one item). Empty Favorites explains the star and offers Browse banks; filtered-empty results keep their separate recovery guidance. The editor puts stem/options before classification, labels selection variants and the required answer mode, names New versus Edit explicitly, and focuses its heading on touch to avoid opening the keyboard before a field is selected.

Settings renames the existing entry to Import and restore and explains append/replacement/repair. Service settings separate saving/saved feedback from unconfigured, configured-but-untested, successful and failed connection tests. Testing remains explicit and changing configuration clears the old verdict. No API, database, backup or credential-storage behavior changes.

## Validation

- TypeScript production build and ESLint: passed.
- Vitest with coverage (`vitest run --coverage --maxWorkers=2`): **436 passed**, one pre-existing skipped test; configured thresholds met. Focused coverage includes menu confirmations, true/filter-empty Favorites, content-first editor structure and touch focus, plus existing credential/save/test recovery paths.
- Browser regression: **106 checks passed** in the complete run and **all 6 checks with updated labels/menu/count selectors passed** in the focused rerun (`test:browser -- --last-failed`). Together these cover the 112-check suite. Chromium desktop, 360/390px touch, bilingual UI, built production navigation and simulated service failures remain distinct from native acceptance.
- Actual Android API 35 arm64, isolated Pixel 7 AVD: question More menu, content-first editor without an unsolicited keyboard, New question title, 20-subquestion/0-matching-item filter, true-empty Favorites and Browse banks, import menu labels, saved configuration, explicit HTTP 503 failure and explicit HTTP 200 success: passed. Native health testing used `adb reverse` to a loopback-only local stub and a synthetic credential. [Requests](health-requests.jsonl) contain only method/path/status, no tokens.
- [Data preservation](data-preservation.json): all rows in all **32 practice tables** remained identical; still 1 bank, 26 question rows, 2 assets, 0 sessions, 0 attempts and 0 grade requests. Only the isolated AVD service sidecar/credential was configured for QA. The original AVD was never booted or changed.
- [Native APK identity](native-apk.json): UI-only Debug build with optional bundled resources omitted. The current production frontend index was verified inside the native library. Matching generated Kotlin bridge and Cargo cache were reused; strict packaging and remote CI are separate gates.

## Evidence and limits

Open [the comparison gallery](index.html). Before question-list screenshots use the same isolated fixture; editor/Favorites/import-menu baselines are explicitly historical captures from the prior acceptance evidence. After images come from the disposable AVD. No source database, token, APK or emulator image is committed. No deletion, import, restore, grading or real model call ran in native QA. Desktop native acceptance was not repeated locally; browser and remote platform checks are separate.
