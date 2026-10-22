# PractiQ warm-purple theme

This is the production visual specification for App and Web. Both frontends statically import [`shared/theme.css`](../../shared/theme.css) through `src/index.css`, so development and production use the same colors and base component styles. Changes under `shared/` trigger Service, Desktop and Android CI checks.

## Brand

Keep the PractiQ name, existing octopus artwork and Lucide functional icons. Display the logo proportionally without additional rounded cropping. The expanded sidebar logo has a transparent background; hover and keyboard focus retain the collapse hint. Leave room for reading and actions rather than adding decorative illustrations or product capabilities.

## Colors

Use warm-white pages (`#f7f4f1`), soft warm-white cards (`#fffcfa`), body text (`#302939`), primary purple (`#795088`) and secondary purple surfaces (`#eee6f0`). Sidebars and app chrome use the second neutral layer (`--sidebar`, `--sidebar-accent`), one step warmer than the page. Danger, warning, review-required and unavailable states retain their semantics. The complete token set lives in `shared/theme.css` and maps to the existing shadcn semantic variables.

## Typography

Keep the system Chinese font stack. Roles use the fixed scale in `shared/theme.css`: page heading `--text-page` (28px, 22px on narrow screens), section heading `--text-section` (20px), card and dialog title `--text-card` (18px), body `--text-body` (14px) and meta `--text-meta` (12px). Do not add one-off font sizes; use line height and spacing to establish hierarchy. Headings use balanced wrapping and prose paragraphs use pretty wrapping. Keep prose within 68ch; dense tables and records may run wider. Counts and status numbers use tabular figures, and long question text wraps.

App and Web import `shared/document-content.css` for document rendering. Keep long formulas and tables horizontally scrollable inside their content area. Table words and numeric values retain their natural minimum width; oversized display equations keep their beginning reachable instead of centering into negative overflow. Practice and matching layouts use their container width, so the sidebar or large text cannot squeeze the question and selectors into unreadable columns.

## Page structure

App retains sidebar navigation, header actions, bank grids, question lists, mistakes, favorites, history, settings, service configuration, practice and existing editor/confirmation dialogs. The expanded sidebar is 208px; the collapsed width is unchanged. The resume region shows the saved session title and progress: submitted answers for practice, saved drafts for exams. Bank counts sit below their descriptions, leaving titles room to wrap. Question filters share one surface. Narrow question lists place actions below the summary; Previous/Next remain together in practice.

Web keeps separate import, task history and import-settings pages. Show import steps as one continuous region with a semantic current-step indicator. Connection uses the personal service token. The final step reflects a verified ZIP download for the same task/checkpoint, resets when the checkpoint changes and never starts model work. Result review puts question content, supplied answers and source text before collapsible technical records.

## Components

Cards use 16px corners and a single thin border without shadows. Overlays (dialogs, menus, popovers, toasts) separate from the page with `--overlay-shadow`: a soft offset shadow with blur, never a hard block shadow. Reuse existing buttons and fields, events and disabled rules. Primary actions use purple; secondary actions use borders. Current navigation, tasks and answered items use soft-purple surfaces. Answer-card icons and text still convey state, while flagged items use a warning outline. Fields and dialogs use warm-white or warm-purple surfaces; existing components retain disabled, focus and error handling. Focus indicators use a 3px full-opacity ring; a translucent ring is not sufficient contrast.

Ordinary buttons, inputs, input groups and selects have a desktop minimum height of 40px and a touch minimum of 48px. Desktop xs, sm and lg buttons use 32px, 36px and 44px minimums respectively, including icon buttons; compact selects are 36px. Panels use 16px corners, controls use `--radius`, menus use 12px and menu items use 8px. Badges remain pill-shaped; checkboxes and radio buttons retain their semantic shapes. English buttons may wrap, with the same minimum height as Chinese buttons.

App and import Web reuse Card, Badge, Input and button variants from `shared/ui.tsx`; their local modules retain the public imports. App buttons keep their WebKit focus handling. Both Tailwind entries scan `shared/` for component classes.

App and import Web share the shadcn/Radix single-select component. Desktop browsers use themed popup panels, selected surfaces and checkmarks without relying on `appearance: base-select` support. Coarse primary pointers retain system pickers with the same values and callbacks. Narrow desktop windows keep the custom menu. Both forms preserve labels, disabled states and keyboard selection; resizing preserves the current value.

