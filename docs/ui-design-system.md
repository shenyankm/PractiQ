# PractiQ UI conventions

PractiQ extends shadcn/ui radix-nova with the shared warm-purple theme in
`shared/theme.css`. Keep the octopus brand, Lucide icons and existing components.
Nova defaults are a starting point; the deliberate product overrides below apply
to both App and Web. No change to service contracts or persisted practice data is
needed for these presentation rules.

| Role | Desktop | Narrow screen (below 768px) |
| --- | --- | --- |
| Page horizontal inset | 32px | 16px |
| Major section gap | 24px | 24px |
| Card inset | 24px | 16px |
| Page heading | 28px / 600 | 22px / 600 |
| Card heading | 18px / 600 | 18px / 600 |
| Controls, xs / sm / default / lg | 32 / 36 / 40 / 44px minimum | 48px minimum |

Web uses a 24px page inset at 768–1100px to retain content space beside its
sidebar. Touch-capable desktop controls also use the 48px minimum. Long translated actions
may wrap without losing padding. Compact bank headers keep frequent actions
visible and put merge in the labelled action menu. On phones, form labels sit
above full-width controls. Use semantic color tokens for normal, warning, error,
success, selected, read-only and disabled states.

Practice has one bounded content scroller and a separate footer. The footer must
never cover content, focused controls or the finish action. Narrow-screen answer
cards start collapsed; the View answer card link opens and focuses the existing
panel. Keep keyboard navigation, status counts and current-question markers.
Answer and grading states are separate from position/review markers in the help.
Submitted responses use readable, immutable content, not dimmed input widgets.

Images initially fit the viewer. Original-size inspection is explicit and keeps
horizontal/vertical scrolling and keyboard focus. Do not change source images,
checksums, lazy asset loading or exam reference-answer restrictions.

Web question review presents the question, missing-field warnings, supplied answer
and source evidence before technical metadata. Preserve nulls, unknown answer
structures and the complete original JSON under Source and technical details.
Never infer or generate a reference answer. File selection remains a keyboard-
accessible native input with a Chinese visible label; selection alone does not
upload or submit anything.

Capture stable evidence with `shared/browser-evidence.mjs`: hide development
controls, finish animations, record actual rendered theme/language/viewport, and
reset window scroll for full-page captures. Store page and cropped-image evidence
separately in the manifest. Browser fixtures do not prove native window, system
picker, keyboard/IME, physical-device or live-service behavior.

In multi-column forms, align label/control groups to the top of each grid cell;
helper text in a neighbouring field must not stretch the first field's label gap.

Narrow-screen answer-card help uses a scrollable dialog so short landscape views
retain readable content. Desktop help stays in a popover above the footer. Closing
either surface returns focus to its trigger.
