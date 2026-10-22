# Taste Skill: import workspace refinement

2026-10-22. Scope: `web/` import, records and settings presentation. All HTTP,
files, task contents and budgets in this evidence are synthetic browser fixtures.
No native app, paid provider or live service was exercised.

## Direction and intent

Applied the App-screen workflow from
[Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill), using the installed
`design-taste-frontend` scripts. Direction: **Achromatic ledger**, seed **458719735**;
`--kind workspace --screens home,list,settings --keep palette,type`. No redraw.
The ledger's restrained chrome is adapted to PractiQ's existing warm-purple brand,
system typography and shadcn components. No dependencies were added.

The product's face is its octopus mark and warm ground; the signature is the
source → review → offline ZIP sequence. These stay visible without displacing the
main job. Screen questions:

- Import: which source will I submit, and what starts the work?
- Records: what was saved, and which task should I inspect?
- Settings: what recognition/recovery values does this service use?

The main card keeps source selection, pending files, deduplication, the fee notice
and explicit Start together. Desktop uses the available canvas for a main column
plus a 296px guide and 24px gutter. At 1100px and below the guide follows the card.
The complete formats, budget and review/export instructions remain available.
Unconfigured recognition/model warnings stay in the main card before Start.

Navigation/record selection use neutral fills. Count/date columns align right on
desktop and left inside phone rows. A compact hint replaces the large empty detail
panel until a task is selected. Phone settings labels and help precede full-width
inputs. No upload, retry, grading, credentials or service contracts changed.

## Visual review

Reviewed desktop, tablet and phone folds in light and dark, plus settings/records
captures. Import is read first, the octopus identifies the product, controls stay
within the canvas, and mobile navigation uses its existing three labelled links.
There are no invented KPIs/charts. A real zero stays zero in the synthetic fixture.

With one `pending.txt`, the Start button at **390×844** occupies **y=749–797px**.
The previous 390px capture placed it below y=1100px. This is a single-file browser
layout measurement, not a latency or production-performance claim. Multi-file
queues remain bounded and scrollable; short 320/360px views may require scrolling.

| Screen | Before, desktop | After, desktop | Before, phone | After, phone |
| --- | --- | --- | --- | --- |
| Import | [1440](before/management-import-1440.png) | [1440 light](after/import-1440-light.png) | [390](before/management-import-390.png) | [390 light](after/import-390-light.png) |
| Records | [1440](before/management-records-1440.png) | [1440 light](after/records-1440-light.png) | [390](before/management-records-390.png) | [390 light](after/records-390-light.png) |
| Settings | [1440](before/management-settings-1440.png) | [1440 light](after/settings-1440-light.png) | [390](before/management-settings-390.png) | [390 light](after/settings-390-light.png) |

The baseline management scenario has a selected running task and edited settings;
the new matrix has an unselected completed task and default settings. Compare
import geometry directly; records/settings establish readability rather than an
identical-data pixel diff. Names encode screen, viewport width and rendered theme.
PNG sidecars record actual viewport and theme; `manifest.json` provides stable IDs,
byte counts and SHA-256 hashes. Import JSON files also record the Start bounds.

## Checks

- `npm --prefix web run check`: TypeScript, ESLint, 163 unit tests and coverage gates.
- `npm --prefix web run build`: production bundle.
- `npm --prefix web run test:browser`: 53 passing browser cases, including 10 new
  light/dark cases at 1440×900, 768×1024, 390×844, 360×640 and 320×640.
- New cases check first-screen Start at widths ≥390px, no page overflow, full-width
  stacked phone settings fields, compact empty details, numeric alignment and no
  mutations/model starts while selecting files or browsing these screens.
- Taste source lint: 0 FAIL / 0 WARN.
- Taste rendered inspection at 1440/768/390, both themes: 0 FAIL / 0 WARN with the
  brand allowances below. Static snapshots are exported from the actual connected
  React DOM, with scripts removed and the logo embedded. They are read-only fixtures.

Allowances: `palette-purple` preserves PractiQ's primary/focus color; light mode
also permits `palette-cream` to preserve the shared warm ground. The initial light
inspection reported this existing ground as one warning; it is deliberately retained.
No other rule was waived. `direction.json` records the dealt sheet, and
`inspection/{light,dark}/report.json` contains the rendered measurements.

Reproduce captures without overwriting accepted evidence by default:

```sh
npm --prefix web run test:browser -- --grep 'taste import workspace'
```

Only set `PRACTIQ_TASTE_EVIDENCE_DIR` when intentionally exporting a new capture set.
Inspect the frozen import snapshots from the repository root:

```sh
node ~/.codex/skills/design-taste-frontend/scripts/inspect.mjs --app \
  docs/evidence/2026-10-22-taste-web/after/import-light.html \
  --allow palette-purple,palette-cream --out /tmp/practiq-taste-light
node ~/.codex/skills/design-taste-frontend/scripts/inspect.mjs --app \
  docs/evidence/2026-10-22-taste-web/after/import-dark.html \
  --allow palette-purple --out /tmp/practiq-taste-dark
```

Native windows, system file pickers, IME, physical touch devices, live provider
services and remote CI were not tested in this change. No production sample data
was introduced; the existing synthetic `pending.txt`, `sample.docx`, 3 questions,
2 review items and 400-call budget must not be treated as live account values.
