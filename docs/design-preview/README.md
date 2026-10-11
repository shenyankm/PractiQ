# Warm-purple representative page preview

This implements the user's selected warm-purple direction: warm-white backgrounds, softer cards and corners. Keep the octopus brand, original UI copy, existing React/shadcn components and business logic. See the [production specification](../design.md) and [shared theme](../../shared/theme.css).

The original implementation record used OpenDesign's official [od-code-migration Skill](https://github.com/nexu-io/open-design/blob/main/plugins/_official/scenarios/od-code-migration/SKILL.md), executed by Codex through code reading, design extraction, token mapping, implementation, build verification and delivery. It did not install the OpenDesign desktop app, configure MCP or run a daemon. No runtime dependency was added.

## Open the preview

Run each command in a separate terminal:

```sh
cd app
npm run dev -- --mode design-preview --port 1426
```

```sh
cd web
npm run dev -- --mode design-preview --port 5178
```

- App: <http://127.0.0.1:1426/>. Choose “开始练习 → 立即开始” on a bank to view practice. Use the sidebar's “主题” menu for light/dark mode. Design preview hides the floating “开发预览 · 示例数据” controls; normal development retains that panel for empty, failed and other scenarios.
- Web: <http://127.0.0.1:5178/>. Connect with `preview-only`, then choose `sample.docx` to review partial results, review flags and missing answers. Dark preview: <http://127.0.0.1:5178/?theme=dark>.

Both entry points use mock data. Web middleware intercepts all `/api` requests: unknown GET routes and exports return 404, mutations return 409, and nothing forwards to the real service. File selection shows pending submission, but cannot upload, parse, export or delete real resources. Do not enter a real Token.

## Checks and screenshots

With both preview servers running, execute from the repository root:

```sh
node app/scripts/check-design-preview.mjs
```

The script checks theme switching and practice start, desktop/narrow overflow, ordinary 40px/48px controls, keyboard filtering, light/dark notifications, absence of native calls, mock API isolation and memory-only Web tokens. Screenshots and reports go to `app/.build/design-preview/`, covering banks, questions, editing, mistakes, favorites, history, settings, service configuration, practice and Web results in representative light/dark and narrow views.

Normal development, mock preview and production builds statically load the same theme. Web mock API middleware activates only in Vite's `design-preview` serve mode. Production builds, frontend checks and browser interaction evidence remain distinct from native-platform acceptance.

## Scope

The shared theme covers both production entry points and common components. It does not change Rust/service runtime code, API contracts, SQLite, grading or restore logic. Shared theme files are included in all CI path selectors. Mock preview is not native-platform acceptance.
