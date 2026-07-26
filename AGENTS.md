# Repository Guidelines

## Project Structure & Module Organization

OpenWook is a split-stack application. The React + Vite frontend lives in `frontend/`, with browser source in `frontend/src`, static assets in `frontend/public`, and frontend tests in `frontend/tests`. The Go `net/http` backend lives in `backend/`, with executables under `backend/cmd`, internal API/router/auth/config/db/services packages under `backend/internal`, and SQL schema files under `backend/db/*/*.sql`. AI service code lives in `ai/`, and architecture notes live in `docs/`.

## Build, Test, and Development Commands

- `make install`: install frontend dependencies from `frontend/pnpm-lock.yaml` and configure Git hooks.
- `make dev`: run the Vite frontend dev server from `frontend/`.
- `make build`: create a production frontend build.
- `make start`: serve the built frontend application.
- `make lint`: run the frontend ESLint and TypeScript rules.
- `make test`: run the Vitest suite once.
- `make db-apply`, `make db-seed`: apply the SQL schema and local sample data from `backend/`.
- `make worker-imports`: run the Go background import worker; use a separate terminal from `make dev`.

## Coding Style & Naming Conventions

Use TypeScript with strict mode and the `@/*` path alias. Follow existing formatting: two-space indentation in JSON, semicolons, single quotes in TypeScript/TSX, and PascalCase for React components. Keep server-only code in server modules and preserve `import 'server-only'` where present. Prefer HeroUI components and existing project CSS tokens over adding local UI wrapper layers.

## Testing Guidelines

Vitest is configured in `frontend/vitest.config.ts` with `frontend/tests/setup.ts` and matches `frontend/tests/**/*.test.ts` and `frontend/tests/**/*.test.tsx`. Add tests beside the existing suite using descriptive names such as `services.test.ts` or `practice-page.dom.test.tsx`. Use DOM/React Testing Library patterns for TSX behavior and focused service tests for backend logic. Run `make test` before opening a PR.

## Documentation Guidelines

After every code, schema, configuration, or workflow change, update the related documentation in the same change. Keep `README.md`, `docs/`, and feature-specific notes aligned with the current behavior.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit-style prefixes with scopes, for example `fix(session): ...`, `style(ui): ...`, `chore(config): ...`, and `refactor(db): ...`. Keep commits focused and imperative. Pull requests should include a clear summary, linked issue when applicable, database or environment changes, screenshots for UI changes, and verification commands run.

## Security & Configuration Tips

Do not commit `.env.local` or secrets. Document new environment variables in `README.md` and keep sensitive work in server-side modules. Redis-backed auth/events/caches, object storage, AI, and database features depend on local environment configuration; note required services in PRs that touch them.
