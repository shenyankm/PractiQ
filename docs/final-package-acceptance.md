# Final-package acceptance record

Tracks [#91](https://github.com/shenyankm/PractiQ/issues/91). Preparation reviewed on 2026-10-04 at main `2e9215f59920a7e2f7d9bf9b64ff61b6d1f6ccd7`. Desktop component versions are `0.1.0`; a permitted matching tag and final release candidate have not been selected in this PR. Keep #91 open until final artifacts and evidence meet the [release policy](releases.md). This worksheet does not authorize tag creation, paid calls, secret changes or publication.

## Candidate identity

Fill these fields once the pending implementation PRs merge. Use one clean main commit and retain the value in every platform report; reselecting the source or signing/repackaging invalidates earlier artifact hashes.

| Field | Required value / current evidence |
| --- | --- |
| Source SHA / tag / desktop version | Pending; six npm/Tauri/Cargo version entries must match the tag |
| AI service / Python / pinned Office versions | Read from final build manifest; development runtime versions are insufficient |
| Build URL / OS / architecture / date | One record per final platform installer |
| Installer path / bytes / SHA-256 | Calculate after all signing, notarization, stapling and packaging |
| Signing / identity / verification command | Pending; record unsigned explicitly when applicable |
| Final-package reports | Fresh bundle, isolated Office, fidelity and license-source outputs |
| Live quality / failure-injection reports | Pending; separate model authorization and source-aligned review required |
| Reviewed release evidence / asset downloads | Pending; all download sizes and hashes must match SHA256SUMS |

## Platform evidence matrix

Use **Passed**, **Failed**, **Blocked**, or **Not run**, with a report or reason for each cell. No clean-machine runs or signing evidence are recorded by this PR.

| Flow | macOS 14+ arm64 | Windows 10/11 x64 | Ubuntu 22.04+ amd64 |
| --- | --- | --- | --- |
| Actual final installer + bundled service/Office checks | Not run | Not run | Not run |
| Signing/notarization or package signature verification | Not run | Not run | Not run |
| Clean installation, upgrade, uninstall | Not run | Not run | Not run |
| Native open/save dialogs and authorized file access | Not run | Not run | Not run |
| Credential set/read/delete, no backup leakage | Not run | Not run | Not run |
| Listening playback using a supplied public audio fixture | Not run | Not run | Not run |
| ZIP append import; offline practice and submission | Not run | Not run | Not run |
| Installed UI source import: native selection, explicit Start import, task progress/review, then bank import | Not run | Not run | Not run |
| Installed UI Word/Excel import using bundled conversion before the same task/review flow | Not run | Not run | Not run |
| File selection and standalone Office conversion make no model calls | Not run | Not run | Not run |
| Full backup restore after replacement confirmation | Not run | Not run | Not run |
| Old data directories untouched; unsupported backup rejected | Not run | Not run | Not run |
| No system Python/Office discovery | Not run | Not run | Not run |

Record Windows WebView2 and Linux WebView/audio libraries plus unlocked Secret Service. Do not infer native credential acceptance from a browser mock. Use isolated synthetic data and an authorized public audio fixture; do not publish local databases, credentials, raw user material or backups.

For source import, use a synthetic PDF, TXT, CSV or PNG/JPEG fixture through the installed **Import** page. Select it with the native picker, confirm selection alone sends no model request, then explicitly choose **Start import**. Record task progress, any review/retry boundary, and the final bank import. Repeat with synthetic Word and Excel sources to exercise the packaged Office worker. ZIP append import and scripts that call the sidecar directly do not establish this desktop flow. Use a provider and cost budget already authorized for this acceptance run; otherwise mark these model-dependent rows **Blocked**. The explicit **Start import** action authorizes conversion and submission without a second confirmation. Standalone conversion needs no model configuration and must send no model request.

## Execute existing gates against final bytes

Use the existing [draft workflow](../.github/workflows/release.yml) and [contribution checks](../CONTRIBUTING.md#validate-the-change) after an explicit candidate/tag decision. The workflow runs strict package gates against the mounted DMG, installed NSIS app and extracted DEB; ordinary CI remains engineering evidence only.

Run the checks from a dedicated, clean checkout of the recorded candidate's full source SHA. Install that candidate's locked dependencies using the [contribution guide](../CONTRIBUTING.md#validate-the-change); the checks read checkout fixtures, locks and supplemental notices. Use a native checkout and toolchain matching the final artifact's platform and architecture. Keep evidence outside the checkout, and record the checkout SHA alongside every platform report directory.

After final signing or repackaging, mount/install/extract the exact final installer again. Select its `bundled` directory; on macOS this is inside the mounted app's `Contents/Resources`, and in an extracted DEB it is `usr/lib/PractiQ/bundled`. The following macOS/Linux setup stops on a wrong SHA, a dirty checkout or an existing evidence directory:

```sh
set -eu
CANDIDATE_SHA=your_candidate_full_sha_here
test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"
CHECKOUT_STATUS=$(git status --porcelain)
test -z "$CHECKOUT_STATUS"
AI_PYTHON=/absolute/path/to/python3.14
BUNDLE=/absolute/path/to/final/package/bundled
REPORT_DIR=/absolute/path/to/fresh/evidence-directory
mkdir -p "$(dirname "$REPORT_DIR")"
mkdir "$REPORT_DIR"
printf '%s\n' "$CANDIDATE_SHA" > "$REPORT_DIR/source-sha.txt"
```

Run all four gates and compare freshly generated notices with the file shipped in the final bundle:

```sh
"$AI_PYTHON" app/scripts/check-bundle.py --bundle "$BUNDLE" --output "$REPORT_DIR/desktop-bundle.json"
"$AI_PYTHON" app/scripts/check-office.py --isolated --bundle "$BUNDLE" --output "$REPORT_DIR/office.json"
"$AI_PYTHON" app/scripts/check-office.py --fidelity-only --bundle "$BUNDLE" --output "$REPORT_DIR/office-fidelity.json"
"$AI_PYTHON" app/scripts/check_licenses.py --bundle "$BUNDLE" --output "$REPORT_DIR/licenses.json" --notices "$REPORT_DIR/expected-THIRD-PARTY.txt"
cp "$BUNDLE/THIRD-PARTY.txt" "$REPORT_DIR/shipped-THIRD-PARTY.txt"
cmp "$REPORT_DIR/expected-THIRD-PARTY.txt" "$BUNDLE/THIRD-PARTY.txt"
printf '%s\n' 'Passed: embedded THIRD-PARTY.txt matches candidate notices' > "$REPORT_DIR/notices-match.txt"
```

The license inventory alone does not check the combined `THIRD-PARTY.txt` shipped to users. A missing or changed bundle notice must fail the comparison. Retain both expected and shipped notices with the reports. Keep failed reports; use a new evidence directory for each rerun. A failed gate or notice comparison blocks acceptance.

On Windows, run PowerShell from the candidate checkout root after installing its locked dependencies. Select an existing Python 3.14+ interpreter and the exact final signed or explicitly unsigned NSIS installer. The [desktop workflow's installed-package step](../.github/workflows/desktop.yml) uses the same `/S` and `/D=` installation arguments. Choose a fresh install destination and evidence directory:

```powershell
$ErrorActionPreference = 'Stop'
$CandidateSha = 'your_candidate_full_sha_here'
$HeadSha = git rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $HeadSha -ne $CandidateSha) { throw 'Wrong candidate checkout' }
$Dirty = git status --porcelain
if ($LASTEXITCODE -ne 0 -or $Dirty) { throw 'Candidate checkout must be clean' }
$AiPython = 'C:\absolute\path\to\python.exe'
$Installer = 'C:\absolute\path\to\final-setup.exe'
$Destination = 'C:\absolute\path\to\fresh-install'
$ReportDir = 'C:\absolute\path\to\fresh-evidence'
if ((Test-Path $Destination) -or (Test-Path $ReportDir)) { throw 'Choose fresh directories' }
New-Item -ItemType Directory -Force -Path (Split-Path $ReportDir) | Out-Null
New-Item -ItemType Directory -Path $ReportDir | Out-Null
$CandidateSha | Set-Content (Join-Path $ReportDir 'source-sha.txt')
$Install = Start-Process -FilePath $Installer -ArgumentList '/S', "/D=$Destination" -Wait -PassThru
if ($Install.ExitCode -ne 0) { throw "Installer failed: $($Install.ExitCode)" }
$Bundle = Join-Path $Destination 'bundled'
```

Run the four checks with explicit failure handling, then compare notice hashes. PowerShell's error preference alone does not reject every failed native command:

```powershell
& $AiPython app/scripts/check-bundle.py --bundle $Bundle --output "$ReportDir/desktop-bundle.json"
if ($LASTEXITCODE -ne 0) { throw 'Final bundle check failed' }
& $AiPython app/scripts/check-office.py --isolated --bundle $Bundle --output "$ReportDir/office.json"
if ($LASTEXITCODE -ne 0) { throw 'Isolated Office check failed' }
& $AiPython app/scripts/check-office.py --fidelity-only --bundle $Bundle --output "$ReportDir/office-fidelity.json"
if ($LASTEXITCODE -ne 0) { throw 'Office fidelity check failed' }
& $AiPython app/scripts/check_licenses.py --bundle $Bundle --output "$ReportDir/licenses.json" --notices "$ReportDir/expected-THIRD-PARTY.txt"
if ($LASTEXITCODE -ne 0) { throw 'License-source check failed' }
Copy-Item -LiteralPath "$Bundle/THIRD-PARTY.txt" -Destination "$ReportDir/shipped-THIRD-PARTY.txt"
$Expected = (Get-FileHash "$ReportDir/expected-THIRD-PARTY.txt" -Algorithm SHA256).Hash
$Shipped = (Get-FileHash "$Bundle/THIRD-PARTY.txt" -Algorithm SHA256).Hash
if ($Expected -ne $Shipped) { throw 'Embedded third-party notices differ' }
'Passed: embedded THIRD-PARTY.txt matches candidate notices' | Set-Content "$ReportDir/notices-match.txt"
```

Record the final installer size and SHA-256 in the candidate table. Archive the notice comparison result and both notice files with each platform's evidence. These commands do not perform signing, live-model evaluation or clean-machine UI acceptance.

## Review and publication handoff

Follow the existing [signing and final acceptance](releases.md#final-signing-and-acceptance) procedures; do not relabel an earlier unsigned DMG. The default `release.py stage --tag ...` command discovers unsigned CI build output. For a signed, stapled or otherwise replaced installer, explicitly select the final file with the same candidate checkout and native platform:

```sh
TAG=your_selected_candidate_tag
FINAL_INSTALLER=/absolute/path/to/exact/final-installer.dmg
FINAL_INPUTS=/absolute/path/to/fresh/final-inputs
FINAL_REPORTS=/absolute/path/to/fresh/final-reports-macos
BUILD_CANDIDATE=/absolute/path/to/original-release-macos/candidate.json
"$AI_PYTHON" app/scripts/release.py stage --tag "$TAG" \
  --installer "$FINAL_INSTALLER" --reports "$FINAL_REPORTS" \
  --build-candidate "$BUILD_CANDIDATE" \
  --output "$FINAL_INPUTS/release-macos"
```

Use the corresponding original platform candidate downloaded from the immutable CI run. Keep its original installer and complete `evidence/` directory beside `candidate.json`. The original installer must be a regular non-link file inside that directory, with real parent directories; links and redirected download directories are rejected before claiming verified asset provenance. Staging checks the original tag, source SHA, component versions, platform, asset bytes and evidence hashes, preserves the build URL, and archives the original candidate identity. Review the download's Actions provenance independently; matching local hashes cannot attest its origin.

On Windows, use an installed full [7-Zip](https://7-zip.org/7z.html) with NSIS support. `7za` and `7zr` are insufficient. Define the values before staging; `$FinalReports` must be fresh and must not reuse the already populated `$ReportDir`:

```powershell
$Tag = 'your_selected_candidate_tag'
$FinalInstaller = $Installer
$FinalReports = 'C:\absolute\path\to\fresh-final-reports-windows'
$FinalInputs = 'C:\absolute\path\to\fresh-final-inputs'
$BuildCandidate = 'C:\absolute\path\to\original-release-windows\candidate.json'
$SevenZip = (Get-Command 7z.exe -ErrorAction Stop).Source
& $AiPython app/scripts/release.py stage --tag $Tag --installer $FinalInstaller `
  --reports $FinalReports --build-candidate $BuildCandidate --seven-zip $SevenZip `
  --output "$FinalInputs/release-windows"
if ($LASTEXITCODE -ne 0) { throw 'Final Windows staging failed' }
```

Run the equivalent command on each native target, using the final NSIS `.exe` or DEB `.deb`, matching original build candidate and distinct `release-windows` or `release-linux` output folders. Explicit staging copies the selected installer to a private read-only snapshot, mounts that DMG, extracts the NSIS payload with 7-Zip, or extracts that DEB. It never executes the Windows installer or creates uninstall entries and shortcuts. Payload extraction is engineering evidence; installed UI and clean-machine acceptance still require the platform matrix above. Missing 7-Zip or unsafe payload paths block staging.

Staging compares the actual desktop version from macOS `Info.plist`, Windows installer and application `ProductVersion`, or DEB control `Version` with the complete candidate version, including any prerelease suffix. Windows PE headers must identify an executable application with the executable flag set and DLL flag clear. DEB control `Package` must match the Tauri product name's kebab-case identity (`PractiQ` becomes `practi-q`), alongside the architecture and dependency checks. It derives the bundle from those selected bytes, reruns all four strict gates and compares embedded notices. It retains raw reports privately in `FINAL_REPORTS`; the public evidence copy replaces absolute machine paths before calculating evidence hashes. Review all public evidence before publication. Failed reports remain available, and output assets appear only after source, version, provenance and artifact checks pass. Existing report or output directories are rejected; no Actions environment variables are required.

Both ordinary CI staging and explicit final staging fingerprint the complete selected payload before gates, after gates and before asset handoff. A change to bytes, modes, file types, directory membership or link targets blocks staging even if the read-only installer snapshot remains unchanged. This detects changed final content; it does not attest that a package is safe to execute. Public report redaction covers `file:` URIs and JSON keys as well as absolute paths, preserves normal HTTP(S) path namespaces while continuing to redact query-local paths and known machine roots, and uses deterministic numbered suffixes to retain every value when redacted keys collide without overwriting existing literal keys. `FINAL_REPORTS/original-candidate.json` preserves the exact original unsigned candidate bytes, including formatting. If redaction would change any decoded original field or key, staging fails and leaves that raw file private. Otherwise those exact bytes are archived as `evidence/original-candidate.json`, identified by the provenance wrapper's `originalCandidate` and verified against its `candidateSha256`. Assembly also requires the decoded original to equal the nested candidate and checks the final archive entry hash. A sanitized or reformatted replacement is not the original candidate. Original candidate parsing rejects duplicate keys at every depth, including harmless duplicates and escaped equivalent names, so overwritten decoded values cannot conceal private content in the exact public bytes. Rejection preserves the original private input or already retained raw report and blocks public staging or assembly; ordinary report parsing is unchanged.

Record actual signing verification separately, including the final installer SHA-256, expected publisher identity, exact verification commands and their sanitized results. Retain an independent JSON report with a complete 64-hex `artifactSha256` matching that final file; uppercase and lowercase hexadecimal identify the same bytes. Its required `status` is `verified`, `unsigned` or `failed`; it may also record `identity`, `verificationCommands` and `verificationResults`. Add `--signing-report /absolute/path/to/actual-signing-report.json` to explicit staging to archive it as `evidence/signing-report.json`. The candidate and assembled manifest record `externally_reported_verified`, `externally_reported_unsigned` or `externally_reported_failed`, preserving the report's declaration for those exact bytes. Without a report, final staging records **unverified**. The tool rejects mismatched hashes, unknown statuses and manifest/report status drift; it does not execute cryptographic signing verification or attest the supplied report's truth. Review the signing evidence independently before publication. The original `--build-candidate` must be the unsigned CI output, never an earlier restaging. The staging checkout SHA identifies the check inputs and cannot by itself prove the installer was built from that commit. Without the acceptance reports below, manual and live-model acceptance remain **pending**.

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
  "components": {"desktop": "<desktop-version>", "aiService": "<service-version>"},
  "os": "<macos-or-windows-or-linux>",
  "architecture": "<arm64-or-x64-or-amd64>",
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
  "components": {"desktop": "<desktop-version>", "aiService": "<service-version>"},
  "os": "<macos-or-windows-or-linux>",
  "architecture": "<arm64-or-x64-or-amd64>",
  "status": "<passed-or-failed>",
  "reviewedBy": "<actual-reviewer-identity>",
  "verificationResults": ["<actual frozen-source parsing/grading results and human review>"]
}
```

Each file is at most 1 MiB. Only the required fields shown and optional `verificationCommands`, `limitations`, `reviewedAt`, and `osVersion` are accepted. `verificationResults` must contain 1–128 nonempty strings; optional command and limitation lists contain at most 128. Every string in those lists and reviewer/OS/time metadata is bounded to 8192 characters. Review all content for credentials and personal data before supplying it. Add `--clean-machine-report /absolute/path/to/actual-clean-machine.json` and `--live-model-report /absolute/path/to/actual-live-model.json` to the explicit final staging command. These flags do not call a model or authorize publication.

Staging retains the raw records privately in the fresh reports directory and creates sanitized public copies as `evidence/clean-machine-report.json` and `evidence/live-model-report.json`. `cleanMachineAcceptance` and `liveModelAcceptance` become `externally_reported_passed` or `externally_reported_failed` according to the corresponding bound report; a missing report remains `pending`. Assembly revalidates the schema, identity, fixed contained report path, status and archived bytes. The release remains a draft with independent signing and acceptance review pending, including when both reports declare success. If final signing/repackaging changes the installer bytes or candidate identity, the prior reports cannot be reused for that different artifact.

After collecting all three new platform candidates, copy the service verification reports for that same source into `FINAL_INPUTS/service-checks` as required by the existing workflow, then assemble into another fresh directory:

```sh
FINAL_ASSETS=/absolute/path/to/fresh/final-assets
"$AI_PYTHON" app/scripts/release.py assemble --tag "$TAG" \
  --inputs "$FINAL_INPUTS" --output "$FINAL_ASSETS"
```

Assembly requires a consistent staging mode across all three platforms: either all original unsigned CI candidates or all explicitly restaged final-byte candidates. It rejects a mixed set before creating output assets. Assembly verifies candidate source, installer and evidence hashes, then regenerates `release-manifest.json`, `release-evidence.zip` and `SHA256SUMS.txt` from the selected final bytes. It creates local draft assets; it does not publish or complete #91. Complete every field in the [release template](../.github/RELEASE_TEMPLATE.md) with actual per-platform signing evidence, acceptance results and unresolved limitations, then download staged assets and check each hash.

Before closing #91 link the selected main candidate, immutable reports, actual final installer hashes, native clean-machine records and verified signing status. Test-version deferrals must follow existing policy and remain visible. Signing credentials, target systems, final candidate and live evidence are still required from maintainers; this preparation PR provides none of those external acceptances.
