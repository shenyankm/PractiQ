# PractiQ UI/UX acceptance — 2026-10-14

Screenshot files were removed on October 17, 2026 during repository cleanup. The results below describe the original acceptance. Logs, measurements and original hash manifests are retained as historical records; screenshot entries in those manifests no longer identify available files. Current product screenshots remain in the root README files.

The existing App and import Web interfaces were refined using [UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill), while preserving the warm-purple theme, octopus artwork, system Chinese fonts and existing product boundaries. The skill entrypoint, search tools and professional UI checklist were used. Broad education search results favored marketing and child-oriented treatments; those recommendations were not adopted. Focused progress, typography, keyboard and React guidance informed the changes instead.

## PR candidate refresh

The PR candidate is based on `cb0d0dc85e0d9ab74ac3483aedcf84bf8b745c9d`, including the already-merged Vibe Pay and account-token flow. Web UI changes were adapted to that baseline without restoring card binding or redemption. Current Web evidence uses authenticated synthetic phone/account-token fixtures and preserves the purchase route and explicit recharge/model boundaries.

Web build, lint and coverage were rerun: 81 unit tests and all 26 built-browser scenarios passed. App build/type/lint/coverage were rerun: 392 passed with the same optional benchmark skipped. App UI and browser/script sources are byte-identical to the initially validated candidate, so the prior 67 browser passes and screenshots are retained with their original provenance rather than described as a fresh rerun.

The authoritative Web comparison files are `main-before-*` and `main-after-*`: identical page states, full-page framing, fixtures and 1440×1000 / 390×844 viewports. Original `web/before-*`, `web/after-*` and 70-unit/24-browser logs remain historical evidence from the pre-rebase candidate. See [baseline metadata](web/main-before-metadata.json), [candidate metadata](web/main-after-metadata.json), and [preserved purchase options](web/main-after-recharge-metadata.json).

## Changes and observable benefit

| Surface | Before | After |
| --- | --- | --- |
| App resume | Small heading and one combined metadata line | Clear session title, saved progress and resume action. Practice uses submitted answers; exams use saved draft answers. |
| App bank cards | Title, count and menu competed in one row | Count below the description, with a distinct action region and room for long titles. |
| App question list | At 375px, the summary was only 93px wide beside three actions | Summary is 273px wide, with actions on a separate row. Search and filters share a surface. |
| App practice | Previous/Next separated by wrapping on small phones | Navigation stays together; portrait has two action rows and landscape retains one compact row. |
| Web connection | Purchasing/account card appeared before connection | Connection first, with purchasing information available through disclosure. |
| Web account | Full recharge and ledger controls occupied the workspace | Compact balance strip; keyboard-accessible disclosure exposes the same explicit controls. Warnings/errors remain visible. |
| Web import flow | Three static steps | Current-step semantics reflect the selected task and a verified ZIP download for the same task/checkpoint. A new checkpoint returns to review. |
| Web cost awareness | Long supporting text competed with controls | The existing AI review/cost/accuracy warning remains visible immediately before Start. |

No new dependencies or model actions were introduced. Existing source associations, warning states, answer semantics, disabled gates, account scope and credential storage remain in place.

## Screenshot comparison

The original comparisons covered App banks, questions and practice on desktop and phone, plus Web connection, workspace and phone review.

Additional acceptance captures: App dark desktop, App dark phone, English phone, landscape practice, phone editor, Web dark desktop, Web dark phone, and Web verified export.

The initial App capture script produced 22 screenshots with no page errors; this record originally included 13 representative browser screenshots alongside four before captures. Historical Web had six before and ten after captures; the main-based refresh had ten before and sixteen after captures, including supplemental purchase/recharge views. The three macOS screenshots came from a running Tauri development binary in a separate QA app bundle using the same synthetic frontend: banks, questions, practice. Native clicks verified opening the question list, resuming practice and moving to the next question. These screenshot files were subsequently removed in the cleanup described above.

## Checks

