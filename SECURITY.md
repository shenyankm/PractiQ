# Security policy

PractiQ is pre-release software. Security fixes target the current `main` branch;
older development snapshots are not maintained. There is no supported Stable
release or commitment to backport fixes to old data formats. Current schema and
backup boundaries are documented in [the data model](docs/reference/question-model.md).

Report a suspected vulnerability privately through
[GitHub private vulnerability reporting](https://github.com/shenyankm/PractiQ/security/advisories/new).
If that entry is unavailable, request a private contact from the maintainer
without posting reproduction details publicly. Include the commit, platform,
affected component, expected/observed behavior and a minimal synthetic example.
Never include API keys, personal question banks or learning databases.

Maintainers triage impact and affected versions, agree on a coordinated disclosure
date with the reporter, add a focused regression, and publish remediation and
validation boundaries. No response-time guarantee is currently offered.

Dependency audits, retained advisory evidence, updater coverage and deployment
safeguards are maintained in [the dependency security guide](docs/maintainers/dependency-security.md).
Run those checks before a release and at least monthly during active maintenance.
