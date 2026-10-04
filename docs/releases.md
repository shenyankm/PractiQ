# Release policy

PractiQ releases deliver the offline desktop practice application. AI source
import, Office conversion and parsing run in the independently deployed service
and its web frontend. Desktop grading explicitly calls that service over HTTP.
The service keeps its own source version; record it separately without claiming
it is deployed by a desktop installer. Do not publish separate platform tags,
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

These are the current desktop release targets. A macOS application ZIP is optional;
if supplied, preserve symlinks with `ditto` and verify the final archive too.
Do not add MSI, AppImage, RPM or more architectures before their package checks.

Every installer includes only desktop code, schema 2 build metadata with
`packageMode: desktop-practice`, and Cargo/npm notices. Its exact resource
whitelist contains `bundled/build-manifest.json` and `bundled/THIRD-PARTY.txt`.
Python, LibreOffice and AI workers must be absent from the whole application.
Existing ignored engine caches and historical packages remain untouched and
must never enter a new desktop installer. Document
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
final macOS DMG, safely extracts the NSIS payload and extracts the DEB from a
private read-only installer snapshot, then checks actual desktop version,
engine absence, expected regular native executable, build metadata and Cargo/npm
license sources. The generated notices must match the embedded file byte for
byte. Windows extraction uses full 7-Zip; CI does not execute the installer. Any failure blocks release asset staging and draft creation; failure
diagnostics remain in Actions. Prerelease status never bypasses these gates.

