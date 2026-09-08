# Contributing to PractiQ

Thanks for contributing to PractiQ.

## Before you start

Read [`AGENTS.md`](./AGENTS.md) for repository rules and service boundaries, and [`README.md`](./README.md) for setup and development instructions.

Open an issue before starting a feature, architecture change, new dependency, or cross-service change. Small, clearly scoped bug fixes and documentation corrections may go directly to a pull request.

Issue and pull request titles and descriptions must be written in English.

## Make changes

- Keep each pull request focused on one concern.
- Preserve the boundaries defined in `AGENTS.md`.
- Reuse existing code and dependencies before adding abstractions or packages.
- Add the smallest test that fails before a fix and passes after it.
- Update relevant documentation and `.env.example` when behavior, contracts, configuration, schema, or development commands change.
- Never commit secrets, personal data, production data, `.env.local`, or generated output.

## Validate changes

Run the checks for every area changed:

| Area | Command |
| --- | --- |
| `backend/` | `make backend-test` |
| `server/` | `make test-server` |
| `taro/` | `make test` |
| Multiple application layers | `make verify` |

Database changes must also be exercised against PostgreSQL and include rollout and rollback notes when existing data may be affected.

## Commit and open a pull request

Use focused [Conventional Commit](https://www.conventionalcommits.org/) subjects, for example `fix(server): reject oversized image payloads`.

The pull request description must include:

- The problem and chosen approach
- Affected application boundaries
- Commands run and their results
- Schema, configuration, security, or deployment impact
- A linked issue when applicable
- Screenshots or a recording for Mini Program UI changes

Before requesting review, remove unrelated and generated files, confirm required checks pass, and verify that no secrets or personal data appear in the diff or supporting material.

All changes require review before merge.

## Report security issues

Do not publish credentials, personal data, or working exploit details in a public issue. Use GitHub private vulnerability reporting when available, or contact a maintainer privately.
