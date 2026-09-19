# Contributing to PractiQ

Thanks for contributing to PractiQ.

## Before you start

Read [`AGENTS.md`](./AGENTS.md) for repository rules and service boundaries, and [`README.md`](./README.md) for setup and development instructions.

Open an issue before starting a feature, architecture change, new dependency, or public API change. Small, clearly scoped bug fixes and documentation corrections may go directly to a pull request.

Issue and pull request titles and descriptions must be written in English.

## Make changes

- Keep each pull request focused on one concern.
- Preserve the boundaries defined in `AGENTS.md`.
- Reuse existing code and dependencies before adding abstractions or packages.
- Add the smallest test that fails before a fix and passes after it.
- Update relevant documentation and `.env.example` when behavior, contracts, configuration, schema, or development commands change.
- Never commit secrets, personal data, production data, `.env.local`, or generated output.

## Validate changes

Run `make test` for the AI suite and `make verify` for lockfile, static, fixture, coverage, recovery-probe and package checks. Run `make audit` for locked dependency vulnerabilities (network required) and `make image-check` for the Docker build. CI uses these same three targets; no formatting gate is added. PDF rendering checks use the bundled PDFium library; no office converter is required. Available diagnostic reports in `server/reports/checks/` are retained by CI for 14 days, including after test failures. Set `AI_PYTHON` to an existing Python 3.14+ interpreter. Tests use fake models; real model quality requires a separate evaluation run.

For desktop changes, also run `make app-check AI_PYTHON=/path/to/python3.14` and `make app-build` on macOS. Desktop checks include shared Python/Rust contract fixtures, TypeScript, UI interactions, SQLite/backup integration tests and Clippy. Use isolated application data for native UI acceptance. The native Keychain round-trip test is opt-in (`cargo test --manifest-path app/src-tauri/Cargo.toml native_keychain_roundtrip -- --ignored`); it uses and removes its own temporary credential. Do not place API keys in SQLite, logs, fixtures or backups.

## Commit and open a pull request

Use focused [Conventional Commit](https://www.conventionalcommits.org/) subjects, for example `fix(server): reject oversized image payloads`.

The pull request description must include:

- The problem and chosen approach
- Affected application boundaries
- Commands run and their results
- Schema, configuration, security, or deployment impact
- A linked issue when applicable

Before requesting review, remove unrelated and generated files, confirm required checks pass, and verify that no secrets or personal data appear in the diff or supporting material.

All changes require review before merge.

## Report security issues

Do not publish credentials, personal data, or working exploit details in a public issue. Use GitHub private vulnerability reporting when available, or contact a maintainer privately.
