# Repository Guidelines

## Project Structure & Module Organization

PractiQ is a unified-stack application. The Taro frontend lives in `taro/` and targets WeChat Mini Program only. The unified Python FastAPI backend lives in `server/`, with routes under `server/routes/`, services under `server/services/`, auth under `server/auth/`, AI under `server/agents/` + `server/extractors/`, the import worker at `server/worker.py`, and the admin CLI at `server/admin.py`. SQL under `db/*/*.sql` remains the schema authority; architecture notes live in `docs/`.

## Build, Test, and Development Commands

- `make install`: install Taro dependencies from the lockfile.
- `make taro-weapp`: start the WeChat Mini Program watcher.
- `make test`: type-check and build the WeChat Mini Program.
- `make test-server`: run the server pytest suite.
- `make db-apply`, `make db-seed`: apply and seed the SQL schema.
- `make server-dev`, `make worker-imports`: run the API and import worker.

## Coding Style & Naming Conventions

Use strict TypeScript, Taro components, and plain CSS. Keep WeChat-specific code at storage, files, payments, and authentication boundaries. Follow existing formatting and use PascalCase for React components. Do not add abstractions or dependencies before a migrated feature needs them.

## Testing Guidelines

Run `make test` for Taro changes and `make test-server` for server changes. Run `make verify` before opening a PR. Each migrated feature must compare request payloads, states, and visible results against the behavior recorded in `docs/taro-migration.md`.

## Documentation Guidelines

After every code, schema, configuration, or workflow change, update related documentation in the same change. Keep `README.md`, `docs/`, and feature notes aligned with current behavior.

## Commit & Pull Request Guidelines

Use focused Conventional Commit-style subjects such as `fix(session): ...` or `chore(config): ...`. PRs should include a clear summary, linked issue when applicable, environment changes, screenshots for UI changes, and verification commands.

## Security & Configuration Tips

Do not commit `.env.local` or secrets. Production traffic must use HTTPS. Keep tokens out of logs and ordinary storage, and configure the production WeChat appid and legal request domains outside committed secrets.
