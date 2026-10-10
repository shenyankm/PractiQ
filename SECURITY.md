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

## Linux-only GLib lockfile advisory

`Cargo.lock` retains `glib` 0.18.5 through Tauri's GTK3/WebKitGTK dependencies.
[GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g)
affects this version; the official fixed line is `glib >= 0.20.0`, which is
incompatible with the currently locked GTK3 bindings. The upstream
[Wry update](https://github.com/tauri-apps/wry/pull/1843) and
[Tauri update](https://github.com/tauri-apps/tauri/pull/16170) are still pending
as of 2026-10-07.

PractiQ supports macOS, Windows and Android apps. Their locked dependency graphs
do not include `glib`; Linux app builds are rejected by the native build script.
`make audit-rust` retains the complete RustSec lockfile audit and then checks
both macOS architectures, Windows MSVC, Android arm64 and the x86_64 Android
emulator graph. The target check fails on reachable `glib`, missing app graphs
or Cargo errors. This evidence supports a Dependabot disposition of
**vulnerable code not used** for alert 1, rather than a claim that the locked
crate has been upgraded or patched. Reassess the disposition when changing
supported targets or Tauri dependencies; do not ship Linux app builds from an
older development snapshot.

The independent Python service may run on Linux and does not use this Rust GUI
dependency. The lockfile remains intact, with no advisory ignore or vendored
replacement.

The five supported target graphs and Linux build rejection were reverified on
2026-10-07. The complete `cargo audit` reports RUSTSEC-2024-0429 as an
informational `unsound` warning for the retained Linux-only crate. A successful
audit exit does not mean that GLib 0.18.5 has been patched. Alert 1 can be
classified as **vulnerable code not used** only while the supported-target and
build-rejection boundaries continue to hold.

## KaTeX renderer dependency consistency

The practice app and import Web frontend pin KaTeX 0.18.2, the fixed version for
[GHSA-238p-pmpm-9mq7](https://github.com/KaTeX/KaTeX/security/advisories/GHSA-238p-pmpm-9mq7).
Their npm overrides keep the direct CSS dependency, `rehype-katex` and
`micromark-extension-math` on that same version. Dependency updates must retain
the inherited-setting regression checks and ordinary formula rendering checks;
updating only the direct renderer can leave an affected nested dependency.

## Repository and deployment safeguards

GitHub Dependabot security updates, secret scanning and push protection are
enabled for this repository. [Dependabot configuration](.github/dependabot.yml)
also schedules weekly version updates for GitHub Actions, App/Web npm, Cargo
and the Android Gradle host. Actions retain a two-PR queue; each other manifest
has a one-PR queue. These limits apply to version updates, not security updates.
There is no automatic merge. Workflow Actions use full commit SHAs. Review
upstream changes and run the affected checks before merging dependency updates.

The maintainer reviews updater failures and uncovered dependencies at least
monthly during active maintenance and before each release. GitHub's
[supported ecosystem reference](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories)
currently documents uv 0.11; this repository pins uv 0.12.13. Until an updater
has been verified against this locked project, Python uses the manual route:
review runtime/dev pins, `[build-system].requires` and
`[tool.uv].build-constraint-dependencies` in `server/pyproject.toml`, update the
intended constraints together, regenerate `server/uv.lock` with the pinned uv
and Python 3.14+, then run `make install-locked`, `make verify` and `make audit`.
Do not substitute a pip updater that leaves `uv.lock` inconsistent. Record
retained pins or upstream blockers in the focused update PR.

App and Web npm updates must keep KaTeX and its nested renderers synchronized
across both manifests and lockfiles; extend a bot PR to both projects when
necessary. Both owning CI quality jobs run `npm audit --audit-level=high` with
failing exit status. Cargo updates retain the complete lockfile audit and all
supported-target graph checks described above. Gradle proposals still require
dependency-lock regeneration, wrapper checksum/provenance verification, exact
Android runtime notices and actual Android build/unit/instrumentation checks.
Review Gradle transitive dependencies manually: automatic security remediation
is limited without submitted dependency-graph data. Also review the pinned Rust,
Node, Java, uv, Android SDK/NDK and deployed Office toolchain versions manually;
these are not covered by the five version-update entries. A successful audit
today does not establish future cleanliness or replace notice/source review.

Android access tokens use Keystore-backed encryption and private no-backup storage; automatic Android backups are disabled. User-selected exports exclude credentials. The private credential/file-descriptor bridge rejects frontend invocation. See the [Android guide](app/docs/android.md) for native checks and supported targets.
Changing the independently deployed LibreOffice engine requires version, checksum, license and Office fidelity verification in that deployment. Desktop package checks must reject embedded Python and LibreOffice engines. Dependency auditing does not establish license
compliance; release notice inventories and their unresolved entries must also be
reviewed.
