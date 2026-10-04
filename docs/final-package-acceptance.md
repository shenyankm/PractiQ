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
| Full backup restore after replacement confirmation | Not run | Not run | Not run |
| Old data directories untouched; unsupported backup rejected | Not run | Not run | Not run |
| No system Python/Office discovery | Not run | Not run | Not run |

Record Windows WebView2 and Linux WebView/audio libraries plus unlocked Secret Service. Do not infer native credential acceptance from a browser mock. Use isolated synthetic data and an authorized public audio fixture; do not publish local databases, credentials, raw user material or backups.

## Execute existing gates against final bytes

Use the existing [draft workflow](../.github/workflows/release.yml) and [contribution checks](../CONTRIBUTING.md#validate-the-change) after an explicit candidate/tag decision. The workflow runs strict package gates against the mounted DMG, installed NSIS app and extracted DEB; ordinary CI remains engineering evidence only.

After final signing or repackaging, mount/install/extract the exact final installer again, select its `bundled` directory and run from repository root with an existing Python 3.14+ interpreter:

```sh
AI_PYTHON=/absolute/path/to/python3.14
BUNDLE=/absolute/path/to/final/package/bundled
REPORT_DIR=/absolute/path/to/fresh/evidence-directory
mkdir -p "$REPORT_DIR"
"$AI_PYTHON" app/scripts/check-bundle.py --bundle "$BUNDLE" --output "$REPORT_DIR/desktop-bundle.json"
"$AI_PYTHON" app/scripts/check-office.py --isolated --bundle "$BUNDLE" --output "$REPORT_DIR/office.json"
"$AI_PYTHON" app/scripts/check-office.py --fidelity-only --bundle "$BUNDLE" --output "$REPORT_DIR/office-fidelity.json"
"$AI_PYTHON" app/scripts/check_licenses.py --bundle "$BUNDLE" --output "$REPORT_DIR/licenses.json"
```

Keep failed reports. Use a fresh evidence directory because reports must not overwrite accepted or failed runs. A failed strict gate blocks release acceptance. On Windows use the README PowerShell equivalents and quote native paths; the shell example above is for macOS/Linux.

## Review and publication handoff

Follow the existing [signing and final acceptance](releases.md#final-signing-and-acceptance) procedures; do not relabel an earlier unsigned DMG. Verify all six desktop versions using `app/scripts/release.py`, regenerate build/release manifests, evidence ZIP and checksums after any final-byte change, then download staged assets and check each hash. Complete every field in the [release template](../.github/RELEASE_TEMPLATE.md) with actual per-platform evidence and unresolved limitations.

Before closing #91 link the selected main candidate, immutable reports, actual final installer hashes, native clean-machine records and verified signing status. Test-version deferrals must follow existing policy and remain visible. Signing credentials, target systems, final candidate and live evidence are still required from maintainers; this preparation PR provides none of those external acceptances.
