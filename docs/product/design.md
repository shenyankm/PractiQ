# PractiQ warm-purple theme

This is the production visual specification for App and Web. Both frontends statically import [`shared/theme.css`](../../shared/theme.css) through `src/index.css`, so development and production use the same colors and base component styles. Changes under `shared/` trigger Service, Desktop and Android CI checks.

## Brand

Keep the PractiQ name, existing octopus artwork and Lucide functional icons. Display the logo proportionally without additional rounded cropping. The expanded sidebar logo has a transparent background; hover and keyboard focus retain the collapse hint. Leave room for reading and actions rather than adding decorative illustrations or product capabilities.

## Colors

Use warm-white pages (`#f7f4f1`), soft warm-white cards (`#fffcfa`), body text (`#302939`), primary purple (`#795088`) and secondary purple surfaces (`#eee6f0`). Danger, warning, review-required and unavailable states retain their semantics. The complete token set lives in `shared/theme.css` and maps to the existing shadcn semantic variables.

## Typography

Keep the system Chinese font stack. App page headings are 28px, Web headings 32px and bank headings 18px. Preserve existing body sizes; use line height and spacing to establish hierarchy. Counts and status numbers use tabular figures, and long question text wraps.

App and Web import `shared/document-content.css` for document rendering. Keep long formulas and tables horizontally scrollable inside their content area. Table words and numeric values retain their natural minimum width; oversized display equations keep their beginning reachable instead of centering into negative overflow. Practice and matching layouts use their container width, so the sidebar or large text cannot squeeze the question and selectors into unreadable columns.

## Page structure

App retains sidebar navigation, header actions, bank grids, question lists, mistakes, favorites, history, settings, service configuration, practice and existing editor/confirmation dialogs. The expanded sidebar is 208px; the collapsed width is unchanged. The resume region shows the saved session title and progress: submitted answers for practice, saved drafts for exams. Bank counts sit below their descriptions, leaving titles room to wrap. Question filters share one surface. Narrow question lists place actions below the summary; Previous/Next remain together in practice.

Web retains its three-step flow, upload/task sidebar and result review panel. Show the steps as one continuous region rather than separate cards, with a semantic current-step indicator. Connection precedes purchasing information; a compact balance strip keeps recharge and ledger controls expandable. The final step reflects a verified ZIP download for the same task/checkpoint, resets when the checkpoint changes and never starts model work. Cost information remains visible before import. See the [2026-10-14 acceptance record](../evidence/2026-10-14-uiux/README.md).

## Components

Cards use 16px corners and a single thin border without shadows. Reuse existing buttons and fields, events and disabled rules. Primary actions use purple; secondary actions use borders. Current navigation, tasks and answered items use soft-purple surfaces. Answer-card icons and text still convey state, while flagged items use a warning outline. Fields and dialogs use warm-white or warm-purple surfaces; existing components retain disabled, focus and error handling.

Ordinary buttons, inputs, input groups and selects have a desktop minimum height of 40px and a touch minimum of 48px. Desktop icon buttons retain their existing sizes; compact selects are 32px. Panels use 16px corners, controls use `--radius`, menus use 12px and menu items use 8px. Badges remain pill-shaped; checkboxes and radio buttons retain their semantic shapes. English buttons may wrap, with the same minimum height as Chinese buttons.

App and import Web share the shadcn/Radix single-select component. Desktop browsers use themed popup panels, selected surfaces and checkmarks without relying on `appearance: base-select` support. Coarse primary pointers retain system pickers with the same values and callbacks. Narrow desktop windows keep the custom menu. Both forms preserve labels, disabled states and keyboard selection; resizing preserves the current value.

Single-select controls center their selected text within the shared control height, with wrappers matching the control bounds so the arrow stays centered. Do not render empty quick-count rows in study setup; unavailable presets must not add blank vertical spacing.

Notifications reuse Sonner and existing theme switching. Success, information, warning and error foregrounds, backgrounds and borders come from shared semantic tokens, with 12px corners, one border and visible keyboard focus. See the [component audit](../history/product/design-audit.md).

## Dark mode and platforms

Dark mode uses warm-purple black pages (`#211c26`), cards (`#2b2431`) and pale-purple primary color (`#d9b5e5`). App retains system/light/dark preferences and reduced-motion support. Web retains its light default, with dark tokens shared with App; preview dark mode through `?theme=dark`. Preserve Android narrow navigation, dynamic viewports, safe areas and 48px touch targets.

## States and content

Keep interface guidance concise: remove generic page subtitles and repeated bank-card instructions, while preserving user-authored descriptions. Backup contents and import rules are available in keyboard-accessible disclosures. Keep supported formats and upload limits visible before file selection. Keep cost notices, destructive-action consequences, timed-exam behavior and recovery messages visible at the relevant action. App copy changes apply to both Chinese and English.

Exam setup must state that answers stay hidden during the exam and that a score preview is required before starting. Active result filters must explain that exports still include all completed questions. Partial-export guidance retains the available-question and matching-checkpoint requirements. Describe account tokens as stored only in page memory, without implying that refresh revokes the token.

Production continues to use existing local data or the independent service. Demo entry points use existing mock banks and task fixtures. Preserve unfinished practice, empty banks, failed units, missing answers, review flags, loading and errors. Do not change questions, grading, persistence, import, restore or authentication. The Web preview API is isolated from the real service and does not upload, call models or download real artifacts.

## OpenDesign workflow

The implementation's recorded workflow used the official `od-code-migration` Skill: read existing code, extract design constraints, map tokens, define scope, implement/build, review the diff and deliver the production theme. The original implementation record attributes execution to Codex; it did not start the OpenDesign desktop app or daemon.

Sources: [OpenDesign Skill](https://github.com/nexu-io/open-design/blob/main/plugins/_official/scenarios/od-code-migration/SKILL.md) and [design-system contract](https://github.com/nexu-io/open-design/blob/main/design-systems/README.md). OpenDesign uses [Apache-2.0](https://github.com/nexu-io/open-design/blob/main/LICENSE); the palette and CSS were written for PractiQ.
