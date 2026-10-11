# PractiQ warm-purple theme

This is the production visual specification for App and Web. Both frontends statically import [`shared/theme.css`](../shared/theme.css) through `src/index.css`, so development and production use the same colors and base component styles. Changes under `shared/` trigger Service, Desktop and Android CI checks.

## Brand

Keep the PractiQ name, existing octopus artwork and Lucide functional icons. Display the logo proportionally without additional rounded cropping. The expanded sidebar logo has a transparent background; hover and keyboard focus retain the collapse hint. Leave room for reading and actions rather than adding decorative illustrations or product capabilities.

## Colors

Use warm-white pages (`#f7f4f1`), soft warm-white cards (`#fffcfa`), body text (`#302939`), primary purple (`#795088`) and secondary purple surfaces (`#eee6f0`). Danger, warning, review-required and unavailable states retain their semantics. The complete token set lives in `shared/theme.css` and maps to the existing shadcn semantic variables.

## Typography

Keep the system Chinese font stack. App page headings are 28px, Web headings 32px and bank headings 18px. Preserve existing body sizes; use line height and spacing to establish hierarchy. Counts and status numbers use tabular figures, and long question text wraps.

## Page structure

App retains sidebar navigation, header actions, bank grids, question lists, mistakes, favorites, history, settings, service configuration, practice and existing editor/confirmation dialogs. The expanded sidebar is 208px; the collapsed width is unchanged. Web retains its three-step flow, upload/task sidebar and result review panel. Show the steps as one continuous region rather than separate cards.

## Components

Cards use 16px corners and a single thin border without shadows. Reuse existing buttons and fields, events and disabled rules. Primary actions use purple; secondary actions use borders. Current navigation, tasks and answered items use soft-purple surfaces. Answer-card icons and text still convey state, while flagged items use a warning outline. Fields and dialogs use warm-white or warm-purple surfaces; existing components retain disabled, focus and error handling.

Ordinary buttons, inputs, input groups and selects have a desktop minimum height of 40px and a touch minimum of 48px. Desktop icon buttons retain their existing sizes; compact selects are 32px. Panels use 16px corners, controls use `--radius`, menus use 12px and menu items use 8px. Badges remain pill-shaped; checkboxes and radio buttons retain their semantic shapes. English buttons may wrap, with the same minimum height as Chinese buttons.

Desktop single-select controls use themed picker panels, selected surfaces and checkmarks when `appearance: base-select` is supported. Touch devices and unsupported browsers retain system pickers, without changes to select values, events or keyboard behavior. Follow [MDN's progressive-enhancement approach](https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Forms/Customizable_select); no JavaScript select dependency is added.

Notifications reuse Sonner and existing theme switching. Success, information, warning and error foregrounds, backgrounds and borders come from shared semantic tokens, with 12px corners, one border and visible keyboard focus. See the [component audit](design-audit.md).

## Dark mode and platforms

Dark mode uses warm-purple black pages (`#211c26`), cards (`#2b2431`) and pale-purple primary color (`#d9b5e5`). App retains system/light/dark preferences and reduced-motion support. Web retains its light default, with dark tokens shared with App; preview dark mode through `?theme=dark`. Preserve Android narrow navigation, dynamic viewports, safe areas and 48px touch targets.

## States and content

Production continues to use existing local data or the independent service. Demo entry points use existing mock banks and task fixtures. Preserve unfinished practice, empty banks, failed units, missing answers, review flags, loading and errors. Do not change questions, grading, persistence, import, restore or authentication. The Web preview API is isolated from the real service and does not upload, call models or download real artifacts.

## OpenDesign workflow

The implementation's recorded workflow used the official `od-code-migration` Skill: read existing code, extract design constraints, map tokens, define scope, implement/build, review the diff and deliver the production theme. The original implementation record attributes execution to Codex; it did not start the OpenDesign desktop app or daemon.

Sources: [OpenDesign Skill](https://github.com/nexu-io/open-design/blob/main/plugins/_official/scenarios/od-code-migration/SKILL.md) and [design-system contract](https://github.com/nexu-io/open-design/blob/main/design-systems/README.md). OpenDesign uses [Apache-2.0](https://github.com/nexu-io/open-design/blob/main/LICENSE); the palette and CSS were written for PractiQ.
