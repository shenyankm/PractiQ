# Final-package acceptance record

Tracks [#91](https://github.com/shenyankm/PractiQ/issues/91). The current release target is macOS 14+ on Apple Silicon, using one Electron application with embedded TypeScript/Node AI workers. Historical service and cross-platform evidence below is not current support or release acceptance. No final signing, clean-machine or live-model acceptance is recorded by this worksheet.

The [November 4 grading checks](../evidence/2026-11-04-grading/README.md) add local macOS native grading, Keychain, restart and backup/restore evidence using synthetic data and a loopback model substitute. The GUI candidate uses an isolated application identifier; its hashes and the separately inspected standard installer are recorded independently. These checks do not turn the release matrix below into signed, clean-machine or real-model acceptance.

## Candidate identity

Use one clean main commit and retain its SHA in every platform record. Signing, repackaging or reselecting source invalidates earlier artifact hashes.

| Field | Required value / current evidence |
| --- | --- |
| Source SHA / tag / application version | Pending; npm application and both lockfile root versions must match the tag |
| Release candidate schema / mode | `packageSchemaVersion: 1`, `packageMode: electron-desktop`; build metadata version 1 and actual native/full versions must match |
| Embedded AI version | Same application version; LangGraph.js, SQLite and local files |
| Build URL / OS / architecture / date | Original immutable CI build candidate plus independent provenance review |
| Installer path / bytes / SHA-256 | Calculate after all signing, notarization, stapling and packaging |
| Signing / identity / verification command | Pending; record unsigned explicitly when applicable |
| Application package evidence | Native/full versions, absence of retired runtimes, renderer/workers matching rebuilt source, npm licenses, and exact notices |
| Embedded import / grading evidence | Frozen application identity, Tencent/model provider configuration and authorized live checks |
| Reviewed release evidence / downloads | Pending; download sizes and hashes must match SHA256SUMS |

## Platform evidence matrix

Use **Passed**, **Failed**, **Blocked**, or **Not run**, with evidence or a reason in every cell. Payload extraction is engineering evidence, not installation or clean-machine acceptance.

| Flow | macOS 14+ arm64 |
| --- | --- |
| Actual final installer: native version, embedded TS workers, no retired runtimes, notices | Not run |
| Signing/notarization or publisher signature verification | Not run |
| Clean installation, upgrade, uninstall | Not run |
| Native file selection and authorized ZIP/audio access | Not run |
| Provider credential set/read/delete through macOS-protected encrypted storage, no backup leakage | Not run |
| Listening playback using an authorized public audio fixture | Not run |
| ZIP append import; offline practice and submission | Not run |
| Explicit grading/retry through embedded AI; absent evidence stays ungraded | Not run |
| Failed/unknown direct-grading receipt survives restart; changed endpoint/model requires explicit regrading | Not run |
| Grading connection settings backup/restore excludes credentials and preserves practice snapshots | Not run |
| Offline practice without provider access; passive actions make no paid calls | Not run |
| Full backup restore after replacement confirmation | Not run |
| Old data directories untouched; unsupported backup rejected | Not run |

Record the exact macOS runtime and native Keychain/file-picker behavior. Use synthetic study data and never publish credentials, databases or backups. Real grading requires explicit provider authorization and a budget; otherwise mark it **Blocked**.

Record embedded AI acceptance separately: application/execution identity, passive source selection, explicit Start import, Tencent receipts for every supported type, Office limits with PDF-export guidance, task progress/review/retry, ZIP export and append import. Record grading endpoint/model and prompt/receipt identity, bounded call budgets and unknown-result recovery. Package checks do not establish recognition or live-model accuracy. New listening content must retain playback addresses without persisting recordings; historical audio and backup references remain supported.

## Execute gates against final bytes

Use the [draft workflow](../../.github/workflows/release.yml) after selecting a committed main candidate and existing annotated tag; dispatch on that same tag. Verify unchanged attachments against the candidate's Actions provenance before any final-byte replacement. Signing or restaging changes attachment identity and requires separately reviewed final-byte evidence. Install the candidate's locked Node dependencies with `make app-install`; release tooling uses Node 22.18+ and macOS system utilities. Notices, lockfiles and scripts must come from that clean checkout.

For CI artifacts, `node app/scripts/release.ts stage --tag ... --package ... --acceptance ... --output ... --reports ...` selects the newly built Electron DMG and its automated package receipt. It makes a private read-only snapshot and mount, checks native/full versions, recompiles renderer/workers for exact comparison, audits retired-runtime absence and compares generated notices/licenses. Resource directories must be real and contained; links must be relative, resolve inside the bundle and identify existing bytes. `Info.plist` and the executable must be regular files with real contained parents. The receipt must bind the exact DMG and pass native practice, restore/restart, codecs/PDFium and protected-credential checks; synthetic receipts do not establish release acceptance.

## Review and publication handoff

Run from a dedicated clean candidate checkout. Checks run on macOS against the actual selected installer. Keep reports and output outside the checkout, use fresh directories for every run, and retain failed reports. The following macOS command defines every input and checks the candidate before staging:

```sh
set -eu
CANDIDATE_SHA=your_candidate_full_sha_here
TAG=your_selected_candidate_tag
FINAL_INSTALLER=/absolute/path/to/exact/final-installer.dmg
FINAL_INPUTS=/absolute/path/to/fresh/final-inputs
FINAL_REPORTS=/absolute/path/to/fresh/final-reports-macos
BUILD_CANDIDATE=/absolute/path/to/original-release-macos/candidate.json
test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"
test -z "$(git status --porcelain --untracked-files=all)"
node app/scripts/release.ts stage --tag "$TAG" \
  --installer "$FINAL_INSTALLER" --reports "$FINAL_REPORTS" \
  --build-candidate "$BUILD_CANDIDATE" \
  --output "$FINAL_INPUTS/release-macos"
```

The staging command creates fresh report/output directories and rejects existing destinations; parent directories may already exist.

Explicit staging checks a private read-only DMG snapshot. The executable and its real parents must belong to that payload; Info.plist must retain the complete prerelease identity. Mach-O checks bind actual bounded executable slices and execute permissions to the declared architecture. Electron build metadata, source hashes, runtime inventory and retired-engine absence remain mandatory. Source-bound npm metadata/licenses and regenerated notices must match embedded bytes. Original automated package acceptance remains evidence of the original build; re-signing requires independent final-byte acceptance.

The original candidate and complete selected payload remain bound through every gate and final asset handoff; failure retains diagnostics without publishing incomplete assets.

Both ordinary CI staging and explicit final staging fingerprint the complete selected payload before gates, after gates and before asset handoff. A change to bytes, modes, file types, directory membership or link targets blocks staging even if the read-only installer snapshot remains unchanged. This detects changed final content; it does not attest that a package is safe to execute. Public report redaction covers `file:` URIs and JSON keys as well as absolute paths, preserves normal HTTP(S) path namespaces while continuing to redact query-local paths and known machine roots, and uses deterministic numbered suffixes to retain every value when redacted keys collide without overwriting existing literal keys. `FINAL_REPORTS/original-candidate.json` preserves the exact original CI candidate bytes, including formatting. If redaction would change any decoded original field or key, staging fails and leaves that raw file private. Otherwise those exact bytes are archived as `evidence/original-candidate.json`, identified by the provenance wrapper's `originalCandidate` and verified against its `candidateSha256`. Assembly also requires the decoded original to equal the nested candidate and checks the final archive entry hash. A sanitized or reformatted replacement is not the original candidate. Original candidate parsing rejects duplicate keys at every depth, including harmless duplicates and escaped equivalent names, so overwritten decoded values cannot conceal private content in the exact public bytes. Rejection preserves the original private input or already retained raw report and blocks public staging or assembly; ordinary report parsing is unchanged.

Archive signing verification independently: exact artifact SHA-256, expected publisher identity, commands and results. An independent JSON report must contain a complete 64-hex `artifactSha256` matching the final installer; hexadecimal case does not change identity. Its required `status` is `verified`, `unsigned` or `failed`. For a `verified` declaration, independent publication review must require `identity` identifying the expected and observed publisher, the exact `verificationCommands`, and their `verificationResults`, all bound to that same final artifact SHA-256. A declared status alone is insufficient for verified acceptance. These audit fields are optional for `unsigned` or `failed` reports; retain them when available. The metadata parser checks the artifact/status binding; it does not enforce this independent audit policy or establish that the commands ran. Pass `--signing-report /absolute/path/to/actual-signing-report.json` to retain it as bound evidence. Candidate and assembled manifest preserve the report declaration as `externally_reported_verified`, `externally_reported_unsigned` or `externally_reported_failed`; without a report, final staging records **unverified**. The script rejects mismatched artifact hashes, unknown statuses and report/manifest status drift; it does not execute verification or attest the supplied report. The original build candidate must be the unsigned macOS CI output, never an earlier restaging. Source checkout identity alone cannot prove installer build provenance. Without the acceptance reports below, manual and live acceptance remain **pending**.

### Acceptance report inputs

After the actual final installer completes independent clean-machine and live-model acceptance, provide two separate reviewed JSON reports for that platform. The following are schema examples with placeholders, not passing acceptance evidence. Replace every placeholder with the actual frozen candidate identity and reviewed results; use `passed` only after the relevant checks genuinely pass, or `failed` to retain a reviewed failure. The script validates metadata and hashes, does not perform those checks or prove that the declarations are true, and never treats synthetic fixtures as actual release acceptance.

Clean-machine report:

```json
{
  "schemaVersion": 1,
  "kind": "clean-machine",
  "artifactSha256": "<exact-final-installer-64-hex-sha256>",
  "tag": "<candidate-tag>",
  "commit": "<exact-candidate-source-commit>",
  "components": {"desktop": "<application-version>"},
  "os": "macos",
  "architecture": "<arm64-or-x64>",
  "status": "<passed-or-failed>",
  "reviewedBy": "<actual-reviewer-identity>",
  "verificationResults": ["<actual per-platform clean-machine matrix results and limitations>"]
}
```

Live-model report, prepared only after separately authorized real-model checks:

```json
{
  "schemaVersion": 1,
  "kind": "live-model",
  "artifactSha256": "<exact-final-installer-64-hex-sha256>",
  "tag": "<candidate-tag>",
  "commit": "<exact-candidate-source-commit>",
  "components": {"desktop": "<application-version>"},
  "os": "macos",
  "architecture": "<arm64-or-x64>",
  "status": "<passed-or-failed>",
  "reviewedBy": "<actual-reviewer-identity>",
  "verificationResults": ["<actual embedded parsing, explicit grading and representative human review>"]
}
```

Each file is at most 1 MiB. Only the required fields shown and optional `verificationCommands`, `limitations`, `reviewedAt`, and `osVersion` are accepted. `verificationResults` must contain 1–128 nonempty strings; optional command and limitation lists contain at most 128. Every string in those lists and reviewer/OS/time metadata is bounded to 8192 characters. Review all content for credentials and personal data before supplying it. Add `--clean-machine-report /absolute/path/to/actual-clean-machine.json` and `--live-model-report /absolute/path/to/actual-live-model.json` to the explicit final staging command. These flags do not call a model or authorize publication.

Staging retains the raw records privately in the fresh reports directory and creates sanitized public copies as `evidence/clean-machine-report.json` and `evidence/live-model-report.json`. `cleanMachineAcceptance` and `liveModelAcceptance` become `externally_reported_passed` or `externally_reported_failed` according to the corresponding bound report; a missing report remains `pending`. Assembly revalidates the schema, identity, fixed contained report path, status and archived bytes. The release remains a draft with independent signing and acceptance review pending, including when both reports declare success. If final signing/repackaging changes the installer bytes or candidate identity, the prior reports cannot be reused for that different artifact.

After the package gate passes, download the same-candidate `embedded-ai-checks`
artifact into `FINAL_INPUTS/embedded-ai-checks`. Preserve its extracted layout:
`app/.build/reports/desktop.xml` and `coverage/desktop/` containing
`coverage-summary.json`, `cobertura-coverage.xml` and `lcov.info`. Assemble into a
new directory:

```sh
FINAL_ASSETS=/absolute/path/to/fresh/final-assets
node app/scripts/release.ts assemble --tag "$TAG" \
  --inputs "$FINAL_INPUTS" --output "$FINAL_ASSETS"
```

Assembly requires exactly one schema-1 `electron-desktop` macOS candidate,
original or explicitly restaged. It rejects old package modes, source/version
drift, changed installers, missing/failed evidence and altered notices. Embedded
AI evidence needs nonempty successful JUnit, required coverage thresholds and
consistent JSON/Cobertura/LCOV counts. Every archived candidate/report and the
copied installer are rehashed before output publication. Public CI reports
redact local paths and retain original/public hashes in the manifest. The
generated manifest, evidence ZIP and checksums remain local draft assets.

Complete the [release template](../../.github/RELEASE_TEMPLATE.md) with actual signing, installation, embedded import and grading evidence. Verify every downloaded attachment against its size/hash. Link the chosen main candidate and immutable evidence before closing #91. Test-version deferrals remain explicit under the [release policy](../maintainers/releases.md). This worksheet supplies no signing credentials, target systems or live-model acceptance.

Feature delivery follows the issue-specific implementation, test, CI and review gates in [#130](https://github.com/shenyankm/PractiQ/issues/130) and [#131](https://github.com/shenyankm/PractiQ/issues/131), independently of #91 final-release acceptance. The independent-service implementation was delivered by [merged PR #132](https://github.com/shenyankm/PractiQ/pull/132); follow [PR #133](https://github.com/shenyankm/PractiQ/pull/133) for Android implementation and validation status. Closing an implementation issue does not establish signed final installers, clean-machine acceptance or live-model quality, and does not authorize model calls or publication.

## Engineering reference recorded on 2026-10-04

This is preparation for [#91](https://github.com/shenyankm/PractiQ/issues/91), not a selected release candidate. The reference source is main commit [`095a33b0e55d613f0a934701cc2d2b2b3ef72416`](https://github.com/shenyankm/PractiQ/commit/095a33b0e55d613f0a934701cc2d2b2b3ef72416). No tag or release was created; the GitHub release list was empty when checked. Final byte selection, publisher verification, clean-machine acceptance and separately authorized live-model acceptance remain pending. Real-model calls are currently unauthorized.

The six client version fields are all `0.1.0`: `app/package.json`, both root and `packages[""].version` in `app/package-lock.json`, the package versions in `app/src-tauri/Cargo.toml` and `Cargo.lock`, and `tauri.conf.json`. Independent AI-service source version is `0.3.0`, not a deployed-service identity. Package checks retain schema 2, `desktop-practice` and `desktopVersion: 0.1.0`; desktop identifier is `com.practiq.desktop`, while Android is `com.practiq.android`. The embedded five-field build manifest has no source commit; bind packages to their actual checkout and build records separately.

The following Actions status was read at 10:48 UTC. A passed component or retained report does not turn a cancelled workflow into a passed run.

| Reference build | Observed result |
| --- | --- |
| [Service, main `095a33b`](https://github.com/shenyankm/PractiQ/actions/runs/37195722376) | Completed successfully. The same-source local no-model verification also passed 1,688 tests, 93% coverage and 33 evaluation cases. |
| [Desktop, main `095a33b`](https://github.com/shenyankm/PractiQ/actions/runs/37195722419) | Workflow cancelled; quality passed, both package jobs cancelled and aggregate failed. The retained macOS package report passed; Windows retained only build metadata/notices, with no final-package report or installer hash. |
| [Android, main `095a33b`](https://github.com/shenyankm/PractiQ/actions/runs/37195722354) | Workflow cancelled; quality and arm64 APK job passed, API 35 emulator cancelled and aggregate failed. The retained arm64 package report passed. |
| [Desktop PR #136](https://github.com/shenyankm/PractiQ/actions/runs/37194573437) and [Android PR #136](https://github.com/shenyankm/PractiQ/actions/runs/37194573433) | Completed successfully, including macOS/Windows package checks and Android arm64 package/API 35 emulator diagnostics. Checkout logs identify synthetic merge `3c85f37ec15ffef7302bbe8b84cec0217ce9958f`, merging PR head `e27c67a` into then-main `097afffc`; these are not builds from `095a33b`. |

These installer hashes were read from the archived package-check JSON. Only the small metadata/notice archives were downloaded and their API archive digests rehashed; installers were not downloaded, executed or independently rehashed. Archive digests and report hashes are distinct from installer hashes. The Android report's `sizeBytes` is the exact APK snapshot size: 261,564,363 bytes for each listed CI APK. Desktop `sizeBytes` instead totals the extracted application payload and cannot establish DMG/NSIS installer size; those installer byte counts remain unrecorded.

The small report archives expire after seven days under the [Desktop](https://github.com/shenyankm/PractiQ/blob/095a33b0e55d613f0a934701cc2d2b2b3ef72416/.github/workflows/desktop.yml#L204) and [Android](https://github.com/shenyankm/PractiQ/blob/095a33b0e55d613f0a934701cc2d2b2b3ef72416/.github/workflows/android.yml#L161) workflows. The durable sanitized reports below remain in this repository. Their [manifest](../evidence/2026-10-04-package-reference/manifest.json) binds each actual checkout, build run, original artifact/archive digest, original report digest and sanitized report digest. macOS and Windows copies replace only `bundle`, `application` and `nativeExecutable` with package-relative payload paths; these are not public installer filenames. All other fields and values are unchanged. Both Android copies retain the original bytes. These mirrors and archive digests preserve the inspected checker output; they do not constitute installer download, rehash, signing or installation acceptance.


| Actual build checkout / package | Checker-reported installer SHA-256 | Retained report |
| --- | --- | --- |
| `095a33b`, macOS arm64 DMG | `563f254559dbaebb3528c99f06806fce118bba0f3821dcfbc84c4a11954f09b2` | [durable report](../evidence/2026-10-04-package-reference/main095-macos.json) / [Actions archive](https://github.com/shenyankm/PractiQ/actions/runs/37195722419/artifacts/11300807419); archive SHA-256 `1a5a0b57b1dc6b9c72fdaa55d4b1e9ef42550cdddc8a0c4fdcc325e9e48d8a6a`, package check passed |
| `095a33b`, Android arm64 debug APK | `eb1f408d197b3fd3b4f8ac02414a86b75cb01f1adab09e955723009f96d5fb1e` | [durable report](../evidence/2026-10-04-package-reference/main095-android.json) / [Actions archive](https://github.com/shenyankm/PractiQ/actions/runs/37195722354/artifacts/11301436538); archive SHA-256 `fd7ca335624a0652b8dbb667fa815e0334f0da6be4085d107fb013b045fa0cac`, package check passed |
| `3c85f37`, macOS arm64 DMG | `cb2ee14358bd5d3a97916a8cb0f8afa1c0aaae4f17e03f21ee33cd955950a3f0` | [durable report](../evidence/2026-10-04-package-reference/pr136-macos.json) / [Actions archive](https://github.com/shenyankm/PractiQ/actions/runs/37194573437/artifacts/11300109972); archive SHA-256 `1e2d702040bdd26a61ff870010cdc0976ac60f78cf5e2b9978972505fdc0f857`, package check passed |
| `3c85f37`, Windows x64 NSIS | `4c6312f5e817cef95fb5e5609332083ac733f98db6247282e416b6beb685529c` | [durable report](../evidence/2026-10-04-package-reference/pr136-windows.json) / [Actions archive](https://github.com/shenyankm/PractiQ/actions/runs/37194573437/artifacts/11300986256); archive SHA-256 `3149c917f95f2d05523eefd69fd459b068d9d42e77688f378116d47d8e5f6aa9`, package check passed |
| `3c85f37`, Android arm64 debug APK | `706f11bf5af5ed78926aa16244735034731b55952950aa8b329049b56eaf588f` | [durable report](../evidence/2026-10-04-package-reference/pr136-android.json) / [Actions archive](https://github.com/shenyankm/PractiQ/actions/runs/37194573433/artifacts/11300481638); archive SHA-256 `0502169c701f4a903165eb0dd4706ede804af3a2d733769947b41e7b95f24742`, package check passed |

Two separate local debug APKs were built from `8cdc570e17657250a6a4e82f1049e359e3104e80`; their actual bytes were rehashed during this inventory. Neither is a `095a33b` final package.

| Local `8cdc570` diagnostic package | Actual bytes | Actual SHA-256 |
| --- | --- | --- |
| Android arm64-v8a | 134,261,467 | `f3c38bde99c7c53967581a7919ea5046295c4582e75d44c58d42acc40292183c` |
| Android x86_64 | 134,727,008 | `26742f8cffdf9c542ef1e851cd8c5539c48080ccda7c1dbabab5ff4595388c67` |

Both local APKs passed strict package checks and 16 KiB archive/ELF alignment checks. Their Android Debug certificate verified; this leaves publisher identity unverified. The arm64 APK passed four unit tests and 16 native instrumentation checks on the API 35 emulator. The x86_64 APK is package/alignment evidence only. These results do not establish physical-device, minimum API 26, minimum WebView, 16 KiB runtime or clean-machine release acceptance. No real model was called. The `app/src` and `app/src-tauri/src` trees at `8cdc570` equal those at `095a33b`, but the whole `app` tree differs; subtree equality cannot replace build provenance.

The independently achievable next step is to select a clean main source and, once its complete checks pass, record all actual installer sizes/hashes, original build candidates and evidence for that one source. Tag selection, signing and publication require the corresponding maintainer intent and publisher identity where applicable. Clean-machine and native acceptance require the actual target environment and selected final artifacts; already authorized engineering checks need no additional confirmation. Ordinary final acceptance cannot be inferred from the partial runs above. Test versions may explicitly defer signing and manual/platform acceptance under the existing [release policy](../maintainers/releases.md), while retaining strict package gates, disclosed failures and a separate publication decision. This inventory does not complete #91.
