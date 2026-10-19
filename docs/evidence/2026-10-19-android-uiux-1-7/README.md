# Android UI/UX items 1–7 acceptance

The practice app now distinguishes finished review from answering, explains the accuracy denominator, keeps material reading in the question, renders historical answers as readable content, and separates mobile navigation from the scrolling workspace.

Open [the 49-pair comparison gallery](index.html). It includes three additional native captures for material expansion across questions and the end of writing review. Byte-identical copies of the 49 original screenshots are included in [before/](before/) so this comparison is self-contained. The original local evidence directory remains untouched.

## Implemented scope

| Item | Result | Evidence |
| --- | --- | --- |
| 1. Review state | Finished practice and submitted exams use “Practice review”; draft/save/submit instructions are replaced by review copy, including the answer card. | `after/practice-q01-zh.png`, `after/practice-q20-zh.png` |
| 2. Accuracy | History states how many questions were graded and correct; skipped and unresolved counts remain visible. Scoring calculations and stored results are unchanged. | `after/005-history-zh.png` |
| 3. Material reading | Material expands inline, with a bounded scrolling region. Sibling questions retain expansion and reading position during the app run. Single-child navigation rows are omitted. | `after/extra-material-q13-expanded.png`, `after/extra-material-q14-preserved.png` |
| 4. Historical answers | Readable “My answer” sections replace disabled inputs. Empty answers are explicit; choice options, selected labels, source items, reference answers and explanations remain available. | All 20 historical question captures |
| 5. Density | Favorite becomes an accessible star in the metadata row; the title and clock share a compact row; general group instructions expand on demand. | `after/practice-q01-zh.png` |
| 6. Navigation | On narrow screens the player, question and answer card scroll above a separate Previous/Next bar. Listening retains its component identity across siblings. | `after/practice-q10-zh.png`, `after/extra-writing-result-bottom.png` |
| 7. Answer-card states | A visible legend counts states present in the session. The full explanation remains available. The entry targets the whole card so its heading and legend are visible immediately. | `after/015-practice-record-bottom-zh.png`, `after/016-practice-scoring-details-zh.png` |

No schema, native command, parser, provider, credential, scoring or backup format was changed. No dependency was added.

## Validation

| Gate | Result |
| --- | --- |
| TypeScript, ESLint, frontend tests and coverage | Passed: 423 tests; 90.46% statement and 93.67% line coverage. One existing opt-in editor benchmark was skipped because `PRACTIQ_EDITOR_BENCH` was not set. See [check-ui.txt](check-ui.txt). |
| Mobile browser regression | Passed: 22 checks across 390×844 and 360×640, including built navigation, readable review, visible legend on entry, real long-passage scroll retention, separate footer, listening navigation, drafts and shortened dialogs. See [android-browser.txt](android-browser.txt). |
| Shared contracts and fixtures | Export consistency passed; 49 shared fixture cases validated by Python 3.14.7. |
| Android Debug APK | Built using JDK 21, SDK 36, NDK 28.2.13676358 and `CARGO_PROFILE_DEV_DEBUG=1`. Strict package checks passed; no embedded AI engines. See [the final package report](android-package-final-anchor.json) and [build log](android-build.txt). |
| Actual Android UI | All 49 original gallery states were opened and captured, including all 20 historical questions. Three supplementary screenshots were captured. Final anchor correction received the targeted native recheck described below. |
| Data retention | Passed: practice/settings schemas and every table row match the initial snapshot; resources, recovery files and encrypted credential files match their comparison snapshots. See [data-preservation.json](data-preservation.json). |
| Design detector | One pre-existing `border-l-4` warning remains on the unchanged expanded group presentation outside compact practice. See [design-detector-final.json](design-detector-final.json). |
| Physical device, desktop native tests, live AI and remote CI | Not run in this Android UI task. |

The long-material browser fixture proves an actual 120 px reading offset survives a sibling change. The existing native material is short, so native evidence proves expansion retention rather than long-material scrolling. Browser fixtures are isolated; no test bank was imported into the emulator.

## Native environment and candidate identity

The AVD is `PractiQ_UIUX_20261018`, serial `emulator-5560`: Android 15 / API 35, arm64, 1080×2400, density 420, font scale 1.0, WebView 124.0.6367.219. See [device.json](device.json).

