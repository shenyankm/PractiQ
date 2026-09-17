# Web boundary and UI policy

This is a loopback-only personal application without accounts. Do not expose the API on a public or shared network without a separate access-boundary design.

- API requests are same-origin (`/api` via Vite proxy during development). Host and Origin checks remain, including rejection of cross-site mutations and noncanonical API paths.
- There are no access/refresh tokens or user-scoped browser caches. AI and object-storage secrets stay on the servers.
- Exam pages and aggregate statistics omit answer keys, correctness and scores until completion. Management pages deliberately expose reference answers because this is a personal authoring tool, not a proctored examination system.
- Imported text/model output is rendered as text through React/HeroUI. No `dangerouslySetInnerHTML`, raw HTML execution or remote script embedding.
- Media is validated server-side, referenced by resource ID and served with a checked content type. Imports use file fingerprints and stable idempotency keys to recover uncertain writes. No native temporary-file path assumptions remain.
- HeroUI defaults are mandatory. `web/scripts/check-styles.mjs` rejects custom stylesheets, inline styles, dynamic classes, arbitrary values and non-layout classes. `web/src/styles.css` may contain only official Tailwind/HeroUI imports.
- Browser tests cover 375, 768 and 1440 pixel layouts. Actual server deployment and mobile network access are outside the local-only scope.
