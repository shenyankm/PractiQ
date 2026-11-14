# PractiQ @TAG@

> Draft: publisher signing, clean-machine checks and live-model acceptance remain incomplete.
> Complete the applicable evidence before publication. A prerelease label does not waive package-integrity or notice gates.

## Highlights

<!-- Replace with reviewed user-visible additions and fixes. -->

@CHANGES@

## Downloads

| Platform | Minimum requirements | File | Automated final-package checks | Publisher signing | Clean-machine acceptance |
| --- | --- | --- | --- | --- | --- |
| macOS | macOS 14+, @ARCH@ | `PractiQ_@VERSION@_macos_@ARCH@.dmg` | Record evidence | Unsigned / not notarized | Pending |

This is one Electron application with embedded TypeScript/Node AI workers,
LangGraph.js checkpoints and Store, SQLite and local files. It contains no
Python, Rust/Tauri, PostgreSQL, RabbitMQ or LibreOffice runtime. Document import,
task review, bank import, practice and explicit AI grading run from the App.
Configure recognition/model providers in Settings; no separate backend is needed.

macOS is the only application target. Record the actual architecture and tested
OS versions; an arm64 result does not establish Intel acceptance. GitHub Source
code attachments are source, not installers.

macOS native `CFBundleShortVersionString` and `CFBundleVersion` use the numeric
core of `@VERSION@`; the merged plist `PractiQVersion`, application, build manifest,
tag and asset names retain the full prerelease identity. Package checks verify
both native fields and the exact full version. No automatic updater is shipped.

## Data compatibility

- Desktop directory `v4/`, SQLite schema 11; full backup container version 4, schema 11.
- Bank ZIP version 2, AI JSON schema 3. Bank import appends content; full restoration requires replacement confirmation.
- Old directories remain untouched. Older databases and full backups are rejected without migration. Keep backups before upgrading; downgrade compatibility is not promised.
- Current provider credentials use macOS-protected encrypted local storage. Legacy Keychain namespaces remain untouched. Full backups exclude credentials and AI task state; optional version-1 historical grading connection settings remain supported without secrets.
- Historical directories, deployment volumes, provider settings and legacy task files are preserved. Unknown provider outcomes are not automatically replayed.
- New listening content stores QR-derived or playback addresses, without persisting recordings. Historical audio files and backup references remain supported. Remote addresses need network access and may expire or change content.
<!-- Update these values from tagged source whenever formats change. -->

## Known limitations

<!-- List concrete failed or untested flows. Do not infer interactive acceptance from CI. -->

Offline practice needs no account or service. AI work requires explicit actions,
network access and configured providers, and may incur provider charges.
Recognition sends source documents to Tencent; structuring and explicit grading
send the necessary document/question content to the configured model provider.
Grading requires a reference answer or rubric; missing evidence, failed calls
and unknown outcomes remain ungraded. It is a personal-practice aid.

Import accepts PDF, TXT, Markdown, PNG/JPEG, Word (.doc/.docx), PowerPoint
(.ppt/.pptx) and Excel (.xls/.xlsx). Every new import uses Tencent multimodal
recognition before question structuring; new CSV imports are rejected. Export
Office files which exceed the active transport/type limit as PDF before import.
The App does not discover external Office converters. Provider availability,
recognition fidelity and live-model quality require separate acceptance evidence.

## Validation

- [ ] Same-candidate embedded AI, App import, desktop, browser, dependency and build checks passed; record links. Automated model tests use substitutes.
- [ ] All final installers passed version, checksum, notices and absence-of-embedded-engines checks; record exact hashes.
- [ ] Each advertised platform passed clean-machine installation, upgrade/uninstall, file selection, practice, submission, audio, credentials and backup restore; record OS, date, outcome and evidence.
- [ ] macOS Developer ID signing/notarization status was verified. An unsigned test candidate must disclose this and cannot be labeled Stable.
- [ ] Embedded import/review/export, explicit grading, desktop ZIP import/offline practice and Office limit/PDF guidance were verified against the frozen candidate.
- [ ] Frozen-candidate live parsing/grading, failure injection and representative manual review were recorded, with failures and limitations disclosed.
- [ ] Highlights, installation steps, known limitations and comparison link are complete; remove placeholder comments.
- [ ] Download every draft attachment and confirm its size, SHA-256 and acceptance evidence match.
- [ ] Verify Actions provenance for every unchanged CI attachment against the candidate tag, commit and release workflow. Any signed/restaged replacement needs separately reviewed final-byte provenance.

Explain incomplete items. Stable publication requires all applicable acceptance. Permitted test-candidate deferrals must be explicit; package-integrity and notice failures still block distribution.

## Provenance

- Commit: `@COMMIT@`
- Application and embedded AI: `@VERSION@`; architecture: `@ARCH@`.
- `release-manifest.json`: files, sizes, SHA-256, component versions, build links and acceptance status.
- `release-evidence.zip`: embedded AI JUnit/coverage and final package metadata, notices and checks. Public CI reports redact machine paths; the manifest records original and public report hashes. Restaged candidates retain the original candidate JSON bytes.
- `SHA256SUMS.txt`: hashes of all other public attachments; hashes do not replace publisher signatures.
- GitHub artifact attestations: the Release draft workflow attests and verifies the unchanged CI attachments. Follow the release policy to reverify downloads; signing or restaging invalidates that proof for changed bytes.
- Full changelog: <!-- Link the previous tag...@TAG@, or tagged source for the first release. -->

Automated package checks do not establish clean-machine acceptance, publisher
identity or live-model accuracy. External reports remain declarations bound to
the exact final bytes. Read the evidence and known limitations before installation.