Web file selection keeps a keyboard-accessible native input and a visible Chinese action label, with 40px desktop / 48px touch targets. File selection alone does not upload or start import.

The bank-home Refresh action belongs to the top action group beside New bank and Import. Keep bank pagination below the list, and disable refresh while its read is pending. The import Web header shows the brand; connection errors remain next to their recovery action.

Single-select controls center their selected text within the shared control height, with wrappers matching the control bounds so the arrow stays centered. Do not render empty quick-count rows in study setup; unavailable presets must not add blank vertical spacing.

Bank cards use a content-aware grid and wrap whole footer actions when space is limited. Keep short action labels on one line; longer localized actions retain vertical padding. Menus size to their contents within the available viewport. Question lists lead with the stem, followed by wrapping type, score and bank metadata, so every stem shares the same starting edge. Give the question-type filter enough width for its English labels.

Notifications reuse Sonner and existing theme switching. Success, information, warning and error foregrounds, backgrounds and borders come from shared semantic tokens, with 12px corners, one border and visible keyboard focus. See the [component audit](../history/product/design-audit.md).

Service-configuration save, connection-test and token-clear failures stay beside their fields and actions. Do not duplicate them in persistent global toasts that can cover later workflows. A failed pre-test save keeps its draft and save-retry action without adding a second connection-test error; failed token clearing leaves the original clear action available to retry.

## Dark mode and platforms

Dark mode uses warm-purple black pages (`#211c26`), cards (`#2b2431`), sidebars (`#251f2a`) and pale-purple primary color (`#d9b5e5`). Interactions use the shared `--motion-duration` (180ms) and `--motion-ease` tokens; motion conveys state only. App retains system/light/dark preferences and reduced-motion support, which removes overlay entrances without removing their final state. Web retains its light default, with dark tokens shared with App; preview dark mode through `?theme=dark`. Preserve Android narrow navigation, dynamic viewports, safe areas and 48px touch targets.

## States and content

Keep interface guidance concise: remove generic page subtitles and repeated bank-card instructions, while preserving user-authored descriptions. Both Chinese variants use full-width punctuation and “” quotes, refer to the desktop app as 应用/應用程式, and end error messages with terminal punctuation in every language; binary file limits are labelled MiB. Backup contents and import rules are available in keyboard-accessible disclosures. Keep supported formats and upload limits visible before file selection. Keep cost notices, destructive-action consequences, timed-exam behavior and recovery messages visible at the relevant action. App copy changes apply to Simplified Chinese, Traditional Chinese and English.

Exam setup must state that answers stay hidden during the exam and that a score preview is required before starting. Active result filters must explain that exports still include all completed questions. Partial-export guidance retains the available-question and matching-checkpoint requirements. Describe account tokens as stored only in page memory, without implying that refresh revokes the token.

Production continues to use existing local data or the independent service. Demo entry points use existing mock banks and task fixtures. Preserve unfinished practice, empty banks, failed units, missing answers, review flags, loading and errors. Do not change questions, grading, persistence, import, restore or authentication. The Web preview API is isolated from the real service and does not upload, call models or download real artifacts.

## OpenDesign workflow

The implementation's recorded workflow used the official `od-code-migration` Skill: read existing code, extract design constraints, map tokens, define scope, implement/build, review the diff and deliver the production theme. The original implementation record attributes execution to Codex; it did not start the OpenDesign desktop app or daemon.

Sources: [OpenDesign Skill](https://github.com/nexu-io/open-design/blob/main/plugins/_official/scenarios/od-code-migration/SKILL.md) and [design-system contract](https://github.com/nexu-io/open-design/blob/main/design-systems/README.md). OpenDesign uses [Apache-2.0](https://github.com/nexu-io/open-design/blob/main/LICENSE); the palette and CSS were written for PractiQ.

Shared spacing, responsive forms, readable submitted answers, fitted image viewing and answer-card help follow the [UI conventions](../ui-design-system.md). See the [2026-10-21 fixes and acceptance gallery](../evidence/2026-10-21-uiux-fixes/README.md).
