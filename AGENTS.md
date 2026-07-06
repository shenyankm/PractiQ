# Repository Guidelines

## Project Structure & Module Organization

OpenWook is a Next.js App Router application. Route groups and pages live in `app/`, with product screens under `app/(openwook)` and login flows under `app/(login)`. API routes are in `app/api`. UI should use HeroUI components directly, while domain logic, auth, Redis, object storage, import workers, and services are in `lib/openwook`. Drizzle schema, queries, and migrations are in `lib/db`; the SQL reference schema is in `db/schema.sql`. Tests are in `tests/`, assets in `public/`, and architecture notes in `docs/`.

## Build, Test, and Development Commands

- `pnpm install`: install dependencies and configure Git hooks through `prepare`.
- `pnpm dev`: run the local Next.js dev server with Turbopack.
- `pnpm build`: create a production build.
- `pnpm start`: serve the built application.
- `pnpm lint`: run ESLint using the Next core-web-vitals and TypeScript rules.
- `pnpm test`: run the Vitest suite once.
- `pnpm db:generate`, `pnpm db:migrate`, `pnpm db:studio`: manage Drizzle migrations and inspect the database.
- `pnpm worker:imports`: run the background import worker; use a separate terminal from `pnpm dev`.

## Coding Style & Naming Conventions

Use TypeScript with strict mode and the `@/*` path alias. Follow existing formatting: two-space indentation in JSON, semicolons, single quotes in TypeScript/TSX, and PascalCase for React components. Keep server-only code in server modules and preserve `import 'server-only'` where present. Prefer HeroUI components and existing project CSS tokens over adding local UI wrapper layers.

## Testing Guidelines

Vitest is configured in `vitest.config.ts` with `tests/setup.ts` and matches `tests/**/*.test.ts` and `tests/**/*.test.tsx`. Add tests beside the existing suite using descriptive names such as `services.test.ts` or `practice-page.dom.test.tsx`. Use DOM/React Testing Library patterns for TSX behavior and focused service tests for backend logic. Run `pnpm test` before opening a PR.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit-style prefixes with scopes, for example `fix(session): ...`, `style(ui): ...`, `chore(config): ...`, and `refactor(db): ...`. Keep commits focused and imperative. Pull requests should include a clear summary, linked issue when applicable, database or environment changes, screenshots for UI changes, and verification commands run.

## Security & Configuration Tips

Do not commit `.env.local` or secrets. Document new environment variables in `README.md` and keep sensitive work in server-side modules. Redis-backed queues, object storage, Alipay, and database features depend on local environment configuration; note required services in PRs that touch them.