The gallery was captured in two acceptance rounds. The first covered all 49 states plus the three supplementary captures. After the final correction moved the answer-card entry from its grid to the whole panel, the final APK repeated the bank/history, first/last question, and card-entry/legend views. The unrelated gallery states were not repeated after this anchor-only correction. [capture-manifest.json](capture-manifest.json) records the APK SHA-256 for each image, including this distinction. The installed final APK hash was checked against its package report. [source-fingerprints.json](source-fingerprints.json) records the working-tree source identity.

The original index's `016` caption said “scoring details”, while its screenshot showed the answer card. This round captures the full answer-card explanation there. The theme/language menus are now captured with their options actually expanded. The new-bank capture includes the Android keyboard. Search text, focus and scroll positions can differ from the old gallery; these are visual state comparisons, not pixel-equivalence tests.

## Data and operation boundaries

- The original 49 screenshot SHA-256 values were verified unchanged.
- The same installation was updated with `adb install -r`; it was never uninstalled or cleared.
- Practice data retains 1 bank, 26 question rows including material parents, 2 sessions, 40 attempts, 2 assets and 0 grading requests. Every table is identical, not just these counts. Both databases pass SQLite integrity checks.
- The private `v4/` snapshot precedes implementation. Credential-file comparisons use the snapshot taken before final acceptance; encrypted credentials were never cleared, replaced or entered into a form.
- No file was selected, no session was created, no editor was saved, no answer or score was submitted, no AI action was invoked, and no restore was performed. Setup previews were cancelled.
- Service address/token pixels were masked before retaining the screenshot. The service form's raw UI tree is excluded from evidence; the temporary UI-tree file on the emulator was removed.
- Database and encrypted credential snapshots remain outside the repository in a private local temporary directory. They are not included in this evidence gallery.

Preliminary captures and failure evidence are retained locally (excluded from this PR) in `round1-pre-fix/`, `round2-pre-fix/`, `round3-pre-final/` and `browser-layout-failure/`. They are diagnostic archives, not the accepted gallery. The final gallery is `after/`; the authoritative package report is `android-package-final-anchor.json`.

## PR CI follow-up

The first remote App quality run passed frontend/contract checks but found eight failures in the complete browser suite. Material tests still expected the old dialog, screenshot capture still assumed the outer scroll container and an always-present action bar, and the new answer-card panel anchor did not receive keyboard focus.

The panel now accepts focus with a visible keyboard focus ring. Browser checks use the inline material region, actual mobile/desktop scrolling container and independent navigation footer, and verify focused card entry with its legend in view at 375, 768 and 1440 px. The answer-hiding assertion remains in place.

`npm --prefix app run check:ui` passed again: 423 tests, one existing opt-in benchmark skipped; see [check-ui-followup.txt](check-ui-followup.txt). `npm --prefix app run test:browser -- --project rich-content --grep 'all question layouts'` passed all four answering/reference layouts at 390×844 and 1280×720; see [responsive-followup.txt](responsive-followup.txt). The three workspace-focus cases and inline answer-hiding case also passed during focused reproduction. Full-suite and current-head remote results are tracked on PR #302.

The screenshot/APK/source manifests above retain their original acceptance identities. They precede this keyboard-focus attribute correction; no replacement native gallery is claimed for the follow-up. No data or native-command changes were added.

### Review findings addressed

The next review identified three additional edge cases. Saved free-text and fill responses now render as escaped, pre-wrapped text, including in the fill-answer comparison table; question/reference Markdown remains formatted. The inline material reader includes associated non-original visuals. Material-state keys serialize the ID array with JSON, avoiding collisions between groups such as `["a:b", "c"]` and `["a", "b:c"]`.

Six added regression cases cover literal short-answer/writing/fill responses, literal fill comparison with formatted references, associated diagrams without original-page exposure, and independent material groups. TypeScript, ESLint and all 429 frontend tests passed (one pre-existing opt-in benchmark skipped); see [check-ui-review-fixes.txt](check-ui-review-fixes.txt). The complete 112-case browser suite and current-head remote CI/review are tracked on PR #302. The earlier native gallery remains historical evidence for its recorded APKs; these review fixes do not change stored answers or data formats.
