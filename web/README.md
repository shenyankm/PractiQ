# PractiQ personal import Web

The independent React/Vite frontend opens directly into document import, task history, result correction and ZIP download. It has no accounts, administrator console, quotas, plans or payment flow. The shared import UI is also used by the macOS App.

Run `make web-install web-dev` from the repository root, with the personal AI service on `127.0.0.1:8090`. For production, `make web-build` creates static assets served by the AI service. Keep the deployment private. Credentials are configured in the service environment, never in the browser.

Run `make web-check` for types, lint, coverage, component tests and browser interactions with substituted HTTP responses. The macOS App remains independent for offline practice and ZIP import.
