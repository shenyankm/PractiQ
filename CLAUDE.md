# CLAUDE.md

Read `AGENTS.md` for authoritative architecture, data/recovery boundaries and
delivery rules. PractiQ is a single macOS Electron/TypeScript application with
embedded Node AI workers, LangGraph.js, SQLite and local files.

## Commands

From the repository root:

```sh
make install           # locked npm dependencies and Electron binary
make dev               # renderer build, Electron and embedded workers
make verify            # contracts, types, lint, coverage, CI/release tests, build
make audit             # npm dependency audit
make app-package-check # fresh app/DMG and independent installed-package checks
make test-e2e          # browser and real Electron flows with local providers
```

Focused checks from `app/`:

```sh
npx vitest run src/NativeIpcContracts.test.ts
npm run desktop:build
npx vitest run --config desktop/vitest.config.ts desktop/backup.test.ts
npm run test:electron
```

Backend helpers consume compiled `.build/electron/` code. Serialize builds and
checks using that directory. Do not repeat full passing suites without a new
change, failure or concern. Node/npm and supported macOS system tools are the
current toolchain; no Python, Cargo, Docker or independent service is needed.

## Cross-file map

- Renderer: `app/src/api.ts` → `transport.ts` → Electron typed preload/main IPC.
- Practice: `app/desktop/store.ts`, `questions.ts`, `paper.ts`, `sessions.ts`,
  `bank-packages.ts`, `backup.ts`, `legacy-settings.ts` and `learning.ts`.
- AI: `document-api.ts`/AI worker → LangGraph.js runtime, document graphs,
  SQLite checkpoints/Store, durable provider receipts and verified local files.
- Contracts: `shared/ai-contracts.json` → `app/scripts/export-contracts.ts` →
  generated types. Frozen wire/model/grading/IPC baselines are test inputs.
- Packaging/release: `app/scripts/package-electron.ts`, `release.ts` and related
  validators; final candidate/source/lock/license identity remains mandatory.

Historical `server/` deployment files, docs/evidence and ignored data stay
preserved. Never restore the retired Rust/Python runtime or remove an entire old
directory to clean tracked files. Old Keychain/env values and deployment volumes
are not current provider configuration and must not be reinterpreted or deleted.

Use `docs/README.md`, `docs/guides/installation.md`, `docs/guides/import-tasks.md`,
`docs/reference/question-model.md` and the migration ledger for current guidance.
Record actual checks and remaining native/live-provider acceptance in the PR;
use the repository contribution templates and Conventional Commits.
