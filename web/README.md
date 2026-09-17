# PractiQ Web

React 19 + Vite + TypeScript + HeroUI v3. `npm ci`, `npm run dev`, `npm run verify`. Vite proxies `/api` to loopback port 8080. Production assets are served by the product FastAPI application after `npm run build`.

Only HeroUI default styles and static Tailwind layout utilities are allowed. See `AGENTS.md` and `scripts/check-styles.mjs`. The stylesheet has only official imports.

The desktop sidebar becomes mobile bottom navigation below 768px. Tests under `e2e/` exercise a real product API, requiring it and Vite to be running against disposable PostgreSQL (`npx playwright test`). No authentication, payment or WeChat integration exists.
