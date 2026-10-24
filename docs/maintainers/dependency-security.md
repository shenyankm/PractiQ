# Dependency security and deployment safeguards

Before a release and at least monthly during active maintenance, run the Python,
npm and Cargo audits in [CONTRIBUTING.md](../../CONTRIBUTING.md). Review notices even
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

The practice app and import Web frontend must use a consistent fixed KaTeX
version for
[GHSA-238p-pmpm-9mq7](https://github.com/KaTeX/KaTeX/security/advisories/GHSA-238p-pmpm-9mq7).
Both npm overrides use `$katex` to keep the direct CSS dependency,
`rehype-katex` and `micromark-extension-math` on the manifest version. Read the
current versions from the manifests and lockfiles instead of maintaining a
second version list here. Dependency updates must retain
the inherited-setting regression checks and ordinary formula rendering checks;
updating only the direct renderer can leave an affected nested dependency.

## October 2026 audit remediation

The App and Web lockfiles update Vitest and its coverage provider together to
5.0.5, `undici` to 8.12.3 and `zod` to 4.6.7. This addresses
GHSA-qxg6-89mg-rqv8, GHSA-xp26-3454-mjgp, GHSA-4qv8-2p9j-2685,
GHSA-f72v-6w45-q472, GHSA-xjj6-f33q-929c and GHSA-mrhx-c7xc-m3w5.
The service lockfile updates `filelock` to 4.2.4 and
`langgraph-checkpoint-postgres` to 3.1.3 (with its required checkpoint 4.3.0),
addressing CVE-2026-112940, CVE-2026-112913, CVE-2026-112907 and
CVE-2026-115883. Keep the existing failing audit thresholds; downstream CI gates
were failing because these audits failed, not because the gates needed relaxing.

## Repository and deployment safeguards

[Dependabot configuration](../../.github/dependabot.yml) schedules weekly GitHub
Actions, App/Web npm, Cargo, Android Gradle and Docker base-image updates.
Actions and the combined npm entry each allow two version-update PRs; Cargo,
Gradle and Docker each allow one. Version-update queue limits do not delay
security updates. The npm math-renderer group keeps related packages together;
other npm updates group by dependency name across `/app` and `/web` where their
constraints permit. This cross-directory grouping applies only to version
updates; extend security PRs to both projects when needed. See the
[GitHub options reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#groups).
Actions remain pinned to full commit SHAs and Docker bases retain digests.
Docker coverage is partial: GitHub documents that Dependabot may update only the
first `FROM` and does not support multi-stage builds. See the
[Docker limitations](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/manage-your-dependency-security/configure-private-registries#limitations-and-workarounds).
Before each release and at least monthly, manually review **all** image tags
and digests in `Dockerfile.server`: the `uv:python3.14-bookworm-slim` lock exporter,
the `rust:1.98.1-slim-bookworm` toolchain, the `python:3.15-bookworm`
dependency builder (including its C compiler, linker and development headers),
and the `python:3.15-slim-bookworm` production runtime. The dependency builder
uses the C toolchain already present in that digest; do not install floating apt
compiler packages in this stage. Update each selected digest
in a focused PR, run `make verify` and `make image-check`, and retain the build
and deployment checks for the resulting image. A builder-only Dependabot PR
does not establish that the deployed Python/OS image is current.
Dependency PRs require the same current-head CI and maintainer inspection of
Code Review and Security Review results; see [the contribution guide](../../CONTRIBUTING.md).

The maintainer reviews updater failures and uncovered dependencies at least
monthly during active maintenance and before each release. Python currently uses
a manual route: review runtime/dev pins, `[build-system].requires` and
`[tool.uv].build-constraint-dependencies` in `server/pyproject.toml`, update the
intended constraints together, regenerate `server/uv.lock` with the uv version
pinned in CI and Python 3.14+, then run `make install-locked`, `make verify` and
`make audit`. Verify updater support for that pinned uv version before adding
automatic Python version updates; see GitHub's
[supported ecosystem reference](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories).
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
these are not all covered by the configured version-update entries. A successful audit
today does not establish future cleanliness or replace notice/source review.

Android access tokens use Keystore-backed encryption and private no-backup storage; automatic Android backups are disabled. User-selected exports exclude credentials. The private credential/file-descriptor bridge rejects frontend invocation. See the [Android guide](../../app/docs/android.md) for native checks and supported targets.
Changing the independently deployed LibreOffice engine requires version, checksum, license and Office fidelity verification in that deployment. Desktop package checks must reject embedded Python and LibreOffice engines. Dependency auditing does not establish license
compliance; release notice inventories and their unresolved entries must also be
reviewed.

## Repository security settings

Read-only GitHub API verification on 2026-10-17 found Dependabot security
updates, secret scanning and push protection enabled, with no open Dependabot
or secret-scanning alerts returned. CodeQL default setup was `not-configured`;
the code-scanning alerts endpoint returned `no analysis found`, which does not
establish a clean scan. These are dated observations, not ongoing guarantees.

On 2026-10-23, the default CodeQL setup had completed analyses for Actions,
JavaScript/TypeScript, Python and Rust. Inspect each analysis and its commit;
a successful workflow does not mean that it reported no alerts. Keep dependency
audits: they check locked packages, while CodeQL checks source patterns.
No duplicate scanning workflow or query exclusions are needed.

### Code scanning triage

The 31 `actions/cache-poisoning/poisonable-step` findings shared the App workflow's
indirect `needs.changes.outputs.sha` checkout source. App jobs now use the event's
immutable `github.sha` or the reusable caller's explicit full commit SHA directly.
The same SHA remains a `changes` output for the final gate's metadata contract,
not as a checkout source. The initial job rejects mutable refs before checkout, and both always-running
gates require that job to succeed before checking out or executing source. The
release caller supplies its validated candidate SHA; a normal manual dispatch
has no alternate revision input. Keep the existing PR cache scope, permissions
and release-candidate checks. SHA syntax validation alone does not establish
that arbitrary code is trusted.

Rust alerts 32 and 33 (`rust/cleartext-transmission`, CodeQL 2.27.3) were reviewed
against the complete SARIF paths. The analysis propagates credential results
through tuple destructuring into the separate URL/configuration element. In
`settings.rs`, `grading_input_with` returns `(url, token)` and `model_input` returns
`(config, key)` without copying credentials into the first element. The reported
`ai.rs` URL-formatting expressions use only that validated URL. Credentials are
sent separately with `bearer_auth`, never inserted into the request target.

These two alerts are false positives under the current boundaries: service and
model URLs require HTTPS outside loopback, reject userinfo/query/fragment
credentials, and use a client with proxies and redirects disabled. Local HTTP
is intentionally limited to loopback. The settings URL regressions cover remote
IPv4/IPv6 and deceptive localhost suffixes; synthetic HTTP tests assert the exact
request line and the separate Bearer header. Reassess the disposition if these
validators, tuple contents, request construction or transport policies change;
do not disable the Rust rule.

The main ruleset requires `Service CI`, `Desktop CI`, `Android CI` and
resolved conversations, with no bypass actors. Native approving votes and
extra approval for unattributed changes are not required. Automatic review
approval and withdrawal have been removed. The checked-in
[ruleset](../../.github/main-ruleset.json) preserves the hosted merge-method
options (merge, squash and rebase) and does not require a PR branch to include
the latest main commit. Repository native auto-merge is disabled; maintainers
inspect current-head Code Review and Security Review results, resolve findings
and merge manually after CI passes.
Issue and PR labeling workflows have been removed; maintainers assign labels
manually. No labeling App permissions or private keys are required. Removing
the workflows does not uninstall existing Apps or delete stored credentials.

Before changing hosted settings, read the live rule, back it up and preserve
unrelated parameters in the update payload; a checked-in file alone does not
activate settings:

```bash
gh api repos/shenyankm/PractiQ/rulesets/24200305
gh api --method PUT repos/shenyankm/PractiQ/rulesets/24200305 --input /path/to/reviewed-ruleset-payload.json
gh api repos/shenyankm/PractiQ --jq .allow_auto_merge
```

The rules cover `main`, the repository's default PR target. Reviews on other
base branches do not inherit this main-only rule. Automated review results
remain evidence for maintainer inspection; they do not trigger an approval bot
or automatic merging.

The service image runs Python 3.15 on Bookworm; CI retains full service checks
on Python 3.14 and 3.15. Locked native dependencies must support 3.15 without
ABI compatibility overrides. The pinned Rust toolchain and C build tools live
only in the dependency build stage; the runtime receives the installed Python
packages. Python 3.15 reports retain the canonical service artifact names used
by release assembly, while 3.14 compatibility artifacts have a distinct suffix.
Both dependency and project builds explicitly consume constraints exported from
the service's build-system requirements and build-constraint dependencies,
including native build backends and their transitive tooling. Audit those pins
with `make audit`; do not resolve unconstrained PEP 517 tooling in image stages.
