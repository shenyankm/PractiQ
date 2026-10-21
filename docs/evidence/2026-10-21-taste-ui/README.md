# Practice UI refinements and screenshot comparisons

[Comparison gallery](index.html) - [JSON manifest](capture-manifest.json) -
[CSV manifest](capture-manifest.csv) - [Measurements](measurements.json)

Keep the warm-purple theme, octopus mark, fonts, shadcn components, action labels,
entry points and business callbacks. Only action emphasis, secondary question
filters on phones and the default sidebar at medium widths change.

| Area | Before | After |
| --- | --- | --- |
| Bank home | Import, resume and every practice action have filled emphasis | Resume stays primary; import and new practice use outlines; viewing questions is a text action |
| Phone questions | Search, type and review controls are always expanded | Search stays visible; secondary filters expand in place, retain values and show an applied count; clearing stays reachable |
| 768-1023px | Sidebar starts at 208px | Sidebar starts at 64px with accessible names, tooltips and an expand control; an explicit choice takes precedence |

For the same Simplified Chinese fixture at 390x844, the first question moves from
433.69px to 291.69px, an improvement of 142px. At 768px, content width grows from
560px to 704px: 144px, or 25.7%. Other locales and sizes have their own measurements.

## Design decisions

- The bank home prioritizes resuming a session; the question list prioritizes reading questions.
- Keep all actions, existing 32px/16px page insets, semantic colors and 48px touch targets.
- Four fixture banks still contain 9 + 11 + 10 + 0 = 30 questions; the empty bank shows a real zero.
- The applied count covers type and review conditions. Search remains visible in its input.
- Preserve the existing phone drawer, keyboard behavior and explicit sidebar toggle.
- No chart, answer, grading, import, database, credential or model-call behavior changes.

The design-taste-frontend App workflow supplied the component review.
[direction.json](direction.json) records `editorial-greeting`, seed `400891399`,
with `--keep palette,type` and no redraw. This is a component restyle within the
existing shell, not a replacement with the direction's greeting or grid.
The only browser-inspector allowance is `palette-purple`, preserving PractiQ's brand.

## Validation

[verification.json](verification.json) separates initial runs and focused rechecks.

- `npm --prefix app run check:ui`: TypeScript, ESLint and 464 tests passed; three existing skips. Statement coverage 90.59%, line coverage 93.70%.
- `npm --prefix app run build`: production frontend build passed.
- Initial full browser regression: 166 passed, four failed, 170 total. Three tests assumed an expanded sidebar at 960px; one needed to reopen reset filters after import. Their behavior assertions remain intact.
- `npx playwright test --last-failed --reporter=json`: all four passed after adapting those assumptions. See [browser-recheck-report.json](browser-recheck-report.json).
- One additional cross-breakpoint state test passed; the final 12 phone cases also checked collapsing, preserving and clearing both filter conditions. In total, 171 distinct browser scenarios were covered with no unresolved failure. This was not a single uninterrupted green full run.
- `node app/scripts/check-design-preview.mjs`: 22 screenshots and interaction checks passed without page errors or native requests. See [preview-report.json](preview-report.json).
- Taste browser inspector at 1440/768/390px: zero failures and warnings with the brand allowance. See [inspector-report.json](inspector-report.json).
- Taste source lint on the two changed components: zero failures, one accepted warning for the existing floating tooltip's shadow.
- The gallery has independent desktop/mobile filters for width, theme, locale and scene: 48 before/after pairs and 12 expanded-filter states, 108 PNGs with SHA-256 and byte counts. Six unchanged desktop question pairs explain the 102 unique hashes.

The standalone preview check now respects existing 32/36/40/44px desktop size
variants and explicitly closes persistent error notifications. Sidebar tests first
expand the sidebar before checking collapse, animation, language, keyboard and
answer preservation. Recovery tests reopen the disclosure to verify cleared review
state while retaining their no-replay assertions.

## Reproduction

Start the clean preview in one terminal:

```sh
npm --prefix app run dev -- --mode design-preview --host 127.0.0.1 --port 1426 --strictPort
```

Run the checks from another terminal at the repository root:

```sh
node app/scripts/check-design-preview.mjs
node "${CODEX_HOME:-$HOME/.codex}/skills/design-taste-frontend/scripts/inspect.mjs" --app http://127.0.0.1:1426 --allow palette-purple
npm --prefix app run test:browser
```

`check-taste-ui.mjs` writes normal captures into Playwright's temporary output,
so rerunning the suite cannot overwrite this frozen evidence. To export a separate
comparison set, explicitly set `PRACTIQ_TASTE_EVIDENCE_DIR` to a new directory when
running the test from `app/`. Use `PRACTIQ_TASTE_PHASE=before` only with the original
source. Do not overwrite the baseline with the changed source.

The manifest records the baseline commit and the changed App source diff hash.

## Evidence boundaries

All images show the React UI in Chromium with repository in-memory fixtures.
Expanded-filter captures wait for questions to finish loading. Image sidecars
record rendered locale, theme and viewport. This does not establish native
macOS/Windows, Android APK/device, system-picker, keyboard/IME or live-model acceptance.
Local checks are separate from remote CI and any later PR review or merge.
