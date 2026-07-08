# Repository Guidelines

## Project Structure & Module Organization

OpenWook is a split-stack application. The React + Vite frontend lives in `frontend/`, with browser source in `frontend/src`, static assets in `frontend/public`, and frontend tests in `frontend/tests`. Go API routes, auth, Redis, object storage, import workers, billing, and services live under `cmd/` and `internal/`. The authoritative product schema lives in the split SQL files under `db/*/*.sql`, AI service code lives in `ai/`, and architecture notes live in `docs/`.

## Build, Test, and Development Commands

- `pnpm install`: install dependencies and configure Git hooks through `prepare`.
- `pnpm dev`: run the Vite frontend dev server from `frontend/`.
- `pnpm build`: create a production build.
- `pnpm start`: serve the built application.
- `pnpm lint`: run the frontend ESLint and TypeScript rules.
- `pnpm test`: run the Vitest suite once.
- `pnpm db:setup`, `pnpm db:ensure`, `pnpm db:seed`: bootstrap local environment variables, apply runtime compatibility SQL, and load local sample data after the split SQL schema has been installed.
- `pnpm worker:imports`: run the background import worker; use a separate terminal from `pnpm dev`.

## Coding Style & Naming Conventions

Use TypeScript with strict mode and the `@/*` path alias. Follow existing formatting: two-space indentation in JSON, semicolons, single quotes in TypeScript/TSX, and PascalCase for React components. Keep server-only code in server modules and preserve `import 'server-only'` where present. Prefer HeroUI components and existing project CSS tokens over adding local UI wrapper layers.

## Testing Guidelines

Vitest is configured in `frontend/vitest.config.ts` with `frontend/tests/setup.ts` and matches `frontend/tests/**/*.test.ts` and `frontend/tests/**/*.test.tsx`. Add tests beside the existing suite using descriptive names such as `services.test.ts` or `practice-page.dom.test.tsx`. Use DOM/React Testing Library patterns for TSX behavior and focused service tests for backend logic. Run `pnpm test` before opening a PR.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit-style prefixes with scopes, for example `fix(session): ...`, `style(ui): ...`, `chore(config): ...`, and `refactor(db): ...`. Keep commits focused and imperative. Pull requests should include a clear summary, linked issue when applicable, database or environment changes, screenshots for UI changes, and verification commands run.

## Security & Configuration Tips

Do not commit `.env.local` or secrets. Document new environment variables in `README.md` and keep sensitive work in server-side modules. Redis-backed queues, object storage, Alipay, and database features depend on local environment configuration; note required services in PRs that touch them.
