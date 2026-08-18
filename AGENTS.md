# Repository Guidelines

## Project Structure & Module Organization

PractiQ is a unified-stack application. The Expo/React Native mobile client lives in `mobile/`. The unified Python FastAPI backend lives in `server/`, with the app entry at `server/app.py`, routes under `server/routes/`, business services under `server/services/`, auth under `server/auth/`, AI agents under `server/agents/` + `server/extractors/`, the import worker at `server/worker.py` (`python -m server.worker`), and the admin CLI at `server/admin.py` (`python -m server.admin db apply|seed`). SQL schema files under `db/*/*.sql` remain the schema authority, and architecture notes live in `docs/`. The three-tier membership system (free/pro/organization + 3-day Pro trial, public-bank clone, study groups) is documented in `docs/membership-design.md`; it adds `server/routes/study_groups.py` + `server/services/study_groups.py` and the `db/users/60_study_groups.sql` schema fragment.

## Build, Test, and Development Commands

- `make install`: install mobile dependencies from the lockfile.
- `make mobile-dev`, `make mobile-android`, `make mobile-ios`: start or run the Expo client.
- `make lint`: lint the mobile client.
- `make test`: run mobile type checking and tests.
- `make db-apply`, `make db-seed`: apply the SQL schema and local sample data from `db/`.
- `make server-dev`: run the unified FastAPI server; `make worker-imports`: run the import queue worker in a separate terminal.
- `make test-server`: run the server pytest suite from `server/`.

## Coding Style & Naming Conventions

Use TypeScript with strict mode and the `@/*` path alias. Follow existing formatting: two-space indentation in JSON, semicolons, single quotes in TypeScript/TSX, and PascalCase for React components. Prefer HeroUI Native, Uniwind, and the shared components under `mobile/src/components/` over adding local UI wrapper layers.

## Testing Guidelines

The server pytest suite lives in `server/tests/` and runs via `make test-server`. Mobile tests and type checking run via `make mobile-test` (also covered by `make test`). Run `make verify` before opening a PR.

## Documentation Guidelines

After every code, schema, configuration, or workflow change, update the related documentation in the same change. Keep `README.md`, `docs/`, and feature-specific notes aligned with the current behavior.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit-style prefixes with scopes, for example `fix(session): ...`, `style(ui): ...`, `chore(config): ...`, and `refactor(db): ...`. Keep commits focused and imperative. Pull requests should include a clear summary, linked issue when applicable, database or environment changes, screenshots for UI changes, and verification commands run.

## Security & Configuration Tips

Do not commit `.env.local` or secrets. Document new environment variables in `README.md` and keep sensitive work in server-side modules. Redis-backed auth/events/caches, object storage, AI, and database features depend on local environment configuration; note required services in PRs that touch them.
