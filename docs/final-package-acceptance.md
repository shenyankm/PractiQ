# Final-package acceptance record

Tracks [#91](https://github.com/shenyankm/PractiQ/issues/91) under the independent-service architecture in [#130](https://github.com/shenyankm/PractiQ/issues/130). Desktop artifacts deliver offline practice and ZIP import. AI source import and Office conversion belong to the independent service and its web frontend; explicit desktop grading calls that service over HTTP. Historical embedded-engine packages and reports remain preserved and cannot establish acceptance of this architecture. No final candidate, signing, clean-machine or live-model acceptance is recorded by this worksheet.

## Candidate identity

Use one clean main commit and retain its SHA in every platform record. Signing, repackaging or reselecting source invalidates earlier artifact hashes.

| Field | Required value / current evidence |
| --- | --- |
| Source SHA / tag / desktop version | Pending; six npm/Tauri/Cargo version entries must match the tag |
| Desktop package schema / mode | `schemaVersion: 2`, `packageMode: desktop-practice`; actual native version must match |
| Independent AI service source version | Separate version from tagged source; desktop artifacts do not deploy that service |
| Build URL / OS / architecture / date | Original immutable CI build candidate plus independent provenance review |
| Installer path / bytes / SHA-256 | Calculate after all signing, notarization, stapling and packaging |
| Signing / identity / verification command | Pending; record unsigned explicitly when applicable |
| Desktop package evidence | Native version, engine absence, metadata, Cargo/npm licenses and byte-exact embedded notices |
| Service deployment / import / grading evidence | Separate service identity, configured Office engine and authorized live checks |
| Reviewed release evidence / downloads | Pending; download sizes and hashes must match SHA256SUMS |

## Platform evidence matrix

Use **Passed**, **Failed**, **Blocked**, or **Not run**, with evidence or a reason in every cell. Payload extraction is engineering evidence, not installation or clean-machine acceptance.

| Flow | macOS 14+ arm64 | Windows 10/11 x64 | Ubuntu 22.04+ amd64 |
| --- | --- | --- | --- |
| Actual final installer: native version, no Python/Office/AI worker, notices | Not run | Not run | Not run |
| Signing/notarization or package signature verification | Not run | Not run | Not run |
| Clean installation, upgrade, uninstall | Not run | Not run | Not run |
| Native open/save dialogs and authorized ZIP/audio access | Not run | Not run | Not run |
| Service token set/read/delete, no backup leakage | Not run | Not run | Not run |
| Listening playback using an authorized public audio fixture | Not run | Not run | Not run |
| ZIP append import; offline practice and submission | Not run | Not run | Not run |
| Explicit grading/retry through independent service; absent evidence stays ungraded | Not run | Not run | Not run |
| Offline practice with service unavailable; no import worker spawned | Not run | Not run | Not run |
| Full backup restore after replacement confirmation | Not run | Not run | Not run |
| Old data directories untouched; unsupported backup rejected | Not run | Not run | Not run |

Record Windows WebView2 and Linux WebView/audio libraries plus unlocked Secret Service. Do not infer native credential acceptance from browser mocks. Use synthetic practice data and authorized public audio; never publish credentials, databases or backups. Real grading requires an explicitly authorized provider and budget; otherwise mark its row **Blocked**.

Record independent-service acceptance separately: deployed source/image identity, web upload selection with no model request, explicit Start import, Word/Excel conversion using its configured engine, task progress/review/retry, ZIP export and desktop ZIP append import. Service Office fidelity and dependency licenses require their own evidence. Desktop package checks cannot establish those results, and moving conversion to the service does not waive fidelity requirements.

## Execute gates against final bytes

Use the [draft workflow](../.github/workflows/release.yml) after selecting a committed candidate and matching existing tag. Install the candidate's locked desktop dependencies, native Cargo toolchain and existing Python 3.14+ build/check interpreter on each native platform. Python is a build/check tool and is never shipped. Supplemental notices, lockfiles and check scripts must come from that candidate's clean checkout.

For unsigned CI artifacts, `release.py stage --tag ...` selects exactly one newly built native installer. It makes a private read-only snapshot, extracts those exact bytes, verifies the native version, runs `check-bundle.py` and `check_licenses.py`, and compares generated notices with the embedded `THIRD-PARTY.txt`. macOS uses a read-only DMG mount; Linux extracts the DEB; Windows safely extracts NSIS using full 7-Zip. DEB metadata must declare amd64 and every required native runtime dependency. Mounted and extracted resource directories must be real directories contained in that installer payload. Resource links must be relative, resolve inside the bundle and identify existing bytes; macOS `Info.plist` must be a regular file. No installer execution, model call, service spawn or signing occurs in these checks.

For final signed, stapled or otherwise replaced installers, use explicit staging below. It requires an original schema 2 desktop CI candidate. Older bundled-engine candidates are rejected even if their historical reports passed. Keep its original installer and complete `evidence/` directory beside `candidate.json`. Review its Actions origin independently; local hashes alone do not attest provenance.

## Review and publication handoff

Run from a dedicated clean candidate checkout on the same platform and architecture as the installer. Keep reports and output outside the checkout, use fresh directories for every run, and retain failed reports. The following macOS/Linux command defines every input and checks the candidate before staging:

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

On Linux use the exact DEB, original `release-linux/candidate.json`, fresh Linux reports and `release-linux` output. The staging command creates fresh report/output directories and rejects existing destinations; parent directories may already exist.

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

Explicit staging first makes a private read-only installer snapshot. Resources come from that snapshot, with contained-directory and DEB architecture/dependency checks shared by ordinary package checks and CI staging. It verifies desktop version using macOS `Info.plist`, Windows installer/application `ProductVersion`, or DEB control `Version`, including prerelease suffixes. It requires pure desktop metadata and scans the entire application payload for embedded Python, LibreOffice or AI workers. The Cargo/npm inventory must have complete source-bound license texts; its freshly generated combined notices must match embedded bytes.

Raw reports remain private in `FINAL_REPORTS`. A separate public evidence copy replaces absolute machine paths, including paths embedded in commands, before hashing. Review that sanitized copy before publication. Failed checks leave diagnostic reports and never produce public staged assets. Source HEAD/status and installer snapshot hashes are rechecked before delivery. No Actions environment variables are needed for explicit staging.

Archive signing verification independently: exact artifact SHA-256, expected publisher identity, commands and results. An independent JSON report must contain a complete 64-hex `artifactSha256` matching the final installer; hexadecimal case does not change identity. It may also contain `status`, `identity`, `verificationCommands` and `verificationResults`. Pass `--signing-report /absolute/path/to/actual-signing-report.json` to retain it as bound evidence. Staging records its own signing check as **unverified** because it does not execute verification; the independently reviewed report and release template record actual signing status. Source checkout identity alone cannot prove installer build provenance. Manual and live acceptance remain **pending**.

After all three native platforms pass, copy source-aligned independent service verification reports into `FINAL_INPUTS/service-checks`. Assemble into a new directory:

```sh
FINAL_ASSETS=/absolute/path/to/fresh/final-assets
"$AI_PYTHON" app/scripts/release.py assemble --tag "$TAG" \
  --inputs "$FINAL_INPUTS" --output "$FINAL_ASSETS"
```

Assembly requires schema 2 desktop candidates in one mode: all original unsigned CI candidates or all explicitly restaged final-byte candidates. It rejects mixed modes, old embedded-engine candidates, drifted source/versions, changed installers, missing evidence and altered notices before creating output. It regenerates `release-manifest.json`, `release-evidence.zip` and `SHA256SUMS.txt`; these are local draft assets, not publication or acceptance of #91 or #130.

Complete the [release template](../.github/RELEASE_TEMPLATE.md) with actual per-platform signing, installation, grading and independent service evidence. Verify every downloaded attachment against its size/hash. Link the chosen main candidate and immutable evidence before closing #91. Test-version deferrals must remain explicit under the [release policy](releases.md). This worksheet supplies no signing credentials, target systems or live-model acceptance.
