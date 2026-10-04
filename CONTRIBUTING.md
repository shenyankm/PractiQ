# Contribute to PractiQ

Use this guide to prepare a focused change to the offline desktop app or its AI service. Follow [AGENTS.md](AGENTS.md) for architecture and coding rules, and [README.md](README.md) for setup and platform-specific commands.

## Choose a change

Open an issue before starting a feature, architecture change, new dependency, or public API change. Scoped bug fixes and documentation corrections may go directly to a pull request.

Write issue and pull request titles and descriptions in English. Use the applicable [issue template](.github/ISSUE_TEMPLATE/) and [pull request template](.github/PULL_REQUEST_TEMPLATE.md), including submissions through the CLI or API. Preserve all fields and sections; use issue form labels as body headings for CLI or API submissions. Complete required fields, explain non-applicable items, and only mark verified checklist items complete.

## Work from a fork

[Fork PractiQ](https://github.com/shenyankm/PractiQ/fork), then clone your fork and create a branch. Replace `your_github_username` with your GitHub username:

```bash
git clone https://github.com/your_github_username/PractiQ.git
cd PractiQ
git switch -c fix-your-change
```

## Make the change

Keep each change focused:

- Reuse existing code, components, and dependencies.
- Add a focused regression test for each behavior change.
- Test observable behavior with current contracts and complete valid fixtures. Change only the intended field in rejection tests, and assert the corresponding error. Reset mocks and global stubs per test; use events, fake time, or retrying assertions for asynchronous work. Keep UI behavior in component tests, layout and browser focus in Playwright, and persistence/recovery boundaries in native or service integration tests.
- Update affected documentation, contracts, and `.env.example`.
- Write project documentation in English, except `README.zh-CN.md`. Preserve source-language examples, quoted UI labels, and archived evaluation evidence.
- For desktop frontend copy, use Simplified Chinese message keys and add English translations to `app/src/locales/en.ts`.
- Keep secrets, personal data, local databases, and generated build output out of Git. Never put API keys in SQLite, logs, fixtures, or backups.

Commit tracked generated contracts when their source changes. Regenerate them with your Python 3.14+ interpreter using `app/scripts/export-contracts.py`; CI checks that they match the shared contracts.

## Validate the change

Run checks from the repository root. For frontend changes, install locked npm dependencies with `make app-install` or `make web-install` for the affected frontend. For Python-dependent checks, use an existing Python 3.14+ interpreter, select it with `AI_PYTHON=/path/to/python3.14`, and do not create a project `.venv`. Install locked service dependencies with `make install-locked AI_PYTHON=/path/to/python3.14`; the desktop build uses that interpreter only to prepare metadata and notices, without embedding a Python runtime. See [README.md](README.md) for target-platform prerequisites.

Choose checks for every affected area; append `AI_PYTHON=/path/to/python3.14` to Python-dependent Make commands:

| Change | Checks |
| --- | --- |
| AI service | `make verify` (lockfile, lint, types, fixtures, tests with 90% coverage, recovery probes, package build) |
| Shared AI contracts | `make verify`, `make app-check` and `make web-check`; regenerate both tracked frontend contracts before checking |
| Import Web frontend | `make web-install web-check web-build`; browser checks use an authenticated fake HTTP service and no real models |
| Desktop UI | `npm --prefix app run check:ui` (types, lint, coverage) and `npm --prefix app run test:browser`; see [README.md](README.md) for Chromium setup |
| Desktop native commands, storage, or recovery | `make app-check` and affected native flows on the target OS |
| Service Office conversion | Focused Office/normalization tests and `make verify`; verify fidelity with the actual deployed engine separately |
| Desktop resources or packaging | Focused desktop package/release regressions, `make app-check` and `make app-package-check`; final installers must contain no Python/LibreOffice runtime |
| Locked dependencies | Run the affected ecosystem's audit: `make audit` for Python runtime and dev dependencies; `make audit-rust` for Cargo.lock; `npm --prefix app audit --audit-level=high` and/or `npm --prefix web audit --audit-level=high` for the affected npm lockfiles (network required) |
| Service image | `make image-check` (Docker required; does not publish) |
| Documentation | Verify claims against source, local links, and command syntax |

Install the CI-pinned [RustSec checker](https://github.com/RustSec/rustsec/releases/tag/cargo-audit/v0.22.2) with `cargo install cargo-audit --locked --version 0.22.2 --registry crates-io` before running `make audit-rust`. It checks the complete lockfile once in Linux CI, including dependencies used on other target platforms. Advisory failures block that job; audit commands do not update project dependencies.

CI starts on every pull request, push to `main`, and manual dispatch. A lightweight job selects the relevant work using [the shared path rules](server/scripts/ci_scope.py). Documentation-only changes skip heavy jobs; workflow changes and manual dispatch run all checks. The final `Service CI` and `Desktop CI` jobs always run and reject failed, cancelled, or unexpected skipped dependencies. Use these unique names for required merge checks.

Desktop CI runs frontend types, lint, coverage, browser checks, contracts, fixtures, release-check regressions and dependency audits once on Ubuntu, then gates a Windows/Linux/macOS package matrix. Every platform retains Rust tests, Clippy, native package version/notices checks and rejection of embedded Python/LibreOffice engines; Windows and Linux also retain native credential round-trips. Rust is pinned in `rust-toolchain.toml`; the macOS runner is explicitly `macos-15`. Browser checks use mocked native commands.

PRs that affect desktop inputs build and validate installers but upload only coverage, browser diagnostics, and package diagnostics (7 days). Main/manual runs additionally upload installers (14 days); browser and package diagnostics upload even after failure. Service CI also checks and builds the separate Web frontend, then runs full service verification, audit and image build. Its inputs include desktop fixtures, the rich-content checker consumed by service tests, and Docker context configuration. Desktop inputs include `.gitattributes` and license texts used in package checks.

Actions are pinned to full commit SHAs and [Dependabot](.github/dependabot.yml) proposes grouped weekly Action updates. Review the upstream commit and rerun CI before accepting an update. Maintainers can apply [the main-branch ruleset](.github/main-ruleset.json) after these workflows are merged into `main` and both final checks have succeeded on GitHub. It requires a pull request, resolved review conversations, and checks against the current base; it blocks deletion and force pushes. It does not require a second maintainer's approval.

Automated checks use model substitutes; they do not establish extraction or grading accuracy. See the [evaluation guide](server/docs/evaluation.md) for live-model checks. Browser checks mock native commands. Validate affected native interactions, credential storage, and audio playback on the target OS using isolated test data. Report untested platforms and flows in the pull request.

## Release verification

Follow [the release policy](docs/releases.md) for tags, version synchronization,
public assets and final-package evidence. The manually dispatched
[Release draft workflow](.github/workflows/release.yml) reuses full CI at one
candidate commit and creates only an unsigned draft after strict package gates.
It explicitly reads [the release template](.github/RELEASE_TEMPLATE.md); complete
the remaining manual/live/signing evidence before publication. Do not treat a
draft, prerelease flag or ordinary CI success as release acceptance.

Record evidence for the final release candidate before publication:

- [ ] Confirm the version, date, download URL, and signing/notarization status.
- [ ] Run the service, desktop, browser, and package checks listed above for that candidate.
- [ ] Verify installation, sample import, practice, submission, and backup restore on a clean target system.
- [ ] Capture the Web import/review and desktop ZIP import/practice/score workflows, identifying their separate candidates.
- [ ] Record live-model parsing and grading examples, failures, and consented user feedback.

Report validation separately for macOS, Windows, and Linux. CI, model substitutes, hand-written samples, and historical reports do not establish clean-machine acceptance or live-model accuracy. Keep unchecked items explicit; AI grading remains a personal-practice aid and requires a reference answer or rubric.

## Submit a pull request

Use Conventional Commits for commit messages and pull request titles, following [AGENTS.md](AGENTS.md#commit-conventions), for example `fix(server): reject oversized image payloads`.

After validation, commit your focused change and push the branch to your fork:

```bash
git push -u origin fix-your-change
```

Open a pull request from your fork's branch to `shenyankm/PractiQ` with base branch `main`. Complete the template with the problem, resulting behavior, linked issue when applicable, checks and results, and migration, configuration, or security impact. Disclose AI assistance when used. Before requesting review, inspect the diff for unrelated changes, generated build artifacts, secrets, and personal data. Include required tracked generated contracts. All changes require review before merge.

## Release quality and notice gates

Run `make app-license-check` against the practice-only resources, and repeat package and notice checks against the actual final installer. Use fresh report paths and preserve first failures. Source/installer checks must reject mixed package modes, modified artifacts, wrong versions and embedded engines. See [supplemental notices](app/licenses/README.md).

Office fidelity belongs to the independently deployed service. Verify its exact engine and retained source/derived hashes separately using the [Office guide](server/docs/desktop-office.md); ordinary desktop package success establishes no document-conversion quality.

Record the candidate commit, artifact hashes, OS/architecture and exact commands. Do not label a local development package as signed or accepted on a clean machine. Require live extraction/grading, failure-injection and platform manual checks separately; historical desktop-bundled-service reports remain historical.

## Report security issues privately

Follow [SECURITY.md](SECURITY.md) for supported development versions, private reporting and the dependency-update process. Do not include credentials, personal data or exploit details in public issues.

New contributors can start with the [bounded fixture tasks and handover checklist](docs/contributor-handover.md). Roles remain opt-in; no repository or secret access is granted by a task listing.

For opt-in feedback collection and sanitized result reporting, follow the [desktop trial protocol](docs/desktop-user-trial.md). Recruitment and participation remain separately authorized.