Assembly rejects missing platforms, mismatched commits/versions, altered
installers or missing/failed package evidence. It rechecks copied installers and
archived candidate, package and service evidence before handing off public
assets, so an input changed during assembly fails. It bundles service reports,
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
repeat desktop package and license checks with fresh output
paths. Update its manifest size/hash and verified signing identity/status, add
the new reports to evidence, and regenerate the evidence hash and SHA256SUMS.
Do not reuse an unsigned candidate's checksums or acceptance labels.
Use the [explicit final-installer staging commands](final-package-acceptance.md#review-and-publication-handoff)
to derive checked resources from the selected final file and rebuild local
assets. Default `release.py stage` remains the unsigned CI path. Explicit
staging requires the original unsigned CI platform candidate, installer and bound
evidence, preserves its build URL, and checks the selected installer's actual
desktop version. The original installer must be a regular non-link file with real
parent directories and resolve within its downloaded candidate directory.
The original evidence directory must resolve within the downloaded
candidate directory, and each evidence file must resolve within that evidence root.
Previously restaged candidates cannot replace that original
build provenance. Actual application headers must identify an executable Mach-O
arm64 slice on macOS, x64 PE32+ on Windows, or ELF64 little-endian x86-64 executable
or PIE on Linux. Universal Mach-O table entries must match their actual member
headers and have bounded, distinct ranges. Windows PE headers require the executable
flag (`0x0002`) set and the DLL flag (`0x2000`) clear, as defined in the
[Microsoft PE specification](https://learn.microsoft.com/en-us/windows/win32/debug/pe-format#characteristics).
DEBs must use the candidate's Tauri product name converted with
[Tauri's kebab-case rule](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.5/crates/tauri-bundler/src/bundle/linux/debian.rs#L172-L173):
`PractiQ` produces control `Package: practi-q`, independently of the installer
filename and Cargo package name. The checker supports ASCII product names and
rejects unsupported or invalid names. DEBs must also declare amd64 and mandatory
GTK/WebKit plus every runtime dependency in the candidate's Tauri configuration;
version bounds and :amd64/:any qualifiers are accepted, but alternatives do not
satisfy required libraries. Resource directories and relative links remain
contained in that selected payload. Native files are nonempty regular files
with real contained parents, and macOS Info.plist names that actual executable.
macOS and Linux binaries require POSIX execute permission bits; Windows PE
checks remain independent of POSIX modes.
Bounded header checks do not prove startup, full loadability, signing or platform
compatibility. Windows payload extraction requires installed full 7-Zip;
it does not execute NSIS or count as installation acceptance. Raw local reports
remain private; the public evidence copy replaces machine paths, including `file:`
URIs in values or keys, before hashing.
Normal HTTP(S) path namespaces containing `file:` identifiers remain intact;
local paths in query parameters and known machine roots remain redacted.
If sanitized keys collide, deterministic
numbered suffixes retain every value without overriding existing literal keys.
Both ordinary CI staging and explicit final staging fingerprint the complete
selected application/extraction tree before gates, after gates and before final
asset handoff. Changes to file bytes, POSIX modes, file types, directory membership
or link targets invalidate the staged result even when the installer snapshot is
unchanged. This integrity check does not attest safety of executing a package.
The private reports retain the exact original unsigned candidate bytes. The public
archive retains those same bytes as `evidence/original-candidate.json` only if the
decoded candidate contains no machine paths requiring redaction; otherwise staging
fails while retaining private diagnostics. Assembly verifies their byte digest
against `candidateSha256` and requires their decoded identity to match the nested
original candidate, in addition to its existing canonical semantic digest. A
reformatted or sanitized serialization cannot substitute for the original bytes.
Original candidate JSON rejects duplicate keys in every object, including nested
objects, arrays and escaped equivalent names; harmless duplicates also fail.
This prevents a later decoded value from hiding a private value still present in
the original bytes. Rejection retains the private input or existing raw report
and creates no public result; ordinary report JSON parsing is unchanged.
Staging does not attest Actions provenance or verify signing. Archive actual
signing results with artifactSha256 bound to the final SHA-256 and status of
verified, unsigned or failed. Candidate and manifest preserve these declarations
as externally_reported_verified, externally_reported_unsigned or
externally_reported_failed. Without a report, final staging records unverified;
assembly rejects a status that differs from its bound report. These fields do
not attest cryptographic verification. Review the original build download's
provenance, actual verification commands, publisher and results independently
before recording verified status in the release template.

Explicit final staging also accepts `--clean-machine-report` and
`--live-model-report` for independently reviewed acceptance records. Each report
uses schema 1 and binds its kind, candidate tag/commit/component versions,
OS/architecture and exact final installer SHA-256. It requires a nonempty reviewer
identity and verification-results list, with a declared `passed` or `failed`
status. See the [report examples](final-package-acceptance.md#acceptance-report-inputs).
The candidate and assembled manifest record `externally_reported_passed` or
`externally_reported_failed`; an absent report remains `pending`. Assembly rejects
mismatched identities, report paths and status drift, and verifies archived bytes
against the candidate's evidence hashes. These inputs do not run installation or
model checks, establish the truth of a supplied record, complete #91, or authorize
publication. Independent publication review remains pending even when both reports
declare success. Raw reports remain private; only sanitized, hash-bound copies
enter public evidence. Synthetic test fixtures validate this contract and never
establish actual clean-machine or live-model acceptance.

For each public platform record OS version, architecture, date and results for
clean installation, upgrade/uninstall, native dialogs, credentials, audio,
practice, submission and backup restore. Record exact commands, final source
and artifact hashes, failure injection, frozen-source live parsing/grading and
representative human review separately. Existing synthetic checks and historical
reports do not establish these results. Test versions may explicitly defer
signing and manual/platform acceptance; they still require strict package gates
and disclosure of known failures. Ordinary releases require all applicable
[release acceptance requirements](../CONTRIBUTING.md#release-verification).

Historical embedded-engine reports remain historical evidence. Service Office
fidelity and service dependency notices belong to that independent deployment;
removing engines from the desktop does not establish their acceptance. See
[notice requirements](../app/licenses/README.md). Final-source live grading,
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

Use the [final-package acceptance record](final-package-acceptance.md) to collect the candidate identity and per-platform manual evidence tracked by #91.
