# PractiQ @TAG@

> Draft: publisher signing, clean-machine checks and live-model acceptance remain incomplete.
> Complete the applicable evidence before publication. A prerelease label does not waive package-integrity or notice gates.

## Highlights

<!-- Replace with user-visible additions and fixes. Introduce the separate Web import and offline practice workflows for the first release. -->

@CHANGES@

## Downloads

| Platform | Minimum requirements | File | Automated final-package checks | Publisher signing | Clean-machine acceptance |
| --- | --- | --- | --- | --- | --- |
| macOS | macOS 14+, Apple Silicon | `PractiQ_@VERSION@_macos_arm64.dmg` | Record evidence | Unsigned / not notarized | Pending |

These are offline practice clients. They contain no Python AI service or LibreOffice runtime. Document upload, normalization, task progress, review and bank ZIP download belong to the independent AI service's Web frontend. Explicit AI grading calls a user-configured OpenAI-compatible model directly, or the separately deployed service in service mode.

Linux is an independent AI-service deployment and CI host, not an application target. GitHub Source code attachments are source, not installers. Record the actual tested OS versions and installation steps.

macOS native `CFBundleShortVersionString` and `CFBundleVersion` use the numeric
core of `@VERSION@`; the merged plist `PractiQVersion`, application, build manifest,
tag and asset names retain the full prerelease identity. Package checks verify
both native fields and the exact full version. No automatic updater is shipped.

## Data compatibility

- Desktop directory `v4/`, SQLite schema 11; full backup container version 4, schema 11.
- Bank ZIP version 2, AI JSON schema 3. Bank import appends content; full restoration requires replacement confirmation.
- Old directories remain untouched. Older databases and full backups are rejected without migration. Keep backups before upgrading; downgrade compatibility is not promised.
- Practice-client service tokens and direct-grading model API keys stay in the macOS Keychain. Document-import provider keys belong to the independent service. Full backups exclude credentials and AI task state; optional version-1 grading connection settings are included without secrets.
- Existing provider settings, key namespaces and legacy task files are preserved but are not automatically used as service connections or migrated to the independent service.
<!-- Update these values from tagged source whenever formats change. -->

## Known limitations

<!-- List concrete failed or untested flows. Do not infer interactive acceptance from CI. -->

Offline practice needs no account or service. Parsing and AI grading require explicit user actions and may incur provider charges. Parsing sends documents to the independent service and its configured providers; direct grading sends grading content to the user-configured model endpoint, while service-mode grading uses the independent service. Grading requires a reference answer or rubric; missing evidence, failed calls and unknown outcomes remain ungraded. It is a personal-practice aid.

The independent service accepts PDF, TXT, Markdown, PNG/JPEG, Word (.doc/.docx), PowerPoint (.ppt/.pptx) and Excel (.xls/.xlsx). Every new import uses Tencent Cloud multimodal document parsing before question structuring; new CSV imports are rejected. Oversized Office files additionally require the isolated LibreOffice PDF adapter. Tencent/provider configuration, conversion fidelity, live-model quality and deployment are separate from these client packages.

## Validation

- [ ] Same-candidate service, Web, desktop, browser, dependency and build checks passed; record links. Models and browser native commands use substitutes.
- [ ] All final installers passed version, checksum, notices and absence-of-embedded-engines checks; record exact hashes.
- [ ] Each advertised platform passed clean-machine installation, upgrade/uninstall, file selection, practice, submission, audio, credentials and backup restore; record OS, date, outcome and evidence.
- [ ] macOS Developer ID signing/notarization status was verified. An unsigned test candidate must disclose this and cannot be labeled Stable.
- [ ] Independent-service Web import/review/export and desktop ZIP import/offline practice were verified against declared versions; deployed Office fidelity was checked where advertised.
- [ ] Frozen-candidate live parsing/grading, failure injection and representative manual review were recorded, with failures and limitations disclosed.
- [ ] Highlights, installation steps, known limitations and comparison link are complete; remove placeholder comments.
- [ ] Download every draft attachment and confirm its size, SHA-256 and acceptance evidence match.
- [ ] Verify Actions provenance for every unchanged CI attachment against the candidate tag, commit and release workflow. Any signed/restaged replacement needs separately reviewed final-byte provenance.

Explain incomplete items. Stable publication requires all applicable acceptance. Permitted test-candidate deferrals must be explicit; package-integrity and notice failures still block distribution.

## Provenance

- Commit: `@COMMIT@`
- Desktop: `@VERSION@`; independent AI service source version: `@AI_VERSION@` (not embedded or deployed by these installers)
- `release-manifest.json`: files, sizes, SHA-256, component versions, build links and acceptance status.
- `release-evidence.zip`: declared service checks and each final practice-client package's metadata/notices/checks.
- `SHA256SUMS.txt`: hashes of all other public attachments; hashes do not replace publisher signatures.
- GitHub artifact attestations: the Release draft workflow attests and verifies the unchanged CI attachments. Follow the release policy to reverify downloads; signing or restaging invalidates that proof for changed bytes.
- Full changelog: <!-- Link the previous tag...@TAG@, or tagged source for the first release. -->

Automated package checks do not establish clean-machine acceptance, independent-service deployment or live-model accuracy. Read the platform evidence and known limitations before installation.
