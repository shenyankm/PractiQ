# Desktop development and browser tests

`make app-dev AI_PYTHON=/path/to/python3.14` starts the real macOS client.
Development and production use the same native Tauri commands, SQLite data,
Keychain credentials and explicit cloud connection flow. There is no development
preview panel, automatic demo-data mode or `design-preview` application mode.
Old `practiq-preview` session-storage values have no effect.

Document import stays in the sidebar, with an additional action for an empty
bank list. The bank header omits this duplicate action.

New and edited bank names allow 1–15 Unicode characters after trimming, and
descriptions allow 0–50 characters. The editor shows counts and blocks oversized
saves without truncating existing text. Merge and ZIP-import name fields use the
same name limit; generated document-import names use the first 15 characters.
Existing bank metadata, historical ZIP metadata and backups remain readable and
retain their full text. An unchanged archived ZIP title may exceed 15 characters;
renaming it during import uses the new limit.

Running `npm --prefix app run dev` starts only the frontend server. A standalone
browser does not provide the native database, file dialogs or account bridge;
use `make app-dev` for ordinary development.

## Browser-only fixtures

Playwright suites that need synthetic banks, practice history or accounts install
`app/scripts/browser-fixtures.mjs` explicitly. It substitutes the transport module
only in that test page. Its in-memory data and scenario selector live under
`app/scripts/fixtures/`, outside the application source and build entry points.
Tests select a scenario with their own `practiq-test-scenario` session-storage
key. No application menu, URL flag or environment mode enables these fixtures.
Native-interface browser suites supply their own IPC substitutes instead.

These tests verify UI behavior with synthetic data. They do not verify native
file dialogs, Keychain, SQLite persistence, real provider quality or payments.
The App's explicit “Add example bank” action remains a real local import and is
independent of these test fixtures.

Run from the repository root:

```sh
npm --prefix app run check:ui
npm --prefix app run test:browser
# Focused synthetic UI interaction suites:
npm --prefix app run test:preview
```

For the standalone screenshot checker, start the ordinary Vite server on its
expected loopback port, then run the checker in another terminal:

```sh
npm --prefix app run dev -- --port 1426
node app/scripts/check-design-preview.mjs
```

The checker explicitly installs browser fixtures and writes screenshots/reports
under `app/.build/design-preview/`; this historical script/output name does not
represent an application mode. Screenshots use the same App components and theme.
`shared/browser-evidence.mjs` finishes animations and records the rendered theme,
language and viewport without hiding application controls.

The embedded import workspace is covered by `npm --prefix app run test:browser`
with substituted native IPC and HTTP responses. No separate Web frontend is shipped.
