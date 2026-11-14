# Contribute to PractiQ

The approved Electron/TypeScript migration is tracked in
[the acceptance ledger](docs/maintainers/electron-migration.md) and issue #549.
During this migration, the old architecture below remains a behavioral reference.
New desktop work belongs in `app/desktop/`; it must not forward unported
operations to the old runtime. Test with isolated data directories.

Run `make app-install` to install locked npm dependencies and the locked Electron
binary. From `app/`, the equivalent is `npm ci` followed by
`npm run desktop:install`; npm dependency installation alone does not install
Electron's binary. Packaging also runs this explicit installation step before
building and stops if it fails.

`make app-dev` (or `npm run desktop` from `app/`) now starts Electron with the
embedded Node AI runtime. It does not prepare Tauri resources or start a Python
service. The production renderer requires Electron's typed preload bridge;
browser test data is installed only by the explicit browser harness. The import
workspace and model settings use the embedded runtime without a service URL.
`make app-build` now creates a fresh Electron app and DMG; `make app-package-check`
builds and independently verifies that same output. Set `APP_PACKAGE_DIRECTORY`
on the Make command line to choose a fresh output directory. Default install,
test and verification commands now use Node. Release candidate
validation, DMG staging and draft assembly now use `app/scripts/release.ts`.

From `app/`, use `npm run desktop:build` and `npm run test:desktop` for the new
runtime and its type checks. `npm run check:packaging` checks the maintainer tools;
`npm run package:electron` builds a local macOS application and DMG. Verify it with
`npm run test:package -- /absolute/package-output`. An optional second argument
selects a legacy profile for copy-only compatibility checks. The standalone
`npm run verify:existing-data -- /absolute/legacy/profile` also operates only on
private copies and requires a current `npm run desktop:build` first. Retain its
ignored `.build/evidence/` reports and copies locally. These are migration tools;
they do not authorize replacing an existing profile.
Local packages use ad-hoc signing and are not notarized distribution builds.

`npm run test:electron` exercises the complete compiled desktop with local provider
substitutes. To run the same workflows against a package, copy `PractiQ.app`
outside the checkout, then run
`npm run test:electron:installed -- /absolute/copied/PractiQ.app/Contents/MacOS/PractiQ`.
The installed check uses a private profile, system-only PATH and the package's
compiled modules; file dialogs remain substituted. macOS CI builds and checks both
the copied app workflows and the installed DMG, including protected credentials.
Reports distinguish these local checks from live provider and remote CI results.

Use this guide to prepare a focused contribution. The [installation guide](docs/guides/installation.md) covers setup; [README.md](README.md) covers the product and supported platforms; [AGENTS.md](AGENTS.md) defines architecture and coding rules; the [documentation index](docs/README.md) links to detailed guides.

Follow our [Code of Conduct](CODE_OF_CONDUCT.md) in all project community spaces.

## Choose a change

