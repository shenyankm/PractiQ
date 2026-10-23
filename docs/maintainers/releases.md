# Release policy

PractiQ releases deliver the offline practice application for macOS, Windows
and Android. AI source import, Office conversion and parsing run in the independently deployed service
and its web frontend. Explicit client grading calls that service over HTTP.
The service keeps its own source version; record it separately without claiming
it is deployed by a client installer. Linux remains an independent-service and
CI host, not a client release target. Do not publish separate platform tags,
server wheels, container images or updater assets without a supported delivery
workflow. Actions artifacts expire and are not public releases.

## Versions and tags

Use `vX.Y.Z`, or `vX.Y.Z-alpha.N`, `-beta.N`, `-rc.N`; numbers have no leading
zeroes. The title is `PractiQ <tag>`. Development starts at `0.1.0`; patches fix
compatible behavior, minor releases add features or change data compatibility
during `0.x`. Define stable compatibility before `1.0.0`. Disclose incompatible
JSON, database or backup changes even during development. See [SemVer](https://semver.org/).

Before tagging, synchronize `app/package.json`, both version entries in
`app/package-lock.json`, `app/src-tauri/Cargo.toml`, its package entry in
`Cargo.lock`, and `tauri.conf.json` to the complete version without `v`.
The explicitly merged `app/src-tauri/Info.plist` keeps that full identity in
`PractiQVersion`; `CFBundleShortVersionString` and `CFBundleVersion` use the
three-integer core (for example, `0.2.0-beta.1` maps to `0.2.0`). The final macOS
package gate checks all three fields, so two betas with the same numeric core
cannot substitute for each other. Native version fields alone do not order beta
updates; no automatic updater is shipped. The AI
service version is independent. Native installer metadata may normalize
prerelease syntax; document that mapping rather than changing the product tag.
Keep the full version in the application and asset names.

Use the existing Python 3.14+ interpreter to update all six client entries and the macOS plist without
resolving dependencies or changing the independent service version:

```sh
"$AI_PYTHON" app/scripts/bump-version.py 0.2.0-alpha.1
git diff -- app/package.json app/package-lock.json app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock app/src-tauri/tauri.conf.json app/src-tauri/Info.plist
```

The updater rejects noncanonical versions, inconsistent current versions and
unsupported TOML layouts before writing. Review and commit the diff; this command
does not commit, create a tag or run release acceptance. Version `0.2.0-alpha.1`
is an example for a future test candidate, not a selected or published release.

Create an annotated tag on a clean, committed candidate already on `main`:

```sh
# Example only: update and commit the matching versions before these commands.
git tag -a v0.1.0-alpha.1 <candidate-sha> -m 'PractiQ v0.1.0-alpha.1'
git push origin refs/tags/v0.1.0-alpha.1
```

Tagging/pushing and publication require maintainer intent; building alone does
not authorize them. Never move a published tag or replace its assets. Corrections
need a new version. Mark suffix versions as **Pre-release**; use **Latest** only
for an accepted ordinary release. A draft is preparation, not acceptance.

## Repository protection setup

After reviewing and merging these policies, an administrator can apply both
checked-in tag rulesets through Settings → Rules → Rulesets, or explicitly:

```sh
gh api --method POST repos/shenyankm/PractiQ/rulesets --input .github/release-tag-creation-ruleset.json
gh api --method POST repos/shenyankm/PractiQ/rulesets --input .github/release-tag-immutability-ruleset.json
gh api repos/shenyankm/PractiQ/rulesets
```

Inspect existing rulesets first; update an existing policy by its ID rather than
creating duplicates. Both target `refs/tags/v*`. The creation policy allows only
repository administrators (RepositoryRole 5) to bypass creation restrictions.
The separate immutability policy forbids updates and deletions with no bypass
actors, including administrators. Keep these policies separate so permission to
create a candidate never permits silently moving or deleting it. Review any
future change to eligible creators explicitly. Rulesets alone do not enforce
SemVer, annotated tags or main ancestry; candidate checks enforce those.

Enable **Settings → General → Releases → Enable release immutability** before
publication and verify the resulting published Release is immutable. Checked-in
JSON and a merged PR do not activate repository settings; record the actual
ruleset IDs/enforcement and immutability setting separately. Public settings
changes, tagging and publication remain explicit maintainer operations.

## Assets

| Target | Minimum system | Public filename |
| --- | --- | --- |
| macOS arm64 | macOS 14+ | `PractiQ_<version>_macos_arm64.dmg` |
| Windows x64 | Windows 10/11 with WebView2 | `PractiQ_<version>_windows_x64_setup.exe` |
| Android arm64 | Android 8.0 / API 26+; system WebView | `PractiQ_<version>_android_arm64.apk` |

These are the current client release targets. Android x86_64 builds are for
emulator diagnostics only and must not enter release assembly. A macOS application ZIP is optional;
if supplied, preserve symlinks with `ditto` and verify the final archive too.
Do not add MSI, AAB, Linux client packages or more architectures before their package checks.

Every installer includes only client code, build metadata with `schemaVersion: 2`,
`packageMode: desktop-practice`, and source-bound Cargo/npm notices, plus Maven
notices on Android. The existing `desktopVersion` field also identifies the
Android application version; these internal names remain unchanged. The desktop
resource whitelist contains `bundled/build-manifest.json` and
`bundled/THIRD-PARTY.txt`; the APK contains exactly those two resources under
`assets/bundled/`.
Python, LibreOffice and AI workers must be absent from the whole application.
The selected application must contain a bounded Mach-O executable with an actual
arm64 slice on macOS, an x64 PE32+ executable on Windows, or the checked ELF64
shared library for the APK's selected ABI. Version labels and container CPU
labels alone cannot establish this identity. Header checks do not prove startup,
full binary loadability, signing or device compatibility.
Existing ignored engine caches and historical packages remain untouched and
must never enter a new client installer. Record Windows WebView2 and Android
system WebView requirements with the final platform evidence. The APK's minSdk
metadata does not establish minimum Android or minimum WebView runtime acceptance.

Attach `release-manifest.json`, `release-evidence.zip` and `SHA256SUMS.txt`.
The manifest binds source commit, tag, exact component versions, OS/architecture,
file size/hash, build URL, signing and acceptance status. Reuse each platform's
`build-manifest.json`. Evidence contains final-package reports and notices;
include separately reviewed live-model and manual reports before publication.
Only consented, sanitized evidence is public: no credentials, personal databases,
backups or raw user documents. GitHub's automatic source archives are not installers.

Calculate hashes after signing, notarization, stapling and final packaging.
`SHA256SUMS.txt` covers every other public asset; it does not hash itself or the
release description. SHA-256 detects content changes; it is not a publisher signature.

## Draft workflow

Merge the release workflow and matching versions before creating the candidate
tag. Run **Release draft** from Actions using that candidate tag as the workflow
ref and entering the same existing tag, or:

```sh
gh workflow run release.yml --ref v0.1.0-alpha.1 -f tag=v0.1.0-alpha.1
```

The workflow validates versions, an annotated tag, the tag's commit, clean source
and ancestry on `main`. It rejects a workflow ref other than the selected tag or
a workflow source SHA different from the candidate checkout. This binds the
Actions OIDC source identity to the candidate rather than a later main commit.
The candidate must already include this workflow version. It reuses Service and
Desktop CI at that exact commit, forces full checks
regardless of changed paths, and gates macOS arm64, Windows x64 and Android arm64
assets. From a private read-only installer snapshot it mounts the final macOS
DMG, safely extracts the NSIS payload, or inspects the APK archive and binary
manifest using an explicitly selected Android SDK `aapt2`. It checks actual
application version, engine absence, native executable or ELF ABI, build metadata
and source-bound license inventories. The generated notices must match the embedded file byte for
byte. Windows extraction uses full 7-Zip; APK inspection requires no installation
or native-library execution. Any failure blocks release asset staging and draft creation; failure
diagnostics remain in Actions. Prerelease status never bypasses these gates.

Assembly rejects missing platforms, mismatched commits/versions, altered
installers or missing/failed package evidence. It bundles service reports,
generates checksums, and fills [the release template](../../.github/RELEASE_TEMPLATE.md).
GitHub's [generated release notes](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes)
provide a merged-PR summary using [.github/release.yml](../../.github/release.yml):
enhancements, fixes and other changes. The first release covers the repository's
initial history; later summaries use GitHub's previous-release comparison.
Maintainers review this draft, curate user-visible highlights and record published
versions in [CHANGELOG.md](../../CHANGELOG.md). Automatic summaries do not complete
manual compatibility, signing or acceptance sections and do not publish a Release.
The template is project-owned; GitHub does not load this filename automatically.
The workflow verifies the remote tag again, creates only a draft and never
updates an existing release, publishes, or marks a draft Latest. Retry failed
pre-draft runs; an existing draft is deliberately rejected to avoid replacing
reviewed assets silently. Review or discard that draft explicitly before retrying.

### Actions provenance

After assembly, the pinned [actions/attest](https://github.com/actions/attest)
action attests all three installers, the manifest, evidence ZIP and checksums.
Only the draft job receives `id-token: write` and `attestations: write`.
Before draft creation, `gh attestation verify` checks every attachment using the
generated bundle, repository, release workflow, candidate tag and exact source SHA;
self-hosted runner attestations are rejected. Any attestation or verification
failure blocks draft creation. Attestations remain available through GitHub's API.

Reverify each downloaded, unchanged CI draft attachment before publication:

```sh
TAG=v0.2.0-alpha.1
CANDIDATE_SHA=$(git -C /path/to/candidate-checkout rev-parse "refs/tags/$TAG^{commit}")
for asset in PractiQ_* SHA256SUMS.txt release-manifest.json release-evidence.zip; do
  gh attestation verify "$asset" --repo shenyankm/PractiQ \
    --signer-workflow shenyankm/PractiQ/.github/workflows/release.yml \
    --source-ref "refs/tags/$TAG" --source-digest "$CANDIDATE_SHA" --deny-self-hosted-runners
done
```

Run this in a fresh directory containing only the downloaded candidate assets,
using a GitHub CLI with the documented attestation verification flags. SHA-256
still checks downloaded bytes; [attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
authenticate the Actions assembly identity and its source, not OS publisher
signing or clean-machine/live-model acceptance. This is an assembly attestation;
it does not independently attest each native compiler invocation. Build and
package evidence remains bound in the manifest and ZIP from the same run.
Signing, stapling or restaging changes bytes and invalidates the original proof
for changed attachments. Preserve original CI provenance and independently review
the final-byte signing/acceptance handoff; never claim original CI attestations
cover replacement files. No automated final signing or public Publish workflow
is added while [#91](https://github.com/shenyankm/PractiQ/issues/91) remains pending.

CI currently has no publisher signing credentials. Desktop candidates state
**unsigned**. The Android CI debug/test APK is not a publisher-verified release:
record its debug signing separately and leave publisher verification
**unverified**. All candidates retain **clean-machine acceptance pending** and
**live-model acceptance pending**. An API 35 emulator run is diagnostic evidence;
it does not establish physical-device, API 26, minimum WebView or production
acceptance. An ordinary-version draft is not Stable.
Do not publish it as Stable until signed final assets and acceptance evidence
replace the development candidates and all hashes/statuses have been regenerated.

## Final signing and acceptance

On macOS, use the existing Developer ID and notarytool Keychain profile:

```sh
mkdir -p app/.build/signed
APPLE_SIGNING_IDENTITY='Developer ID Application: ...' \
APPLE_NOTARY_PROFILE='practiq-release' \
bash app/scripts/sign-release.sh \
  app/src-tauri/target/release/bundle/macos/PractiQ.app \
  app/.build/signed/PractiQ_0.1.0-alpha.1_macos_arm64.dmg
```

The optional fresh DMG path rebuilds the image from the signed and stapled app,
then signs, notarizes and staples the DMG. The earlier development DMG still
contains its original app and must not be relabeled as signed. On Windows,
sign the application and final NSIS installer with the maintainer's publisher
certificate and verify both; signing is not configured by this workflow.
On Android, use the maintainer's release signing identity and retain the Android
SDK signing-verification results for the exact final APK. A debug/test certificate
cannot be relabeled as that publisher identity.

After any asset replacement, mount/install/extract the actual final file and
repeat client package and license checks with fresh output
paths. Update its manifest size/hash and verified signing identity/status, add
the new reports to evidence, and regenerate the evidence hash and SHA256SUMS.
Do not reuse an unsigned candidate's checksums or acceptance labels.
Use the [explicit final-installer staging commands](../acceptance/final-package-acceptance.md#review-and-publication-handoff)
to derive checked resources from the selected final file and rebuild local
assets. Default `release.py stage` remains the CI path for unsigned desktop or debug/test Android candidates. Explicit final staging requires the original CI candidate, installer and contained evidence; a previous restaging cannot replace original build provenance. Follow the [final-byte staging procedure](../acceptance/final-package-acceptance.md#review-and-publication-handoff) for installer snapshots, native identity, license gates, payload fingerprints, private/public evidence handling and unchanged original-candidate bytes. These checks fail on altered inputs and do not establish Actions provenance, signing or installation acceptance.

Archive independently reviewed signing, clean-machine and live-model records bound to the exact final installer SHA-256. The [signing and acceptance report contract](../acceptance/final-package-acceptance.md#review-and-publication-handoff) defines the required fields, status bindings and public sanitization; [acceptance input examples](../acceptance/final-package-acceptance.md#acceptance-report-inputs) cover the two acceptance reports. Without a signing report, publisher verification stays unverified; missing acceptance reports stay pending. Supplied reports preserve externally reported outcomes and do not run the checks, attest their truth, complete #91 or authorize publication. Independently review the expected/observed publisher identity, commands/results, original build provenance and final bytes before publication.

For each public platform record OS version, architecture, date and results for
clean installation, upgrade/uninstall, native dialogs, credentials, audio,
practice, submission and backup restore. Record exact commands, final source
and artifact hashes, failure injection, frozen-source live parsing/grading and
representative human review separately. Existing synthetic checks and historical
reports do not establish these results. Test versions may explicitly defer
signing and manual/platform acceptance; they still require strict package gates
and disclosure of known failures. Ordinary releases require all applicable
[release acceptance requirements](../../CONTRIBUTING.md#release-verification).

Historical embedded-engine reports remain historical evidence. Service Office
fidelity and service dependency notices belong to that independent deployment;
removing engines from the client does not establish their acceptance. See
[notice requirements](../../app/licenses/README.md). Final-source live grading,
service import and clean-machine acceptance remain separate required records.

Complete every section of the template: user-visible changes, downloads and
installation, data compatibility, known limitations, distinct validation results,
commit/components and comparison link. Recheck format numbers against tagged
source. Preserve explicit user-triggered model use/cost and grading limitations.
Replace placeholders; only check verified items. Download every draft attachment
and verify its size/hash before publishing.

Enable [immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
in repository settings. Attach all final assets to the draft before publication;
published assets/tags are locked, while explanatory release notes remain editable.
Publish a suffix version as Pre-release; promote only an accepted ordinary
release to Latest. If a published build is defective, explain the issue in its
notes and deliver a new version without silently replacing files.

Use the [final-package acceptance record](../acceptance/final-package-acceptance.md) to collect
the candidate identity and per-platform evidence for
[#91](https://github.com/shenyankm/PractiQ/issues/91). Final-release acceptance
requires the signing, clean-machine and separately authorized live-model evidence
defined above. Feature implementation in [#130](https://github.com/shenyankm/PractiQ/issues/130)
and [#131](https://github.com/shenyankm/PractiQ/issues/131) follows its own
issue-specific implementation, test, CI and review gates; those issue closures
do not certify final-release acceptance or authorize publication. The independent-service
implementation was delivered by [merged PR #132](https://github.com/shenyankm/PractiQ/pull/132);
[PR #133](https://github.com/shenyankm/PractiQ/pull/133) records Android implementation
and validation status.
