# PractiQ Web

React 19 + Vite + TypeScript + HeroUI v3. `npm ci`, `npm run dev`, `npm run verify`. Vite proxies `/api` to loopback port 8080. Production assets are served by the product FastAPI application after `npm run build`.

Only HeroUI default styles and static Tailwind layout utilities are allowed. See `AGENTS.md` and `scripts/check-styles.mjs`. The stylesheet has only official imports.

The HeroUI DisclosureGroup sidebar organizes question banks, learning analytics and system settings. Below 768px, it becomes collapsible top navigation; navigation closes the mobile panel and expands the destination group. Tests under `e2e/` exercise a real product API, requiring it and Vite to be running against disposable PostgreSQL (`npx playwright test`). No authentication, payment or WeChat integration exists.


`/imports` and `/imports/new` expose the same HeroUI form: required bank name and file, optional description and comma-separated tags. File types are inferred from extensions and validated again by the backend. AI suggestions are generated from the name and explicitly adopted; pending AI tasks and import request keys survive refresh. The isolated `e2e/import-form.spec.ts` mocks network calls and can run against the local Web without creating real records or invoking a model.
