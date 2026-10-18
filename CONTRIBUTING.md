# Contribute to PractiQ

Use this guide to prepare a focused contribution. [README.md](README.md) covers setup and supported platforms; [AGENTS.md](AGENTS.md) defines architecture and coding rules; the [documentation index](docs/README.md) links to detailed guides.

Follow our [Code of Conduct](CODE_OF_CONDUCT.md) in all project community spaces.

## Choose a change

Search existing issues before opening a new one. Use the [issue chooser](https://github.com/shenyankm/PractiQ/issues/new/choose) for bug reports, feature requests, and usage questions. Report suspected vulnerabilities privately through [SECURITY.md](SECURITY.md).

Open an issue before starting a feature, architecture change, new dependency, or public API change. Explain the problem and intended outcome so the scope can be discussed. Focused bug fixes and documentation corrections may go directly to a pull request unless the proposed solution changes those boundaries.

Write issue and PR titles and descriptions in English. Project documentation also uses English, except `README.zh-CN.md`; preserve source-language examples, quoted UI labels, and historical evaluation evidence.

Use the applicable [issue form](.github/ISSUE_TEMPLATE/) or [PR template](.github/PULL_REQUEST_TEMPLATE.md) for GitHub UI, CLI, and API submissions. Preserve its fields and sections; for CLI/API issues, use form labels as body headings. Complete required fields, explain non-applicable items, and check only verified checklist items. Placeholders are prompts, not answers.

### Issue labels

The [label catalog](.github/labels.json) uses five core dimensions plus optional technical topics:

| Dimension | Labels and ownership |
| --- | --- |
| Type | At most one of `bug`, `enhancement`, `documentation`, `question` |
| Area | One primary `area:app-desktop`, `area:app-android`, `area:web`, `area:server`, `area:shared`, `area:build`, `area:docs`, or `area:cross-cutting`; maintainers may add more for cross-module work |
| Priority | At most one of `P0` (critical), `P1` (high), `P2` (normal), `P3` (low); AI proposes a missing priority and maintainers can correct it |
| Status | `status:needs-info` or `status:blocked`, maintained manually; use Projects for progress and completion |
| Community | `good first issue` and `help wanted`, assigned by maintainers |
| Topic | Up to two relevant `topic:*` or `accessibility` labels, suggested by AI while preserving existing topics |

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

The [Issue labels workflow](.github/workflows/issue-labels.yml) runs automatically only when an issue is first opened. It fills missing Type, Area, and Priority classifications, preserving existing labels and manual triage. Forms supply the Type label; CLI/API submissions can use `[Bug]:`, `[Feature]:`, `[Question]:`, or `[Docs]:` title prefixes, or the corresponding form's body headings. An exact selected option under `### Affected area`, `### Primary area`, or `### Related area` supplies Area. The configured AI fills gaps and assesses priority from reported impact, using `P2` for limited evidence. Ambiguous Type or Area may remain unclassified. Editing or reopening an issue does not trigger classification or additional model charges. Maintainers can adjust labels directly, or remove a dimension's label and manually rerun classification.

Catalog colors and descriptions synchronize after catalog, form, script, or workflow changes reach `main`. Maintainers can also run **Issue labels → Run workflow** on `main`: leave `number` empty to synchronize definitions, or supply one issue number to ask the AI again and fill missing labels. Synchronization does not delete or rename labels, relabel historical issues, or change Dependabot labels. Topic suggestions accompany classification; existing topics count toward the two-label limit, and existing excess topics are not removed. Topics supplement the primary Area.

The write job uses the dedicated `PractiQ Issue` environment's `API_KEY`, `BASE_URL`, and `MODEL` secrets, separately from the PR bot's environment. Set `MODEL` to `qwen3.7-flash` and `BASE_URL` to the corresponding HTTPS OpenAI-compatible base URL ending in `/compatible-mode/v1`; the script appends `/chat/completions` and disables Qwen thinking with `enable_thinking: false`. The job runs only on `main`; the environment can also restrict deployment branches to `main`. No provider SDK or third-party labeling action is installed. See GitHub's [issue-labeling guide](https://docs.github.com/en/actions/tutorials/manage-your-work/add-labels-to-issues).

Label operations use a dedicated private GitHub App, `practiq-issue-bot`, installed only on `shenyankm/PractiQ`. Grant it **Issues: Read and write** and the mandatory **Metadata: Read-only**, with no other permissions, webhooks, or user authorization callbacks. Store its client ID as the `APP_CLIENT_ID` environment variable and its PEM private key as the `APP_PRIVATE_KEY` environment secret in `PractiQ Issue`. The workflow reuses the pinned `actions/create-github-app-token` action to issue an installation token scoped to this repository and Issues write access, then revokes it when the job finishes. The default `GITHUB_TOKEN` has only `contents: read` for checkout; PR tests receive no App or model credentials. The App has no merge or repository-content write permissions. See [GitHub App authentication in Actions](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/making-authenticated-api-requests-with-a-github-app-in-a-github-actions-workflow).

The initial issue-open event makes at most one model request when Type, Area, or Priority is missing; supplying an issue number in a maintainer's manual dispatch also authorizes one request. The configured provider receives the title, up to 12,000 body characters, and classification labels. This also applies to public contributors' new issues, so provider charges may result; avoid private data in issues. Requests have a 60-second timeout and a 750-token output limit, no tools, no automatic retries, and strict validation against Type, Area, P0–P3, and the eight allowed topics. Errors leave missing labels unassigned and fail the workflow for maintainer inspection or explicit rerun. Uncertain classifications and failed requests cannot be retried by editing or reopening the issue. An initial event for an already complete classification and catalog-only synchronization make no model calls. Maintainer labels and issue text are checked again before adding labels. Disable **Issue labels** in Actions to stop automatic classification. The workflow must reach the default branch before issue events activate it. Validate changes with `node --test .github/scripts/issue-labeler.test.mjs` and actionlint.

### Pull request labels

New PRs targeting `main` use the same catalog, AI assessment and preservation
rules through `practiq-pr-bot`. The [PR labels workflow](.github/workflows/pr-labels.yml)
uses the PR title, description and at most 100 changed file paths; it never
executes PR code or sends source patches to the model. It runs only on initial
creation; edits, commits and reopening do not repeat paid work. Maintainers
can explicitly retry with **PR labels → Run workflow** on `main`, supplying a
PR number. Model suggestions only add missing labels and never authorize
approval or merging. See [setup, costs and trust boundaries](docs/maintainers/maintainer-agent.md#ai-pull-request-labels).

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

Install only what your change needs. App/Web development requires Node.js 22.12+. Service work, shared-contract generation, and package preparation use an existing Python 3.14+ interpreter and uv. Select it with `AI_PYTHON=/path/to/python3.14`; do not create a project `.venv`.

Run the relevant commands from the repository root:

| Area | Install and develop |
| --- | --- |
| Practice app — macOS | `make app-install`, then `make app-dev AI_PYTHON=/path/to/python3.14` |
| Practice app — Windows | Follow the [README PowerShell setup](README.md#run-the-desktop-app), starting with `npm --prefix app ci`; GNU Make is not a Windows prerequisite |
| Import Web | `make web-install`, then `make web-dev` |
| AI service | `make install-locked AI_PYTHON=/path/to/python3.14`; follow the [README service setup](README.md#run-the-ai-service-independently) for configuration and `make server-dev AI_PYTHON=/path/to/python3.14` |

See the [README prerequisites](README.md#run-the-desktop-app) for native toolchains and the [Android guide](app/docs/android.md) for Android development on any supported host. Service integration and recovery tests need Docker for disposable PostgreSQL/RabbitMQ instances; pure tests must not start Docker. Model-substitute tests need no real model credentials or running AI service.

Shared-contract checks need the locked service dependencies, even when the AI service itself is not being developed or started. On hosts with GNU Make, install them with `make install-locked AI_PYTHON=/path/to/python3.14`. App package preparation uses standard-library/local Python modules and does not require the AI-service environment.

### Respect component boundaries

| Area | Responsibility |
| --- | --- |
| `app/` | Offline Tauri/React practice app with Rust and SQLite, targeting macOS, Windows, and Android. Imports bank ZIPs and supports explicit service connection checks; only explicit AI grading or retry starts model work. |
| `web/` | Import frontend for explicit source-document submission, task control, result review, and bank ZIP download. |
| `server/` | Python/LangGraph document processing and grading, with PostgreSQL state, RabbitMQ delivery, and local file storage. |
| `shared/` | Frontend code used by both App and Web; validate both consumers when affected. |

App packages contain no Python or LibreOffice runtime. Passive reads, polling, export, and backup must not start model work. Provider credentials stay in the service environment; the service remains a personal self-hosted deployment without user management or built-in billing. Follow the [service recovery guide](server/docs/rabbitmq.md) when changing durable state or delivery.

Preserve review flags, immutable practice and score snapshots, resource checksums, and the database/backup compatibility and recovery rules in [AGENTS.md](AGENTS.md). Do not delete existing data or credentials to make a change work.

### Keep the diff focused

- Reuse existing code, components, and dependencies.
- Add a focused regression for each behavior change. Test observable behavior with current contracts and complete valid fixtures; rejection tests should change only the intended field and assert its error.
- Reset mocks and global stubs per test. Use events, fake time, or retrying assertions for asynchronous work. Keep UI behavior in component tests, layout/focus in Playwright, and persistence/recovery in native or service integration tests.
- Update affected documentation, contracts, and `.env.example`. Desktop frontend copy uses Simplified Chinese message keys with English translations in `app/src/locales/en.ts`.
- Keep secrets, personal learning data, local databases, and generated build output out of Git. Never put API keys in SQLite, logs, fixtures, or backups.

When shared AI contracts change, run `/path/to/python3.14 app/scripts/export-contracts.py` and commit all affected generated files:

- `app/src-tauri/contracts.json`
- `app/src/contracts.generated.ts`
- `web/src/contracts.generated.ts`
- `app/src-tauri/src/question_metadata.rs`

The exporter supports `--check` for parity verification. Do not edit generated contracts by hand.

## Validate the change

Choose checks for every affected area, from the repository root. Install the locked dependencies above first; append `AI_PYTHON=/path/to/python3.14` to Python-dependent Make commands. Install Chromium as described in [README.md](README.md#documentation-and-development) for browser checks.

| Change | Checks |
| --- | --- |
| AI service | `make verify`: lockfile, Ruff, Pyright, evaluation fixtures, tests with 90% coverage, PostgreSQL/RabbitMQ recovery probes, package build and archive source/lock integrity |
| Shared AI contracts | Regenerate all four files above; run `make verify`, `make web-check`, and the applicable app checks below |
| Import Web frontend | `make web-check web-build`: types, lint, coverage, fake-HTTP browser interactions, and static build |
| Practice app UI, including touch layouts | `npm --prefix app run check:ui` and `npm --prefix app run test:browser`: types, lint, coverage, and desktop/touch browser checks |
| App native commands, storage, or recovery | `make app-check` on macOS/Windows; actual Android build/tests in the [Android guide](app/docs/android.md). Verify affected native flows on the target OS |
| Service Office conversion | Focused Office/normalization tests and `make verify`; verify fidelity with the actual deployed engine separately using the [Office guide](server/docs/desktop-office.md) |
| macOS/Windows resources or packaging | Focused package/release regressions and `make app-check`; on macOS run `make app-package-check`. On Windows run `python app/scripts/check-installer.py --installer C:/path/to/final-installer.exe --output C:/path/to/fresh-package-report.json` with Python 3.14+ and 7-Zip |
| Android host, storage, or packaging | Shared contracts/frontend and touch-browser checks, actual APK package checks, Kotlin unit/instrumentation tests, and affected native flows in the [Android guide](app/docs/android.md) |
| Locked dependencies | `make audit` for Python; `make audit-rust` for Cargo; `npm --prefix app audit --audit-level=high` and/or `npm --prefix web audit --audit-level=high` for affected npm lockfiles. Follow the [dependency security guide](docs/maintainers/dependency-security.md) for pinned tools and other ecosystems |
| Service image | `make image-check` builds Web assets and the Docker image without publishing |
| Documentation and contribution templates | Verify claims against source, local links and command syntax; parse changed YAML and check form fields and required inputs |

`make app-check` verifies generated contracts, fixtures, frontend types/lint/unit tests, host Rust tests, formatting, and Clippy. It does not run Playwright or collect frontend coverage; use the separate UI/browser commands when relevant. Linux app builds are unsupported; Android development and Linux service/CI work follow their own documented checks.

`make verify` does not include dependency audits, Web checks, or an image build. Run those separately when affected. Service reports remain in `server/reports/checks/`, including on test failure. Use fresh report paths for package checks and retain first failures.

Before `make audit-rust`, install the `cargo-audit` version pinned in the [App workflow](.github/workflows/app.yml); the command audits the complete lockfile and verifies all supported target graphs. Follow the dependency security guide for retained advisory limits and manual toolchain updates.

Record exact commands or manual flows, platform/environment, results, and evidence in the PR. Explain failed, unrun, and non-applicable checks. Keep local checks, remote CI, browser mocks, native acceptance, and live-model evaluation separate. Model substitutes do not establish extraction or grading accuracy; follow the [evaluation guide](server/docs/evaluation.md) for separately authorized live checks. Validate affected native interactions, credentials, and audio on the target OS, and report untested platforms.

CI selects work using [shared path rules](server/scripts/ci_scope.py). Documentation paths skip heavy jobs; changes anywhere under `.github/`, including contribution templates, trigger all affected workflows. Manual full dispatch also runs all checks. The final `Service CI`, `Desktop CI`, and `Android CI` gates check deliberate skips and failures. The [Service](.github/workflows/server.yml) and [App](.github/workflows/app.yml) workflows define commands, platform matrices, and retained diagnostics.

## Submit a pull request

Use Conventional Commits for commit messages and PR titles: `<type>(<scope>): <summary>`. Allowed types are `feat`, `fix`, `docs`, `refactor`, `test`, and `chore`; scope is optional. Use an imperative summary of at most 72 characters without a trailing period. Follow [AGENTS.md](AGENTS.md#commit-conventions).

After validation, commit the focused change and push your branch:

```bash
git push -u origin fix/describe-the-change
```

Open a PR to `shenyankm/PractiQ` with base `main`. Complete every template section with the problem, resulting behavior, affected areas, evidence, and risks. Use `Closes #123` only for a fully resolved issue; use `Related to #123` for partial work or `N/A` with a reason when no issue is required. Disclose AI assistance and how you reviewed and verified its output.

Before requesting review, inspect the full diff for unrelated changes, generated artifacts, secrets, and personal data. Include required generated contracts. All contributions require review before merge; a checked validation box or an explained failure does not replace successful applicable CI.

The [checked-in main ruleset](.github/main-ruleset.json) specifies current-head `Service CI`, `Desktop CI`, and `Android CI` checks, resolved review conversations, and two valid approving reviews, without requiring an up-to-date branch. Stale approvals are dismissed on push. A checked-in ruleset does not activate hosted settings; maintainers verify those separately under [repository security settings](docs/maintainers/dependency-security.md#repository-security-settings). The optional [agent-bot workflow](docs/maintainers/maintainer-agent.md) has additional authorization and review-evidence conditions; it submits an approval after clean Codex connector evidence and CI, and never merges. GitHub native auto-merge must be enabled on each PR and waits for both approvals and all required gates.

## Release verification

Follow the [release policy](docs/maintainers/releases.md) and [release template](.github/RELEASE_TEMPLATE.md) for tags, synchronized versions, candidate identity, artifact attestations, and publication. The [Release draft workflow](.github/workflows/release.yml) creates only an unsigned draft; a draft, prerelease flag, or ordinary CI success is not release acceptance.

Record evidence for the final release candidate before publication:

- [ ] Confirm version, date, download URL, artifact hashes, OS/architecture, and signing/notarization status.
- [ ] Run the applicable service, app, browser, and final-package checks for that candidate.
- [ ] Verify installation, sample import, practice, submission, and backup restore on a clean target system.
- [ ] Capture Web import/review and App ZIP import/practice/score workflows, identifying their separate candidates.
- [ ] Record separately authorized live parsing/grading examples, failures, and consented user feedback.

Report macOS, Windows, and Android separately. Distinguish browser mocks, emulator tests, physical devices, and minimum Android/WebView versions. Historical reports and model substitutes do not establish clean-machine acceptance or live-model accuracy. Keep unchecked items explicit; grading requires a reference answer or rubric.

## Release quality and notice gates

Run `make app-license-check` against the prepared practice-only resources and repeat package/notice checks on the actual final installer. Use fresh report paths, preserve first failures, and reject mixed package modes, modified artifacts, wrong versions, and embedded Python/LibreOffice engines. See [supplemental notices](app/licenses/README.md).

Verify Office fidelity against the exact independently deployed engine with retained source/derived hashes. App package success establishes no conversion-quality claim. Service archive checks must match source modules and lockfile bytes; see [source archive verification](docs/history/engineering/service-packaging-20261009.md#source-archive-verification). Preserve local reports and task data when building.

## Report security issues privately

Follow [SECURITY.md](SECURITY.md) for private reporting and supported development versions. Keep credentials, personal data, and exploit details out of public issues.

New contributors can start with the [bounded fixture tasks and handover checklist](docs/maintainers/contributor-handover.md). Roles remain opt-in; task listings grant no repository or secret access. For consented feedback and sanitized results, follow the [trial protocol](docs/acceptance/desktop-user-trial.md); recruitment and participation require separate authorization.
