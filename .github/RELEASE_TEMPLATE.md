# PractiQ @TAG@

> Draft: publisher signing, clean-machine checks and live-model acceptance remain incomplete.
> Complete the applicable evidence before publication. A prerelease label does not waive package-integrity or notice gates.

## Highlights

<!-- Replace with user-visible additions and fixes. Introduce the separate Web import and offline practice workflows for the first release. -->

## Downloads

| Platform | Minimum requirements | File | Automated final-package checks | Publisher signing | Clean-machine acceptance |
| --- | --- | --- | --- | --- | --- |
| macOS | macOS 14+, Apple Silicon | `PractiQ_@VERSION@_macos_arm64.dmg` | Record evidence | Unsigned / not notarized | Pending |
| Windows | Windows 10/11 x64, WebView2 | `PractiQ_@VERSION@_windows_x64_setup.exe` | Record evidence | Unsigned | Pending |
| Android | Android 8.0+ (API 26), arm64-v8a, Android System WebView | `PractiQ_@VERSION@_android_arm64.apk` | Record evidence | Debug/test key only; publisher signing pending | Pending |

These are offline practice clients. They contain no Python AI service or LibreOffice runtime. Document upload, normalization, task progress, review and bank ZIP download belong to the independent AI service's Web frontend. Explicit desktop AI grading calls that separately deployed service.

Linux is an independent AI-service deployment and CI host, not an application target. Android x86_64 APKs are emulator diagnostics, not advertised downloads. Android debug signing does not establish publisher identity. GitHub Source code attachments are source, not installers. Record the actual tested OS versions and installation steps.

## Data compatibility

- Desktop directory `v4/`, SQLite schema 11; full backup container version 4, schema 11.
- Bank ZIP version 2, AI JSON schema 3. Bank import appends content; full restoration requires replacement confirmation.
- Old directories remain untouched. Older databases and full backups are rejected without migration. Keep backups before upgrading; downgrade compatibility is not promised.
- Practice-client service tokens stay in the platform credential store (Android Keystore for Android). Provider keys belong to the independent service. Full desktop backups exclude credentials and AI task state.
- Existing provider settings, key namespaces and legacy task files are preserved but are not automatically used as service connections or migrated to the independent service.
<!-- Update these values from tagged source whenever formats change. -->

## Known limitations

<!-- List concrete failed or untested flows. Do not infer interactive acceptance from CI. -->

Offline practice needs no account or service. Parsing and AI grading require explicit user actions, send content to the service and configured provider, and may incur charges. Grading requires a reference answer or rubric; missing evidence, failed calls and unknown outcomes remain ungraded. It is a personal-practice aid.

The independent service accepts PDF, TXT, CSV and PNG/JPEG; Office support requires a separately configured and verified LibreOffice deployment. Its conversion fidelity, live-model quality and deployment are separate from these desktop packages.

## Validation

- [ ] Same-candidate service, Web, desktop, browser, dependency and build checks passed; record links. Models and browser native commands use substitutes.
- [ ] All final installers passed version, checksum, notices and absence-of-embedded-engines checks; record exact hashes.
- [ ] Each advertised platform passed clean-machine installation, upgrade/uninstall, file selection, practice, submission, audio, credentials and backup restore; record OS, date, outcome and evidence.
- [ ] macOS Developer ID signing/notarization, Windows publisher-signing and Android publisher-key signing status were verified. An unsigned test candidate must disclose this and cannot be labeled Stable.
- [ ] Independent-service Web import/review/export and desktop ZIP import/offline practice were verified against declared versions; deployed Office fidelity was checked where advertised.
- [ ] Frozen-candidate live parsing/grading, failure injection and representative manual review were recorded, with failures and limitations disclosed.
- [ ] Highlights, installation steps, known limitations and comparison link are complete; remove placeholder comments.
- [ ] Download every draft attachment and confirm its size, SHA-256 and acceptance evidence match.

Explain incomplete items. Stable publication requires all applicable acceptance. Permitted test-candidate deferrals must be explicit; package-integrity and notice failures still block distribution.

## Provenance

- Commit: `@COMMIT@`
- Desktop: `@VERSION@`; independent AI service source version: `@AI_VERSION@` (not embedded or deployed by these installers)
- `release-manifest.json`: files, sizes, SHA-256, component versions, build links and acceptance status.
- `release-evidence.zip`: declared service checks and each final practice-client package's metadata/notices/checks.
- `SHA256SUMS.txt`: hashes of all other public attachments; hashes do not replace publisher signatures.
- Full changelog: <!-- Link the previous tag...@TAG@, or tagged source for the first release. -->

Automated package checks do not establish clean-machine acceptance, independent-service deployment or live-model accuracy. Read the platform evidence and known limitations before installation.
