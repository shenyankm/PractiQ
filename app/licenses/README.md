# Supplemental upstream notices

Some published dependency archives omit their license text. `supplemental.json`
maps exact package versions to upstream text, its SHA-256 and source URL. Cargo
sources use each crate's `.cargo_vcs_info.json` commit; npm sources use registry
`gitHead` where available. Historic supplemental texts remain source evidence; unused
Python notices are not selected for desktop assets.

Do not replace these with a generic SPDX identifier or infer copyright holders.
Retain upstream text verbatim. Any `note` marks source applicability that needs
release review; the notice checker fails rather than silently accepting it.

`app/scripts/check_licenses.py` inventories the selected target's Cargo packages,
npm production dependency closure and Android's resolved Maven runtime. It
checks supplemental hashes and returns nonzero for missing text or unverified
source applicability. Build packages include the combined text in
`bundled/THIRD-PARTY.txt`. Preparation fails on unresolved entries. An inventory is not a decision
about all redistribution obligations. Repeat it for each platform's final package.

The checker validates schema 2 desktop build metadata and limits Cargo entries to
the platform-filtered resolve graph. AI service dependencies and its configured
Office engine are independently deployed and require their own license review.
They are never claimed as redistributed desktop components.

## Android runtime source evidence

The Gradle `exportRuntimeNoticeInventory` task resolves the actual variant's
runtime graph. It records raw Maven AAR/JAR and version-specific POM SHA-256,
and the locally built Tauri Android libraries. `gradle.lockfile` pins runtime
versions; CI consumes this reviewed lock and does not regenerate it.
`android-runtime.lock.json` binds the exact external closure to artifact/POM
hashes and complete upstream license texts. Android preparation requires this
inventory and rejects extra, missing or changed dependencies, unmatched POM
identities and altered terms. Local Tauri Android libraries must come from the
same Cargo-resolved crate directories and use those crates' complete terms.
Tauri 2.12.1 supplies the upstream Activity lifecycle and system-result launcher
management; Gradle compiles its original Cargo source without a local Kotlin
replacement. The former Tauri 2.11.5 replacement under
`app/src-tauri/gen/android/patches/` and
`tauri-android-lifecycle.provenance.json` remain inactive historical source/license
evidence. They are absent from the current build source selection and override
lock, and their old inventory hashes are explicitly historical in
`android-runtime.provenance.json`. Each current build still exports and verifies
its exact resolved runtime inventory and local AAR identity.
Maven SPDX declarations alone cannot pass the gate.

Tauri 2.12.1 adds Jackson JSON-org 2.15.3 to this runtime. Its selected JAR and
POM match the official Maven Central downloads; the notice lock retains the
complete Apache 2.0 terms, both embedded notice files and its parent POM identity
proof. The corresponding Cargo upgrade supplements `alloc-stdlib` 0.3.0,
`ndk-context` 0.1.1 and `selectors` 0.38.0 with complete terms. Their pinned
provenance records bind official crate checksums, packaged VCS commits and
matching upstream manifests; `selectors` also retains its original MPL 2.0 source
notice and the complete canonical terms from Mozilla.

Jackson Core 2.15.3 shades FastDoubleParser. Its embedded `FastDoubleParser-NOTICE`
identifies Werner Randelshofer's MIT code and a fixed upstream commit, while its
embedded `FastDoubleParser-LICENSE` contains Apache 2.0 terms. Retain both original
files and every other artifact notice. The supplemental complete MIT copyright
and terms come from that exact referenced commit, with their own pinned SHA-256;
the checker binds the source URL to the exact embedded NOTICE bytes and records
that provenance separately from Jackson's POM declaration and embedded LICENSE.

Review new runtime versions by resolving the selected Gradle configuration with
`--write-locks`, verifying the corresponding upstream artifact/POM sources and
full terms, and updating both reviewed locks. Retain the verification evidence.
This is a build-time operation; no dependency discovery or download occurs in
the installed practice client. Android x86_64 uses the same reviewed runtime
closure for emulator checks, while advertised APK candidates use arm64-v8a.

## objc2-family terms

The ten affected versions retain their original, commit-pinned `LICENSE.md`
declarations, including the Apple SDK provenance discussion. Their supplements
also include the complete MIT text and copyright notice supplied by upstream in
[commit ee9a7ad](https://github.com/madsmtm/objc2/commit/ee9a7ada2131f5944b8750428e265c15632f2a19),
which fixes [the missing-text issue #826](https://github.com/madsmtm/objc2/issues/826).
MIT is selected for packages that offer it as an alternative. This adds the
upstream's missing text; it does not change any dependency's license declaration
or settle the SDK questions described in the original notice.

## react-remove-scroll-bar 2.3.8 attribution

The npm-published `gitHead` for 2.3.8 remains unavailable upstream. Attribution is
verified through the published artifacts instead; no unavailable source commit
is represented as retrieved:

- Both npm tarballs (2.3.7 and 2.3.8) were verified against their published SHA-512
  integrity values. All 26 files other than `package.json` are byte-for-byte equal.
- Both packages declare MIT and the same author. The only metadata differences
  are the version and `react-style-singleton` range (`^2.2.1` to `^2.2.2`).
- The 2.3.7 `gitHead`, `29e9fcd1eecf7d3b77a767941c4a57fe461fc1e4`, is public.
  [Comparison with the license merge](https://github.com/theKashey/react-remove-scroll-bar/compare/29e9fcd1eecf7d3b77a767941c4a57fe461fc1e4...8ca9ba5ea52de03308fe8ced94f7b159a44d28ff)
  shows only the addition of `LICENSE`. That immutable file supplies the complete
  MIT terms and Anton Korzunov's original copyright notice for the same payload.

[Provenance evidence](react-remove-scroll-bar-2.3.8.provenance.json) records the
artifact URLs, integrity values, file hashes and metadata differences. Its
SHA-256 is pinned in `supplemental.json`, checked during inventory and checked
again when embedding it in `THIRD-PARTY.txt`. The dependency remains at 2.3.8.

## Local shadcn CSS variants

The application uses its existing generated shadcn components without installing
the component-generator CLI. `app/src/index.css` retains the four used variants
from shadcn 4.21.0: `data-open`, `data-closed`, `data-checked` and `data-disabled`.
The source is [release commit 7c9eaba](https://github.com/shadcn-ui/ui/tree/7c9eaba1c0a6404c990c144a654792e3313c650d/packages/shadcn).
The same file includes the complete upstream MIT license and copyright notice
in a preserved CSS comment, so built application styles carry the terms.
