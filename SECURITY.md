# Security policy

PractiQ is pre-release software. Security fixes target the current `main` branch;
older development snapshots are not maintained. There is no supported Stable
release or commitment to backport fixes to old data formats. Current schema and
backup boundaries are documented in [the data model](docs/question-model.md).

Report a suspected vulnerability privately through
[GitHub private vulnerability reporting](https://github.com/shenyankm/PractiQ/security/advisories/new).
If that entry is unavailable, request a private contact from the maintainer
without posting reproduction details publicly. Include the commit, platform,
affected component, expected/observed behavior and a minimal synthetic example.
Never include API keys, personal question banks or learning databases.

Maintainers triage impact and affected versions, agree on a coordinated disclosure
date with the reporter, add a focused regression, and publish remediation and
validation boundaries. No response-time guarantee is currently offered.

Before a release and at least monthly during active maintenance, run the Python,
npm and Cargo audits in [CONTRIBUTING.md](CONTRIBUTING.md). Review notices even
when a checker exits successfully. Evaluate compatible updates in focused pull
requests, regenerate lockfiles, and run the affected checks. Do not suppress an
advisory merely to pass CI. Record retained risks and upstream blockers.

GitHub Dependabot security updates, secret scanning and push protection are
enabled for this repository. [Dependabot configuration](.github/dependabot.yml)
also groups weekly GitHub Actions version updates; it does not automatically
merge them or update Python, npm or Cargo versions. Workflow Actions use full
commit SHAs. Review upstream changes and run the affected checks before merging
dependency updates.

The GLib patch has its own [provenance and removal criteria](app/src-tauri/vendor/glib/PRACTIQ-PATCH.md).
Changing the independently deployed LibreOffice engine requires version, checksum, license and Office fidelity verification in that deployment. Desktop package checks must reject embedded Python and LibreOffice engines. Dependency auditing does not establish license
compliance; release notice inventories and their unresolved entries must also be
reviewed.
