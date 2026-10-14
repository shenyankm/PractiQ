# Responsive question-content verification

The local audit covers the offline practice App and the independent Web result-review interface. All native calls and service HTTP responses use existing synthetic fixtures; no database, credentials, Office process, or model is used.

## Findings and changes

- At 768×1024 with the App sidebar expanded, the viewport-based practice breakpoint left only 230px for the question card. Matching selectors wrapped their placeholder into a narrow vertical column. Practice now selects its two-column layout from available container width, and matching rows independently select their columns from their own container width.
- Narrow tables broke words and numeric values across lines. App and Web now share document CSS that preserves table-cell minimum content widths and keeps overflow inside the table.
- Wide display equations need a scroll area whose beginning remains reachable. Their rendered math now retains its intrinsic width, with centering only when it fits. Other long inline content also scrolls within its document block rather than widening the page.

No question contracts, answers, snapshots, storage, grading, import, authentication, or model triggers change.

## Matrix

Both frontends use 18 fixture scenarios: single choice, multiple choice, true/false, fill-in-the-blank, short answer, ordering, one-to-one matching, many-to-one matching, listening, reading, word bank, cloze, grammar fill, sentence selection, paragraph matching, translation, writing, and a choice question with rich content.

The rich-content case combines matrices and inverses, aligned integrals and infinite sums, a cases expression, fractions and radicals, a table with mathematical cells, and a chart. App reference-state checks also open the existing portrait source-page fixture. Material dialogs use the actual composite-question fixtures.

Acceptance uses two representative CSS viewports rather than an exhaustive aspect-ratio matrix. Page height remains scrollable; no resolution-specific product layouts are introduced.

| CSS viewport | Context |
| --- | --- |
| 390×844 | Mobile portrait |
| 1280×720 | Desktop |

App checks cover both answering and submitted-reference states at both sizes. Web checks expand every reviewed question at both sizes. Existing bilingual, theme, touch-navigation, and keyboard tests remain in their original suites.

## Reproduce

```sh
npm --prefix app run check:ui
npm --prefix web run check
npm --prefix app run test:browser
npm --prefix web run test:browser
npm --prefix app run build
npm --prefix web run build
```

The App responsive matrix runs in the `rich-content` Playwright project. The Web matrix extends the existing browser suite. Screenshots, including App scroll segments and material/image dialogs, are written to each frontend's ignored `test-results/browser/` directory. The tests check page/card overflow, KaTeX errors, reachable equation starts and scroll ends, matching-selector width, table-header wrapping, verified image loading, dialog height and keyboard focus restoration, and absence of model submissions.

The pre-fix audit and post-fix contact sheets are retained locally under `app/test-results/responsive/` and `web/test-results/responsive/`; generated screenshots are not committed.

## Evidence limits

Chromium browser checks use mocked native commands and HTTP transport. They do not establish macOS WKWebView, Windows WebView2, Android system WebView, physical-device keyboard/insets, native file or credential behavior, or live-model accuracy. Coverage is limited to the fixture matrix rather than every possible imported document. Native packages and service deployment are outside this CSS/layout change.
