# Component style consistency audit

Date: 2026-10-11. Scope: App's 15 `components/ui` modules, Web's four `components/ui` modules, and HTML controls/content styles used directly in both frontends. The baseline is the user-selected warm-purple theme and [visual specification](design.md).

## Findings and changes

| Component scope | Finding and treatment |
| --- | --- |
| Button, Input, InputGroup, NativeSelect, Textarea | Controls mixed 32/36/40px heights, with another 32px English-button override. Ordinary controls now have 40px desktop and 48px touch minimums. Internal input-group fields remain borderless; disabled fields are not recolored as enabled. Textareas retain multiline heights. |
| NativeSelect and direct select/option controls | Options used system Canvas colors rather than the theme. Supported desktop browsers now share themed picker panels, selected states and checkmarks. Values, events, disabled options and keyboard behavior remain native. The question editor's English-type selector reuses NativeSelect. Web selects and development controls use the same CSS. |
| DropdownMenu | Shadows duplicated borders, menu-item spacing was tight and selected states relied on icons. Use one border, 12px panel corners, 8px item corners, and 36px desktop/48px touch items. Selected items gain soft-purple backgrounds; Radix focus and functional icons remain. |
| Card, Dialog, AlertDialog | Explicit panel corners were 16px but rounded-xl and dialog footers differed. Both frontends map rounded-xl to the panel token; footers match their outer corners. The question editor's scroll container establishes a positioning context so controls cannot cover the save footer after viewport shortening. Navigation drawers retain square corners and dynamic viewport constraints. |
| Checkbox, RadioGroup, Label | Unselected controls used older translucent dark surfaces. Use card surfaces while retaining checked, error, disabled and focus states, expanded touch targets and label associations. |
| Empty | Empty-state icons differed from Web's brand hints. Use secondary purple surfaces/foregrounds and 18px/600 component headings. |
| Sonner notifications | Ordinary notifications were themed, but rich success/information/error notifications retained library defaults. Add light/dark semantic colors, 12px corners, one border and visible keyboard focus. |
| Badge, brand, functional icons, navigation | Preserve pill-shaped badges, tabular figures, original octopus artwork, Lucide icons and semantic roles rather than forcing every control into the same shape. |
| Page content | Review banks, question lists/editors, mistakes, favorites, history, settings/service configuration, practice/answer cards and Web upload/tasks/results/resources. Reuse shared tokens, states and responsive layout. Keep link underlines and keyboard focus consistent. |

## Deliberate differences

- System select/file pickers and menus remain platform-controlled. Touch selects remain native. Older desktop browsers fall back automatically; outer controls retain the production theme.
- Panels, controls, badges and status icons use sizes/corners appropriate to their roles. Desktop icon buttons, compact selects, mobile drawers and long questions are not forced into ordinary-button styling.
- Web import/review and App offline practice retain separate information structures. API, authentication, grading, persistence, import and restore behavior are unchanged.

## Validation scope

Source review covers the modules and call sites above. Browser assertions and screenshots cover representative light/dark desktop and 390/360px views, ordinary control sizes, keyboard filtering, notification colors and mock API isolation. The current `node app/scripts/check-design-preview.mjs` covers App only, with outputs in `app/.build/design-preview/`; current phone/account-token Web captures use the Web browser suite. See the [2026-10-14 UI/UX acceptance record](evidence/2026-10-14-uiux/README.md) for fresh results and screenshots.

The original implementation record reports passing production builds and lint for both frontends, 19 Web browser tests, 61 App browser scenarios run in batches, and 19 representative screenshots/style assertions. Shortened-viewport editor saving, draft protection and touch navigation were retested after fixing the scroll container.

That record also reports 81 editor-related unit tests passing in batches. One test reached its default five-second timeout while build/browser checks ran concurrently, then passed alone with the original timeout unchanged. These are implementation-session observations; the pull request records its own verification separately.

Browser checks are not native-platform acceptance. This audit did not launch macOS/Windows installers or an Android emulator, and did not validate older Safari/WebView, Firefox or a real screen reader.
