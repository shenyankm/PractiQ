# Install PractiQ

The current source builds one macOS Electron application with embedded Node AI
workers, LangGraph.js, SQLite and local files. No independent service, Python,
Rust, PostgreSQL, RabbitMQ or LibreOffice installation is required. Historical
service runtime sources are retired. Frozen fixtures, Git history and retained
deployment/evidence files preserve the references described in the
[acceptance ledger](../maintainers/electron-migration.md).

Run commands from the repository root unless stated otherwise. Published
installers may predate this migration; check their release notes rather than
assuming these source instructions describe an older package.

## Before you start

| Item | Requirement |
| --- | --- |
| Desktop | macOS 14+ on Apple Silicon; other targets are not accepted |
| Node.js | 22.18+ within 22.x, or 24.11+ |
| macOS tools | Command Line Tools providing the system signing/package utilities |
| Network | Needed to install locked npm dependencies and Electron; explicit AI actions and playback addresses also need network access |

```sh
git clone https://github.com/shenyankm/PractiQ.git
cd PractiQ
make install
make dev
```

`make install` runs `npm ci` and explicitly installs the locked Electron binary.
It does not start an AI task. `make dev` builds the renderer and starts Electron
with its embedded workers. A browser Vite page alone is not the desktop app.

## Build and verify a package

```sh
make verify
make audit
# Choose a fresh output directory; do not reuse an existing package path.
make app-package-check APP_PACKAGE_DIRECTORY="$PWD/app/.build/packages/my-check"
```

`make verify` checks generated contracts, frontend types/lint/coverage, embedded
runtime coverage, CI/release regressions and the production renderer build.
`make audit` checks the locked npm dependencies. `make app-package-check` builds
the application and DMG, independently installs that same DMG into a temporary
location, and verifies its contents, protected credentials and recovery flows.
Reports distinguish local providers/substituted dialogs from live acceptance.

Outputs in the selected directory include `PractiQ.app`, a versioned `.dmg` and
`package-report.json`. Without an override, `make build` creates a fresh directory
under `app/.build/packages/`. Local packages are ad-hoc signed and not notarized
distribution releases. These checks do not establish real-provider accuracy.

## Confirm offline practice works

Run `make dev` or open the packaged app, then:

1. When **My banks** is empty, choose **Add example bank**.
2. Open the bank and choose **Start practice**.
3. Answer an objective question, submit, and review the score.
4. Export a learning backup under **Settings → Import and restore**.

This needs no provider keys or model calls. The example omits recordings;
listening questions need a QR-derived or manually supplied playback address.
Historical ZIPs, recordings and version-4/schema-11 learning backups remain
supported. Older database schemas are rejected without replacement.

## Configure optional AI import and grading

Open **Settings → AI model and recognition** and save the model provider,
endpoint, model ID/API key and Tencent Secret ID/Secret Key. Import and explicit
grading share this configuration. Current credentials use macOS-protected
encrypted local storage; learning backups exclude credentials and AI task state.
Preserve old `.env` files and Keychain namespaces; they are not imported or
deleted automatically.

Choose a supported document under **Document import**, then explicitly select
**Start import** to authorize Tencent recognition and model processing. Merely
selecting a file does not submit it. Review the saved results before importing
them into a bank. Office files exceeding the current transport/type limit must
first be exported as PDF. New CSV imports are unsupported.

These actions may incur provider charges. Unknown paid outcomes are retained
and never resent automatically. Reads, exports and backups do not call models.
If keys are unavailable, skip the live step and report it as untested.

## Preserve existing data

The production Electron profile uses `v4/` under its macOS user-data directory
(normally `~/Library/Application Support/PractiQ/v4/`). The earlier
`electron-migration/v4/` prototype and Tauri's `com.practiq.desktop` profile are
left untouched; they are not silently adopted. To transfer practice data, export
a version-4/schema-11 learning backup from the previous installation and restore
it explicitly under **Settings → Import and restore**. Current provider
credentials must be configured separately and never travel in learning backups.

Do not remove old application directories, AI task files, service database
volumes, backups or credentials to make a build work. Use isolated test profiles
and fresh package paths. If a damaged practice database prevents startup, follow
[desktop recovery](desktop-recovery.md) and retain the complete original
directory before restoring a backup into a new one.

For a copy-only comparison against an old profile, build the current runtime,
then run from `app/`:

```sh
npm run desktop:build
npm run verify:existing-data -- /absolute/legacy/profile
```

The verifier retains private copies and reports under ignored `.build/evidence/`.
It does not authorize modifying the original profile.

## Notes for coding agents

- Ask before installing system packages or changing anything outside this task.
- Never print, commit or include provider keys in logs, fixtures or backups.
- Keep generated artifacts and local state ignored, including retained legacy state.
- Preserve first failures and report actual commands, output paths and skipped checks.
- Do not treat substitute-provider tests or successful packaging as live-model,
  clean-machine, signing or publication acceptance.

See the [contribution guide](../../CONTRIBUTING.md) for browser/native tests and
release checks, and the [practice guide](practice-guide.md) for user workflows.
