# Release policy

PractiQ releases deliver the offline desktop application. The bundled AI service
keeps its own package version; record it with Python, LibreOffice and locked
dependencies in the release evidence. Do not publish separate platform tags,
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
`Cargo.lock`, and `tauri.conf.json` to the complete version without `v`. The AI
service version is independent. Native installer metadata may normalize
prerelease syntax; document that mapping rather than changing the product tag.
Keep the full version in the application and asset names.

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

## Assets

| Target | Minimum system | Public filename |
| --- | --- | --- |
| macOS arm64 | macOS 14+ | `PractiQ_<version>_macos_arm64.dmg` |
| Windows x64 | Windows 10/11 with WebView2 | `PractiQ_<version>_windows_x64_setup.exe` |
| Linux amd64 | Ubuntu 22.04+ | `PractiQ_<version>_linux_amd64.deb` |

These are the current release targets. Office runtime availability for another
architecture is not application acceptance. A macOS application ZIP is optional;
if supplied, preserve symlinks with `ditto` and verify the final archive too.
Do not add MSI, AppImage, RPM or more architectures before their package checks.

Every installer includes the platform-native Python service, pinned LibreOffice,
build manifest and full notices. Users do not install Python or Office. Document
Linux system-library/audio dependencies and an unlocked Secret Service, plus the
Windows WebView2 requirement, rather than promising a dependency-free package.

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
tag. Run **Release draft** from Actions on `main`, entering the existing tag, or:

```sh
gh workflow run release.yml --ref main -f tag=v0.1.0-alpha.1
```

The workflow validates versions, the tag's commit, clean source and ancestry on
`main`. It reuses Service and Desktop CI at that exact commit, forces full checks
regardless of changed paths, and runs the existing package matrix. It mounts the
final macOS DMG, uses the installed NSIS application and extracted DEB, then runs
`check-bundle.py`, isolated Office conversion, strict fidelity and license-source
checks. Any failure blocks release asset staging and draft creation; failure
diagnostics remain in Actions. Prerelease status never bypasses these gates.

Assembly rejects missing platforms, mismatched commits/versions, altered
installers or missing/failed package evidence. It bundles service reports,
generates checksums, and fills [the release template](../.github/RELEASE_TEMPLATE.md).
The template is project-owned; GitHub does not load this filename automatically.
The workflow verifies the remote tag again, creates only a draft and never
updates an existing release, publishes, or marks a draft Latest. Retry failed
pre-draft runs; an existing draft is deliberately rejected to avoid replacing
reviewed assets silently. Review or discard that draft explicitly before retrying.

CI currently has no publisher signing credentials. Its installer metadata and
notes therefore state **unsigned**, **clean-machine acceptance pending** and
**live-model acceptance pending**. An ordinary-version draft is not Stable.
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
Record Linux package-signing status separately.

After any asset replacement, mount/install/extract the actual final file and
repeat package, isolated Office, fidelity and license checks with fresh output
paths. Update its manifest size/hash and verified signing identity/status, add
the new reports to evidence, and regenerate the evidence hash and SHA256SUMS.
Do not reuse an unsigned candidate's checksums or acceptance labels.
Use the [explicit final-installer staging commands](final-package-acceptance.md#review-and-publication-handoff)
to derive checked resources from the selected final file and rebuild local
assets. Default `release.py stage` remains the unsigned CI path. Explicit
staging requires the original CI platform candidate, installer and bound
evidence, preserves its build URL, and checks the selected installer's actual
desktop version. Windows payload extraction requires installed full 7-Zip;
it does not execute NSIS or count as installation acceptance. Raw local reports
remain private; the public evidence copy replaces machine paths before hashing.
Staging does not attest Actions provenance or verify signing. Archive actual
signing results bound to the final SHA-256 and review the original download's
build provenance before recording verified status in the release template.

For each public platform record OS version, architecture, date and results for
clean installation, upgrade/uninstall, native dialogs, credentials, audio,
practice, submission and backup restore. Record exact commands, final source
and artifact hashes, failure injection, frozen-source live parsing/grading and
representative human review separately. Existing synthetic checks and historical
reports do not establish these results. Test versions may explicitly defer
signing and manual/platform acceptance; they still require strict package gates
and disclosure of known failures. Ordinary releases require all applicable
[release acceptance requirements](../CONTRIBUTING.md#release-verification).

Current recorded gaps include legacy DOC equation fidelity, unresolved notice
sources and missing final-source live/clean-machine acceptance. See
[the follow-up record](review-implementation-20260929.md) and
[notice requirements](../app/licenses/README.md). This workflow does not fix or
waive those findings, and must fail until the applicable strict gates pass.

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

Use the [final-package acceptance record](final-package-acceptance.md) to collect the candidate identity and per-platform manual evidence tracked by #91.
