# Final-package acceptance record

Tracks [#91](https://github.com/shenyankm/PractiQ/issues/91), the independent-service architecture in [#130](https://github.com/shenyankm/PractiQ/issues/130), and Android delivery in [#131](https://github.com/shenyankm/PractiQ/issues/131). macOS, Windows and Android artifacts deliver offline practice and ZIP import. Linux is an independent-service and CI host, not a client release target. AI source import and Office conversion belong to the independent service and its web frontend; explicit client grading calls that service over HTTP. Historical embedded-engine packages and reports remain preserved and cannot establish acceptance of this architecture. No final candidate, signing, clean-machine or live-model acceptance is recorded by this worksheet.

## Candidate identity

Use one clean main commit and retain its SHA in every platform record. Signing, repackaging or reselecting source invalidates earlier artifact hashes.

| Field | Required value / current evidence |
| --- | --- |
| Source SHA / tag / client version | Pending; six npm/Tauri/Cargo version entries must match the tag |
| Client package schema / mode | Retain `schemaVersion: 2`, `packageMode: desktop-practice` and `desktopVersion` on all platforms; actual native version must match |
| Independent AI service source version | Separate version from tagged source; client artifacts do not deploy that service |
| Build URL / OS / architecture / date | Original immutable CI build candidate plus independent provenance review |
| Installer path / bytes / SHA-256 | Calculate after all signing, notarization, stapling and packaging |
| Signing / identity / verification command | Pending; record unsigned explicitly when applicable |
| Client package evidence | Native version, engine absence, metadata, Cargo/npm licenses plus Android Maven licenses, and byte-exact embedded notices |
| Android native identity / ABI / minSdk | `com.practiq.android`, candidate `versionName`, positive `versionCode`, only `arm64-v8a`, minSdk 26; metadata checks do not establish runtime acceptance |
| Service deployment / import / grading evidence | Separate service identity, configured Office engine and authorized live checks |
| Reviewed release evidence / downloads | Pending; download sizes and hashes must match SHA256SUMS |

## Platform evidence matrix

Use **Passed**, **Failed**, **Blocked**, or **Not run**, with evidence or a reason in every cell. Payload extraction is engineering evidence, not installation or clean-machine acceptance.

| Flow | macOS 14+ arm64 | Windows 10/11 x64 | Android API 26+ arm64 |
| --- | --- | --- | --- |
| Actual final installer: native version, no Python/Office/AI worker, notices | Not run | Not run | Not run |
| Signing/notarization or publisher signature verification | Not run | Not run | Not run |
| Clean installation, upgrade, uninstall | Not run | Not run | Not run |
| Native file selection and authorized ZIP/audio access | Not run | Not run | Not run |
| Service token set/read/delete, no backup leakage | Not run | Not run | Not run |
| Listening playback using an authorized public audio fixture | Not run | Not run | Not run |
| ZIP append import; offline practice and submission | Not run | Not run | Not run |
| Explicit grading/retry through independent service; absent evidence stays ungraded | Not run | Not run | Not run |
| Offline practice with service unavailable; no import worker spawned | Not run | Not run | Not run |
| Full backup restore after replacement confirmation | Not run | Not run | Not run |
| Old data directories untouched; unsupported backup rejected | Not run | Not run | Not run |

Record Windows WebView2 and the Android OS, device ABI and system WebView version. Android file access must be verified through the native document picker and its authorized content URI. Do not infer native credential acceptance from browser mocks. Use synthetic practice data and authorized public audio; never publish credentials, databases or backups. Real grading requires an explicitly authorized provider and budget; otherwise mark its row **Blocked**.

Keep Android CI debug/test APK checks and emulator diagnostics separate from the final matrix. An x86_64 APK is an emulator diagnostic artifact, not a public release asset. An API 35 emulator pass does not establish physical-device, minimum API 26, minimum WebView or production acceptance. A debug-signed APK leaves publisher verification **unverified**. Record real-device and minimum-runtime checks against the final signed arm64 APK before claiming those results.

Record independent-service acceptance separately: deployed source/image identity, web upload selection with no model request, explicit Start import, Word/Excel conversion using its configured engine, task progress/review/retry, ZIP export and client ZIP append import. Service Office fidelity and dependency licenses require their own evidence. Client package checks cannot establish those results, and moving conversion to the service does not waive fidelity requirements.

## Execute gates against final bytes

Use the [draft workflow](../.github/workflows/release.yml) after selecting a committed candidate and matching existing tag. Install the candidate's locked client dependencies, native Cargo toolchain and existing Python 3.14+ build/check interpreter. Android also requires its pinned build toolchain and an explicitly selected SDK `aapt2`; Linux may host those checks without becoming a client release target. Python is a build/check tool and is never shipped. Supplemental notices, lockfiles and check scripts must come from that candidate's clean checkout.

For CI artifacts, `release.py stage --tag ...` selects exactly one newly built native installer. It makes a private read-only snapshot and checks those exact bytes. macOS uses a read-only DMG mount; Windows safely extracts NSIS using full 7-Zip. Those checks verify native version, run `check-bundle.py` and `check_licenses.py`, and compare generated notices with the embedded `THIRD-PARTY.txt`. Mounted and extracted resource directories must be real directories contained in that installer payload. Resource links must be relative, resolve inside the bundle and identify existing bytes; macOS `Info.plist` must be a regular file and name the expected `CFBundleExecutable`. The desktop native application must be a nonempty regular file with real parent directories inside its payload.

Android staging uses `--platform android --aapt2 /absolute/path/to/SDK/build-tools/<version>/aapt2` and the mandatory `--android-runtime-inventory /absolute/path/to/source-checked-gradle-runtime.json`. `check-apk.py` inspects the selected snapshot's binary manifest and archive: `com.practiq.android`, candidate version, minSdk 26, one `arm64-v8a` ABI with the expected ELF64 native library, and exactly `assets/bundled/build-manifest.json` plus `assets/bundled/THIRD-PARTY.txt`. It rejects unsafe archive members and embedded Python, LibreOffice or AI workers. Source-bound Cargo/npm/Maven inventories and newly generated notices must match the embedded notice bytes. The Gradle runtime inventory is passed to the license gate and bound into candidate evidence as `android-runtime-inventory.json`. No installer execution, native-library execution, model call, service spawn or signing occurs in these checks.

The ordinary Android CI staging command is:

```sh
AI_PYTHON=/absolute/path/to/python3.14
TAG=your_selected_candidate_tag
AAPT2=/absolute/path/to/SDK/build-tools/selected-version/aapt2
ANDROID_RUNTIME_INVENTORY=/absolute/path/to/source-checked-gradle-runtime.json
"$AI_PYTHON" app/scripts/release.py stage --tag "$TAG" \
  --platform android --aapt2 "$AAPT2" \
  --android-runtime-inventory "$ANDROID_RUNTIME_INVENTORY"
```

CI stages exactly one selected actual arm64 APK at `app/.build/android-final/PractiQ.apk`; an older build or emulator APK must not be selected through a broad output glob.

For final signed, stapled or otherwise replaced installers, use explicit staging below. It requires an original schema 2 client CI candidate. Older bundled-engine candidates are rejected even if their historical reports passed. Keep its original installer and complete `evidence/` directory beside `candidate.json`. The original installer must be a regular non-link file inside that directory, with real parent directories; links and redirected download directories are rejected before claiming verified asset provenance. Review its Actions origin independently; local hashes alone do not attest provenance.

## Review and publication handoff

Run from a dedicated clean candidate checkout. Desktop checks run on the installer's native platform and architecture; Android checks use the explicit SDK on a supported build/check host. Keep reports and output outside the checkout, use fresh directories for every run, and retain failed reports. The following macOS command defines every input and checks the candidate before staging:

```sh
set -eu
CANDIDATE_SHA=your_candidate_full_sha_here
TAG=your_selected_candidate_tag
AI_PYTHON=/absolute/path/to/python3.14
FINAL_INSTALLER=/absolute/path/to/exact/final-installer.dmg
FINAL_INPUTS=/absolute/path/to/fresh/final-inputs
FINAL_REPORTS=/absolute/path/to/fresh/final-reports-macos
BUILD_CANDIDATE=/absolute/path/to/original-release-macos/candidate.json
test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"
test -z "$(git status --porcelain --untracked-files=all)"
"$AI_PYTHON" app/scripts/release.py stage --tag "$TAG" \
  --installer "$FINAL_INSTALLER" --reports "$FINAL_REPORTS" \
  --build-candidate "$BUILD_CANDIDATE" \
  --output "$FINAL_INPUTS/release-macos"
```

The staging command creates fresh report/output directories and rejects existing destinations; parent directories may already exist.

For Android, define the exact final APK and SDK tool on the clean candidate checkout. The original arm64 CI candidate must retain its complete bound evidence:

```sh
set -eu
CANDIDATE_SHA=your_candidate_full_sha_here
TAG=your_selected_candidate_tag
AI_PYTHON=/absolute/path/to/python3.14
FINAL_INSTALLER=/absolute/path/to/exact/final.apk
FINAL_INPUTS=/absolute/path/to/fresh/final-inputs
FINAL_REPORTS=/absolute/path/to/fresh/final-reports-android
BUILD_CANDIDATE=/absolute/path/to/original-release-android/candidate.json
AAPT2=/absolute/path/to/SDK/build-tools/selected-version/aapt2
ANDROID_RUNTIME_INVENTORY=/absolute/path/to/source-checked-gradle-runtime.json
test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"
test -z "$(git status --porcelain --untracked-files=all)"
"$AI_PYTHON" app/scripts/release.py stage --tag "$TAG" \
  --platform android --aapt2 "$AAPT2" \
  --android-runtime-inventory "$ANDROID_RUNTIME_INVENTORY" \
  --installer "$FINAL_INSTALLER" --reports "$FINAL_REPORTS" \
  --build-candidate "$BUILD_CANDIDATE" \
  --output "$FINAL_INPUTS/release-android"
```

On Windows install full [7-Zip](https://7-zip.org/7z.html) with NSIS support; `7za` and `7zr` are insufficient. Extraction does not create uninstall registry entries or shortcuts and does not count as installation acceptance. Missing tools or unsafe payload paths fail closed. Define every PowerShell input and explicitly check native command exits:

```powershell
$ErrorActionPreference = 'Stop'
$CandidateSha = 'your_candidate_full_sha_here'
$Tag = 'your_selected_candidate_tag'
$AiPython = 'C:\absolute\path\to\python.exe'
$FinalInstaller = 'C:\absolute\path\to\exact-final-setup.exe'
$FinalReports = 'C:\absolute\path\to\fresh-final-reports-windows'
$FinalInputs = 'C:\absolute\path\to\fresh-final-inputs'
$BuildCandidate = 'C:\absolute\path\to\original-release-windows\candidate.json'
$SevenZip = (Get-Command 7z.exe -ErrorAction Stop).Source
$HeadSha = git rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $HeadSha -ne $CandidateSha) { throw 'Wrong candidate checkout' }
$Dirty = git status --porcelain --untracked-files=all
if ($LASTEXITCODE -ne 0 -or $Dirty) { throw 'Candidate checkout must be clean' }
& $AiPython app/scripts/release.py stage --tag $Tag --installer $FinalInstaller `
  --reports $FinalReports --build-candidate $BuildCandidate --seven-zip $SevenZip `
  --output "$FinalInputs/release-windows"
if ($LASTEXITCODE -ne 0) { throw 'Final Windows staging failed' }
```

Explicit staging first makes a private read-only installer snapshot. Resources come from that snapshot, with contained-directory checks or APK archive/identity/ABI checks shared by ordinary package checks and CI staging. It verifies application version using macOS `Info.plist`, Windows installer/application `ProductVersion`, or the Android binary manifest's `versionName`, including prerelease suffixes. Windows PE headers must identify an executable application with the executable flag set and DLL flag clear. It requires the retained schema 2 practice-client metadata and scans the whole application payload for embedded Python, LibreOffice or AI workers. Cargo/npm inventories, plus Maven on Android, must have complete source-bound license texts; freshly generated combined notices must match embedded bytes.

Raw reports remain private in `FINAL_REPORTS`. A separate public evidence copy replaces absolute machine paths, including paths embedded in commands, before hashing. Review that sanitized copy before publication. Failed checks leave diagnostic reports and never produce public staged assets. Source HEAD/status and installer snapshot hashes are rechecked before delivery. No Actions environment variables are needed for explicit staging.

Both ordinary CI staging and explicit final staging fingerprint the complete selected payload before gates, after gates and before asset handoff. A change to bytes, modes, file types, directory membership or link targets blocks staging even if the read-only installer snapshot remains unchanged. For Android, the full immutable APK is bound by SHA-256 and the fingerprint supplements its temporary metadata extraction. This detects changed final content; it does not attest that a package is safe to execute. Public report redaction covers `file:` URIs and JSON keys as well as absolute paths, preserves normal HTTP(S) path namespaces while continuing to redact query-local paths and known machine roots, and uses deterministic numbered suffixes to retain every value when redacted keys collide without overwriting existing literal keys. `FINAL_REPORTS/original-candidate.json` preserves the exact original CI candidate bytes, including formatting. If redaction would change any decoded original field or key, staging fails and leaves that raw file private. Otherwise those exact bytes are archived as `evidence/original-candidate.json`, identified by the provenance wrapper's `originalCandidate` and verified against its `candidateSha256`. Assembly also requires the decoded original to equal the nested candidate and checks the final archive entry hash. A sanitized or reformatted replacement is not the original candidate. Original candidate parsing rejects duplicate keys at every depth, including harmless duplicates and escaped equivalent names, so overwritten decoded values cannot conceal private content in the exact public bytes. Rejection preserves the original private input or already retained raw report and blocks public staging or assembly; ordinary report parsing is unchanged.

Archive signing verification independently: exact artifact SHA-256, expected publisher identity, commands and results. An independent JSON report must contain a complete 64-hex `artifactSha256` matching the final installer; hexadecimal case does not change identity. Its required `status` is `verified`, `unsigned` or `failed`. For a `verified` declaration, independent publication review must require `identity` identifying the expected and observed publisher, the exact `verificationCommands`, and their `verificationResults`, all bound to that same final artifact SHA-256. A declared status alone is insufficient for verified acceptance. These audit fields are optional for `unsigned` or `failed` reports; retain them when available. The metadata parser checks the artifact/status binding; it does not enforce this independent audit policy or establish that the commands ran. Pass `--signing-report /absolute/path/to/actual-signing-report.json` to retain it as bound evidence. Candidate and assembled manifest preserve the report declaration as `externally_reported_verified`, `externally_reported_unsigned` or `externally_reported_failed`; without a report, final staging records **unverified**. The script rejects mismatched artifact hashes, unknown statuses and report/manifest status drift; it does not execute verification or attest the supplied report. The original build candidate must be the unsigned desktop or debug/test Android CI output, never an earlier restaging. Source checkout identity alone cannot prove installer build provenance. Without the acceptance reports below, manual and live acceptance remain **pending**.

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
  "components": {"desktop": "<desktop-version>", "aiServiceSource": "<independent-service-source-version>"},
  "os": "<macos-or-windows-or-android>",
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
  "components": {"desktop": "<desktop-version>", "aiServiceSource": "<independent-service-source-version>"},
  "os": "<macos-or-windows-or-android>",
  "architecture": "<arm64-or-x64>",
  "status": "<passed-or-failed>",
  "reviewedBy": "<actual-reviewer-identity>",
  "verificationResults": ["<actual separately deployed service parsing and explicit client grading results and human review>"]
}
```

Each file is at most 1 MiB. Only the required fields shown and optional `verificationCommands`, `limitations`, `reviewedAt`, and `osVersion` are accepted. `verificationResults` must contain 1–128 nonempty strings; optional command and limitation lists contain at most 128. Every string in those lists and reviewer/OS/time metadata is bounded to 8192 characters. Review all content for credentials and personal data before supplying it. Add `--clean-machine-report /absolute/path/to/actual-clean-machine.json` and `--live-model-report /absolute/path/to/actual-live-model.json` to the explicit final staging command. These flags do not call a model or authorize publication.

Staging retains the raw records privately in the fresh reports directory and creates sanitized public copies as `evidence/clean-machine-report.json` and `evidence/live-model-report.json`. `cleanMachineAcceptance` and `liveModelAcceptance` become `externally_reported_passed` or `externally_reported_failed` according to the corresponding bound report; a missing report remains `pending`. Assembly revalidates the schema, identity, fixed contained report path, status and archived bytes. The release remains a draft with independent signing and acceptance review pending, including when both reports declare success. If final signing/repackaging changes the installer bytes or candidate identity, the prior reports cannot be reused for that different artifact.

After macOS arm64, Windows x64 and Android arm64 package gates pass, copy source-aligned independent service verification reports into `FINAL_INPUTS/service-checks`. Assemble into a new directory:

```sh
FINAL_ASSETS=/absolute/path/to/fresh/final-assets
"$AI_PYTHON" app/scripts/release.py assemble --tag "$TAG" \
  --inputs "$FINAL_INPUTS" --output "$FINAL_ASSETS"
```

Assembly requires schema 2 practice-client candidates in one mode: all original CI candidates or all explicitly restaged final-byte candidates. It rejects mixed modes, old embedded-engine candidates, drifted source/versions, changed installers, missing evidence and altered notices before creating output. Android x86_64 diagnostics and Linux client assets cannot fill a release target. Assembly uses a private output directory and verifies copied installer size/hash plus every archived candidate, platform report and service report against its captured identity before handing off output. It regenerates `release-manifest.json`, `release-evidence.zip` and `SHA256SUMS.txt`; these are local draft assets, not publication or final-release acceptance under #91.

Complete the [release template](../.github/RELEASE_TEMPLATE.md) with actual per-platform signing, installation, grading and independent service evidence. Verify every downloaded attachment against its size/hash. Link the chosen main candidate and immutable evidence before closing #91. Test-version deferrals must remain explicit under the [release policy](releases.md). This worksheet supplies no signing credentials, target systems or live-model acceptance.

Feature delivery follows the issue-specific implementation, test, CI and review gates in [#130](https://github.com/shenyankm/PractiQ/issues/130) and [#131](https://github.com/shenyankm/PractiQ/issues/131), independently of #91 final-release acceptance. The independent-service implementation was delivered by [merged PR #132](https://github.com/shenyankm/PractiQ/pull/132); follow [PR #133](https://github.com/shenyankm/PractiQ/pull/133) for Android implementation and validation status. Closing an implementation issue does not establish signed final installers, clean-machine acceptance or live-model quality, and does not authorize model calls or publication.