Search existing issues before opening a new one. Use the [issue chooser](https://github.com/shenyankm/PractiQ/issues/new/choose) for bug reports, feature requests, and usage questions. Report suspected vulnerabilities privately through [SECURITY.md](SECURITY.md).

Open an issue before starting a feature, architecture change, new dependency, or public API change. Explain the problem and intended outcome so the scope can be discussed. Focused bug fixes and documentation corrections may go directly to a pull request unless the proposed solution changes those boundaries.

Write issue and PR titles and descriptions in English. Project documentation also uses English, except `README.zh-CN.md` and `README.zh-TW.md`; preserve source-language examples, quoted UI labels, and historical evaluation evidence.

Use the applicable [issue form](.github/ISSUE_TEMPLATE/) or [PR template](.github/PULL_REQUEST_TEMPLATE.md) for GitHub UI, CLI, and API submissions. Preserve its fields and sections; for CLI/API issues, use form labels as body headings. Complete required fields, explain non-applicable items, and check only verified checklist items. Placeholders are prompts, not answers.

### Issue labels

The [label catalog](.github/labels.json) uses five core dimensions plus optional technical topics:

| Dimension | Labels and ownership |
| --- | --- |
| Type | At most one of `bug`, `enhancement`, `documentation`, `question` |
| Area | One primary `area:app-desktop`, `area:web`, `area:server`, `area:shared`, `area:build`, `area:docs`, or `area:cross-cutting`; maintainers may add more for cross-module work |
| Priority | At most one of `P0` (critical), `P1` (high), `P2` (normal), `P3` (low); assigned by maintainers |
| Status | `status:needs-info` or `status:blocked`, maintained manually; use Projects for progress and completion |
| Community | `good first issue` and `help wanted`, assigned by maintainers |
| Topic | Up to two relevant `topic:*` or `accessibility` labels, assigned by maintainers |

| Topic label | Scope |
| --- | --- |
| `topic:ai` | AI extraction, LangGraph, and model calls |
| `topic:parsing` | PDF, Office, table parsing, and source fidelity |
| `topic:practice` | Practice, exams, mistakes, and grading records |
| `topic:storage` | SQLite, PostgreSQL, persistence, and backups |
| `topic:performance` | Bottlenecks, caching, and resource use |
| `topic:security` | Security hardening; report vulnerabilities privately through [SECURITY.md](SECURITY.md) |
| `topic:testing` | Automated tests, regression coverage, and acceptance |
| `accessibility` | Accessibility, keyboard navigation, and touch usability; reuses the existing label |

Issue forms supply the Type label. Maintainers assign the remaining labels manually using the catalog above and update label definitions in GitHub when the catalog changes. No issue-labeling workflow synchronizes definitions or calls a model.

### Pull request labels

Maintainers label PRs manually using the same catalog. Labels do not authorize approval or merging. Issue and PR AI labeling bots have been removed; existing labels remain unchanged.

## Work from a fork

[Fork PractiQ](https://github.com/shenyankm/PractiQ/fork), then create a focused branch from the project's current `main`. Replace `YOUR_GITHUB_USERNAME` with your username:

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/PractiQ.git
cd PractiQ
git remote add upstream https://github.com/shenyankm/PractiQ.git
git fetch upstream
git switch -c fix/describe-the-change upstream/main
```

Keep `origin` as your fork's push target and use `upstream` to fetch project updates.

## Make the change

### Set up the affected components

App development requires macOS on Apple Silicon and Node.js 22.18+ within the
22.x line, or 24.11+. Python, Rust, PostgreSQL and RabbitMQ are not part of the
desktop install, development, test or package commands.

Run the relevant commands from the repository root:

| Task | Command |
| --- | --- |
| Install locked dependencies and Electron | `make install` or `make install-locked` |
| Start the desktop and embedded AI workers | `make dev` |
| Run UI and backend tests with coverage | `make test` |
| Verify contracts, types, lint, tests, release tooling and production build | `make verify` or `make app-check` |
| Build a fresh application and DMG | `make build` |

Model-substitute tests need no real model credentials or external services. The
remaining Python contract/reference checks in App CI use an existing Python
3.14+ interpreter and locked dependencies only while the old source is retained.
Their isolated bootstrap is in the workflow, not the desktop installation path.

### Respect component boundaries

| Area | Responsibility |
| --- | --- |
| `app/desktop/` | Electron main/preload, bounded background workers, SQLite practice/AI state, local files, LangGraph.js orchestration, checkpoints and Store. |
| `app/src/` | Sandboxed React renderer using the validated typed preload bridge. |
| `shared/` | Import workspace, rendering and theme code used inside the App; validate affected native and browser-harness flows. |
| `server/`, `app/src-tauri/` | Historical behavioral references pending final removal; no desktop runtime forwarding. Preserve local state and historical evidence. |

App packages contain no Python or LibreOffice runtime. Passive reads, polling,
export and backup must not start model work. Model calls run in embedded workers
after explicit actions; current credentials use macOS-protected encrypted local
storage and remain outside learning backups. Uncertain paid outcomes require
explicit recovery. There are no accounts, cloud sync or built-in billing.

Preserve review flags, immutable practice and score snapshots, resource checksums, and the database/backup compatibility and recovery rules in [AGENTS.md](AGENTS.md). Do not delete existing data or credentials to make a change work.

### Keep the diff focused

- Reuse existing code, components, and dependencies.
- Add a focused regression for each behavior change. Test observable behavior with current contracts and complete valid fixtures; rejection tests should change only the intended field and assert its error.
- Reset mocks and global stubs per test. Use events, fake time, or retrying assertions for asynchronous work. Keep UI behavior in component tests, layout/focus in Playwright, and persistence/recovery in native or service integration tests.
- Update affected documentation and contracts. Desktop frontend copy uses Simplified Chinese message keys with English and Traditional Chinese translations in `app/src/locales/en.ts` and `app/src/locales/zh-TW.ts`.
- Keep secrets, personal learning data, local databases, and generated build output out of Git. Never put API keys in SQLite, logs, fixtures, or backups.

Check new ignore rules with `git check-ignore -v --no-index <path>` and audit already tracked matches with `git ls-files -ci --exclude-standard`. Use `git rm --cached <path>` to stop tracking disposable output while keeping the local file. Keep referenced historical reports, fixtures, and curated evidence versioned; add a narrow `.gitignore` exception for an intentionally retained file instead of force-adding it. Removing a file in a new commit does not remove it from Git history; follow [SECURITY.md](SECURITY.md) if credentials were exposed.

The TypeScript desktop uses `shared/ai-contracts.json` as its authoritative JSON
Schema artifact. Run `node app/scripts/export-contracts.ts` when it changes and
commit all affected generated files:

- `app/src/contracts.generated.ts`

The exporter supports `--check` for parity verification. Do not edit generated
contracts by hand. During migration, also run the historical
`/path/to/python3.14 app/scripts/export-contracts.py --check` to verify parity with
the existing service models; changes must update both sides until that service
is removed. Frozen wire and grading baselines in `app/fixtures/` are intentionally
not regenerated; see their [provenance](app/fixtures/migration-reference.md).

## Validate the change

Choose checks for every affected area, from the repository root. Install the
locked dependencies first. Install Chromium as described in
[README.md](README.md#documentation-and-development) for browser checks.

| Change | Checks |
| --- | --- |
| Embedded AI, SQLite, storage and recovery | `npm --prefix app run test:desktop`: compiled-worker type checks, regression fixtures, process-kill recovery and required coverage |
| Practice app UI, including touch layouts | `npm --prefix app run check:ui` and `npm --prefix app run test:browser`: types, lint, coverage, and desktop/touch browser checks |
| App native commands | `make app-check` on macOS and affected native flows with `npm --prefix app run test:electron` |
| Document normalization | Focused PDF/image/Office worker and graph tests; oversized Office requires user-exported PDF. No local recognition fallback or LibreOffice discovery. |
| macOS resources or packaging | Focused package/release regressions and `make app-check`; on macOS run `make app-package-check`. |
| Locked dependencies | `make audit`: npm lockfile audit; verify production license inventory during packaging/staging |
| Documentation and contribution templates | Verify claims against source, local links and command syntax; parse changed YAML and check form fields and required inputs |

`make verify` and `make app-check` run the same Node checks, including frontend and
backend coverage, CI/release guards and the production renderer build. They do
not run Playwright, dependency audits or build an installer; run those separately
when affected. Backend coverage requires 90% statements/lines/functions and 85%
branches. Reports are retained even on test failure.

Native command changes also verify the committed
[IPC fixtures](app/docs/native-ipc-contracts.md), typed bridge, actual SQLite
worker and renderer consumers. Keep frozen compatibility baselines distinct
from generated types. Reports remain under ignored `app/.build/`, `coverage/`
and browser result directories. Use fresh package paths and retain first failures.

Record exact commands or manual flows, platform/environment, results, and evidence in the PR. Explain failed, unrun, and non-applicable checks. Keep local checks, remote CI, browser mocks, native acceptance, and live-model evaluation separate. Model substitutes do not establish extraction or grading accuracy; follow the [evaluation guide](server/docs/evaluation.md) for separately authorized live checks. Validate affected native interactions, credentials, and audio on the target OS, and report untested platforms.

CI selects work using [shared path rules](.github/scripts/ci-scope.ts):

| Changed paths | Heavy CI jobs |
| --- | --- |
| Executable code, contracts, fixtures, dependencies or unknown paths | Both workflows: UI/browser/release checks, embedded runtime coverage and macOS package checks |
| Release notes configuration or release template | App workflow |
| Any workflow YAML, shared CI actions, scope selector, rulesets, or dependency-update configuration | Both workflows; cross-check selectors and privileged workflow safeguards |
| Documentation, issue/PR templates, or label catalog | Skip heavy Service/App jobs; manually verify local links and command syntax, parse changed YAML/JSON, and check form fields and labels against the catalog |

Manual dispatch and release calls run all checks. The final `Service CI` and
`Desktop CI` names remain stable for branch protection; both always verify
deliberate skips and failures. The [Embedded AI](.github/workflows/server.yml)
and [App](.github/workflows/app.yml) workflows define commands and retained reports.

## Submit a pull request

Use Conventional Commits for commit messages and PR titles: `<type>(<scope>): <summary>`. Allowed types are `feat`, `fix`, `docs`, `refactor`, `test`, and `chore`; scope is optional. Use an imperative summary of at most 72 characters without a trailing period. Follow [AGENTS.md](AGENTS.md#commit-conventions).

After validation, commit the focused change and push your branch:

```bash
git push -u origin fix/describe-the-change
```

Open a PR to `shenyankm/PractiQ` with base `main`. Complete every template section with the problem, resulting behavior, affected areas, evidence, and risks. Use `Closes #123` only for a fully resolved issue; use `Related to #123` for partial work or `N/A` with a reason when no issue is required. Disclose AI assistance and how you reviewed and verified its output.

Before requesting review, inspect the full diff for unrelated changes, generated artifacts, secrets, and personal data. Include required generated contracts. All contributions require review before merge; a checked validation box or an explained failure does not replace successful applicable CI.

The [checked-in main ruleset](.github/main-ruleset.json) specifies current-head `Service CI` and `Desktop CI` checks and resolved review conversations, without requiring an up-to-date branch or an approving vote. Automatic review approval and withdrawal have been removed. A checked-in ruleset does not activate hosted settings; maintainers verify those separately under [repository security settings](docs/maintainers/dependency-security.md#repository-security-settings). A maintainer checks current-head Code Review and Security Review results, resolves findings, and merges manually after all required gates pass. Repository auto-merge is disabled.

## Release verification

Follow the [release policy](docs/maintainers/releases.md) and [release template](.github/RELEASE_TEMPLATE.md) for tags, synchronized versions, candidate identity, artifact attestations, and publication. The [Release draft workflow](.github/workflows/release.yml) creates only an unsigned draft; a draft, prerelease flag, or ordinary CI success is not release acceptance.

Record evidence for the final release candidate before publication:

- [ ] Confirm version, date, download URL, artifact hashes, OS/architecture, and signing/notarization status.
- [ ] Run embedded AI, app, browser, dependency, and final-package checks for that candidate.
- [ ] Verify installation, sample import, practice, submission, and backup restore on a clean target system.
- [ ] Capture embedded import/review and ZIP import/practice/score workflows against that same candidate.
- [ ] Record separately authorized live parsing/grading examples, failures, and consented user feedback.

Report macOS native checks separately from browser mocks. Historical reports and model substitutes do not establish clean-machine acceptance or live-model accuracy. Keep unchecked items explicit; grading requires a reference answer or rubric.

## Release quality and notice gates

Run `npm --prefix app run test:tooling` for release-tool regressions, and stage
the actual final installer with `node app/scripts/release.ts stage`. Use fresh
report/output paths, preserve first failures, and reject mixed package modes,
modified artifacts, wrong versions and retired runtimes. The Electron packager
and stager derive notices from the reviewed npm lockfile and compare embedded
license resources with source. See the [release policy](docs/maintainers/releases.md).

Verify Tencent recognition and Office/PDF guidance against the frozen embedded
implementation with retained hashes and explicit paid-call receipts. Package
success establishes no recognition-quality claim. Historical service archive
checks remain reference evidence; preserve local reports and task data when building.

## Report security issues privately

Follow [SECURITY.md](SECURITY.md) for private reporting and supported development versions. Keep credentials, personal data, and exploit details out of public issues.

New contributors can start with the [bounded fixture tasks and handover checklist](docs/maintainers/contributor-handover.md). Roles remain opt-in; task listings grant no repository or secret access. For consented feedback and sanitized results, follow the [trial protocol](docs/acceptance/desktop-user-trial.md); recruitment and participation require separate authorization.

### Embedded import checks

The import workspace lives in `shared/cloud/` and runs inside the App through the
typed embedded-worker bridge. Its component, coverage and browser checks are
part of the App checks above. Accounts, administration, plans, payments and
service-token fields are retired; do not restore them.