PR candidate validation: 473 unit tests passed, one existing optional benchmark skipped; 67 unchanged App browser scenarios retain their prior passing result, and 26 Web browser scenarios passed after integration (93 scenarios in total).

| Check | Result |
| --- | --- |
| App production build and ESLint | Passed; [build log](app/uiux-build.log). |
| App complete frontend unit/coverage run | 392 passed, one existing optional editor performance benchmark skipped. Statements 89.86%, branches 85.11%, functions 87.93%, lines 93.37%; [log](app/uiux-check-ui.log). |
| App screenshot/style acceptance | 22 captures; no page errors or native IPC. Desktop controls ≥40px, touch controls ≥48px, no document/content overflow. Light/dark, English wrapping and keyboard filtering passed; [report](app/report.json). |
| App focused touch regression | Both 390px and 360px projects passed the new readable-summary and paired-navigation test; 2 passed. |
| App remaining browser projects | 31/31 passed in 2.4 minutes: bilingual mocked UI, rich content, built navigation and both touch projects. Together with preview, all 67 App browser scenarios passed on the final source; [log](app/uiux-browser-remaining.log). |
| App preview/recovery browser project | Final complete run: 36/36 passed in 2.7 minutes; [final log](app/uiux-browser-final.log). |
| Web production build, ESLint and unit coverage | 81 unit tests passed after integration. Statements 94.05%, branches 87.07%, lines 97.69%; [build log](web/main-after-build.log), [check log](web/main-after-check.log), [coverage JSON](web/main-after-coverage-summary.json). |
| Web built browser suite | All 26 tests passed after integration, including the existing Vibe Pay scenarios; [log](web/main-after-browser.log), [JSON](web/main-after-browser-results.json). Initial 24/24 and capture recheck 2/2 remain historical. |
| Web screenshot interactions | Keyboard account disclosure, current steps, verified download, checkpoint invalidation, disconnect reset and visible fee warning passed. |
| Web responsive/theme checks | 320/375/390/768/900/1024/1440px no-overflow checks, representative light/dark text contrast and reduced-motion captures passed. |
| Impeccable mechanical scan | No findings across seven changed UI targets; [JSON](app/uiux-design-detection.json). |
| Source diff | `git diff --check` passed; independent review found no actionable regression. |

The initial App browser run had 35 passes and one editor-dialog failure. The failed listening-resource scenario passed in isolation with the original timeout; [initial log](app/uiux-browser.log), [focused recheck](app/uiux-browser-recheck.log). The final preview run with product source stable passed all 36 scenarios. The remaining browser projects then passed all 31 scenarios. These logs are recorded separately rather than treating the first run as clean.

The refreshed App [build](app/main-build.log) and [check](app/main-check-ui.log) also passed on the PR base. Published terminal logs normalize trailing whitespace without changing assertions or values.

## Reproduce

Start the App screenshot server from the repository root:

```sh
npm --prefix app run dev -- --mode design-preview --port 1426 --strictPort
```

In another terminal:

```sh
node app/scripts/check-design-preview.mjs
npm --prefix app run check:ui
npm --prefix app run test:preview
cd app
npx playwright test --project android-390 --project android-360 --no-deps --grep 'question summaries stay readable'
```

For current Web screenshot acceptance with authenticated synthetic phone/account-token fixtures:

```sh
npm --prefix web run build
npm --prefix web run check
PRACTIQ_WEB_BUILT=1 npm --prefix web run test:browser
```

App screenshots are generated under `app/.build/design-preview/`; Web screenshot tests write under `web/test-results/browser/`. The old Bearer-based Web design-preview middleware is not current acceptance evidence.

## Acceptance limits

This is UI and interaction acceptance with synthetic data. No real model, Office conversion, payment or customer-account service was exercised. The macOS development WebView was visibly checked; native storage/import/restore, release installer packaging, Windows and an actual Android emulator/device were not checked. The phone browser tests exercise touch layout and the existing Android Back bridge, not a native Android build. Publication is recorded in the pull request; local acceptance remains distinct from remote CI.
