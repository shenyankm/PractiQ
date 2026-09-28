# Contribute to PractiQ

Use this guide to prepare a focused change to the offline desktop app or its AI service. Follow [AGENTS.md](AGENTS.md) for architecture and coding rules, and [README.md](README.md) for setup and platform-specific commands.

## Choose a change

Open an issue before starting a feature, architecture change, new dependency, or public API change. Scoped bug fixes and documentation corrections may go directly to a pull request.

Write issue and pull request titles and descriptions in English. Use the applicable [issue template](.github/ISSUE_TEMPLATE/) and [pull request template](.github/PULL_REQUEST_TEMPLATE.md), including submissions through the CLI or API. Preserve all fields and sections; use issue form labels as body headings for CLI or API submissions. Complete required fields, explain non-applicable items, and only mark verified checklist items complete.

## Make the change

Keep each change focused:

- Reuse existing code, components, and dependencies.
- Add a focused regression test for each behavior change.
- Update affected documentation, contracts, and `.env.example`.
- Write project documentation in English, except `README.zh-CN.md`. Preserve source-language examples, quoted UI labels, and archived evaluation evidence.
- For frontend copy, use Simplified Chinese message keys and add English translations to `app/src/locales/en.ts`.
- Keep secrets, personal data, local databases, and generated build output out of Git. Never put API keys in SQLite, logs, fixtures, or backups.

## Validate the change

Run checks from the repository root. Use an existing Python 3.14+ interpreter, select it with `AI_PYTHON=/path/to/python3.14`, and do not create a project `.venv`. Install locked dependencies with `make install-locked AI_PYTHON=/path/to/python3.14` and `make app-install` as needed.

Choose checks for the affected area; append `AI_PYTHON=/path/to/python3.14` to Python-dependent Make commands:

| Change | Checks |
| --- | --- |
| AI service | `make verify` (lockfile, lint, types, fixtures, tests with 90% coverage, recovery probes, package build) |
| Locked dependencies | `make audit` for Python runtime, dev, and desktop extras; `make audit-rust` for Cargo.lock; `npm --prefix app audit --audit-level=high` for npm (network required) |
| Service image | `make image-check` (Docker required; does not publish) |
| Desktop | `make app-check` and `make app-package-check` on macOS or Linux; see the [desktop CI workflow](.github/workflows/desktop.yml) for Windows checks |
| Desktop UI | Also run `npm --prefix app run test:browser`; see [README.md](README.md) for Chromium setup |
| Documentation | Verify claims against source, local links, and command syntax |

Install the CI-pinned [RustSec checker](https://github.com/RustSec/rustsec/releases/tag/cargo-audit/v0.22.2) with `cargo install cargo-audit --locked --version 0.22.2 --registry crates-io` before running `make audit-rust`. It checks the complete lockfile once in Linux CI, including dependencies used on other target platforms. Advisory failures block that job; audit commands do not update project dependencies.

Automated checks use model substitutes; they do not establish extraction or grading accuracy. See the [evaluation guide](server/docs/evaluation.md) for live-model checks. Browser checks mock native commands. Validate affected native interactions, credential storage, and audio playback on the target OS using isolated test data. Report untested platforms and flows in the pull request.

## Submit a pull request

Use Conventional Commits for commit messages and pull request titles, following [AGENTS.md](AGENTS.md#commit-conventions), for example `fix(server): reject oversized image payloads`.

Complete the pull request template with the problem, resulting behavior, linked issue when applicable, checks and results, and migration, configuration, or security impact. Disclose AI assistance when used. Before requesting review, inspect the diff for unrelated changes, generated files, secrets, and personal data. All changes require review before merge.

## Report security issues privately

Do not include credentials, personal data, or working exploit details in public issues. Use GitHub private vulnerability reporting when available, or contact a maintainer privately.
