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

Follow the existing [signing and final acceptance](releases.md#final-signing-and-acceptance) procedures; do not relabel an earlier unsigned DMG. Verify all six desktop versions using `app/scripts/release.py`, regenerate build/release manifests, evidence ZIP and checksums after any final-byte change, then download staged assets and check each hash. Complete every field in the [release template](../.github/RELEASE_TEMPLATE.md) with actual per-platform evidence and unresolved limitations.

Before closing #91 link the selected main candidate, immutable reports, actual final installer hashes, native clean-machine records and verified signing status. Test-version deferrals must follow existing policy and remain visible. Signing credentials, target systems, final candidate and live evidence are still required from maintainers; this preparation PR provides none of those external acceptances.
