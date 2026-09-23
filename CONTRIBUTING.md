# Contribute to PractiQ

Use this guide to prepare and validate a focused pull request. Read the [repository rules](AGENTS.md) for application boundaries and the [README](README.md) for setup.

## Choose a change

Open an issue before starting a feature, architecture change, new dependency, or public API change. Scoped bug fixes and documentation corrections may go directly to a pull request. Write issue and pull request titles and descriptions in English.

Issues must use the applicable [issue template](.github/ISSUE_TEMPLATE/), and pull requests must use the [pull request template](.github/PULL_REQUEST_TEMPLATE.md), whether submitted through the GitHub UI, CLI, or API. Preserve the template fields and sections; for CLI or API issues, use the form field labels as body headings. Complete required fields, explain non-applicable items, and mark checklist items complete only when verified.

When making changes:

- Preserve the boundaries and module conventions in `AGENTS.md`.
- Reuse existing code and dependencies before adding abstractions or packages.
- Add a focused regression test for behavior changes.
- Update documentation, contracts, and `.env.example` when the change affects them.
- Keep secrets, personal data, production data, and generated output out of Git.

## Check the affected code

Run commands from the repository root with an existing Python 3.14+ interpreter. Use `AI_PYTHON` to select it; do not create a project `.venv`. Install locked dependencies with `make install-locked AI_PYTHON=/path/to/python3.14`.

Choose checks for the affected area:

| Change | Checks |
| --- | --- |
| AI service | `make verify AI_PYTHON=/path/to/python3.14` |
| Locked dependencies | `make audit AI_PYTHON=/path/to/python3.14` (requires network access) |
| Service image | `make image-check` (requires Docker; does not publish) |
| Desktop | `make app-check AI_PYTHON=/path/to/python3.14` and `make app-package-check AI_PYTHON=/path/to/python3.14` on macOS |
| Documentation | Check claims against source, validate local links, and check command syntax |

`make test` runs the AI test suite during development. `make verify` checks the lockfile, lint, types, evaluation fixtures, tests with 90% coverage, recovery probes, and package builds. Tests use model substitutes; they do not establish extraction or grading accuracy. See the [evaluation guide](server/docs/evaluation.md) for separate live-model checks.

Run `make test-e2e AI_PYTHON=/path/to/python3.14` for the service HTTP workflows and native offline exam/backup workflow. These tests use temporary data directories and a loopback synthetic provider; they do not use configured API keys. Service checks cover upload, extraction, verified artifacts, review acceptance, grading, idempotency and restart persistence. The native workflow restores a backup into an empty installation and verifies scores, images and immutable history. These are service/native integration checks, not automated Tauri window or file-picker tests. They also run in the normal `make verify` and `make app-check` suites.

Coverage includes Python subprocesses. `make verify` erases previous coverage data and combines the current run before generating reports, including when tests fail. For manual coverage runs, run `coverage combine` before `coverage report`.

For desktop work, follow the [desktop build guide](app/README.md). `make app-check` checks shared Python/Rust contracts, TypeScript, frontend interactions, native integration tests, and Clippy. `make app-package-check` builds the macOS package and runs `app/scripts/check-bundle.py` against its bundled service. Use isolated application data for native UI acceptance.

The Keychain round-trip test uses and removes its own temporary credential. Run it explicitly on macOS:

```sh
cargo test --manifest-path app/src-tauri/Cargo.toml \
  native_keychain_roundtrip -- --ignored
```

Never put API keys in SQLite, logs, fixtures, or backups.

## Understand the CI coverage

Continuous integration (CI) runs service verification, dependency auditing, and image builds. It retains available service check reports from `server/reports/checks/` for 14 days, including after failures.

Desktop CI covers Windows source and contract checks, frontend builds and tests, Rust formatting, and Clippy. macOS also runs native storage and backup tests, builds the Python bundle, and checks the application package. These checks do not establish Windows runtime support or a signed macOS release.

Source checks override the Tauri resource list so a clean checkout needs no prebuilt Python bundle. Package builds require the bundle. Make resolves `AI_PYTHON` names through `PATH` before invoking uv, so CI can select its interpreter with `AI_PYTHON=python`.

## Submit a pull request

Use a focused [Conventional Commit](https://www.conventionalcommits.org/) subject, such as `fix(server): reject oversized image payloads`. Explain the problem and resulting behavior in the pull request description, including:

- Affected application boundaries
- Commands run and their results
- Schema, configuration, security, or deployment impact
- A linked issue when applicable
- AI assistance used to prepare the change, when applicable

Before requesting review, remove unrelated and generated files and inspect the diff for secrets or personal data. All changes require review before merge.

## Report security issues privately

Do not publish credentials, personal data, or working exploit details in a public issue. Use GitHub private vulnerability reporting when available, or contact a maintainer privately.
