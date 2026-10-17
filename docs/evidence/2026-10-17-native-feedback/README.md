# Native feedback and compact error layout acceptance

Screenshot files were removed on October 17, 2026 during repository cleanup. The results below describe the original acceptance. Logs, measurements and original hash manifests are retained as historical records; screenshot entries in those manifests no longer identify available files. Current product screenshots remain in the root README files.

Captured on 2026-10-17 from the worktree based on `a430f7e`, with the changes in this pull request applied. These are development acceptance records, not release-package or clean-machine certification. All bank content and Web account values shown are synthetic.

## Evidence

| Flow | Environment and result | Original capture |
| --- | --- | --- |
| Damaged question-bank ZIP import | macOS WKWebView, actual system file picker and Tauri command; the persistent summary stays below the page heading and aligns with the Settings cards | Collapsed error |
| ZIP diagnostic disclosure and copy | macOS native command returns the EOCD diagnostic; the summary appears once and the actual clipboard action reports success | Expanded diagnostic |
| Long workspace diagnostic | Chromium at 1280px, synthetic native transport failure; aligned panel, bounded scrolling and visible keyboard focus | Desktop |
| Narrow workspace diagnostic | Chromium at 360px in dark mode; no horizontal page overflow, keyboard scrolling and copy feedback remain usable | Narrow |
| Import Web read failure | Chromium at 1280px with a synthetic authenticated HTTP failure; retry remains explicit and creates no business mutation | Desktop Web |
| Narrow Web read failure | Chromium at 360px; the retry control wraps below the message rather than squeezing it | Narrow Web |
| Menu-opened bank editor cancellation | macOS WKWebView; closing restores the persistent bank-menu trigger | Cancel focus |
| Bank editor save | macOS native SQLite write; the replaced list trigger falls back to the surviving page heading | Save focus |
| Lazy-view failure | macOS WKWebView with a temporary development-only module-load fault; close and reload remain available | Local fallback |
| Root render failure | macOS WKWebView with a temporary development-only render fault; saved-data and unsaved-input guidance remains visible | Root fallback |

The four focus/fallback captures were taken during the earlier native acceptance stage, before the compact error-panel refinement. The six error-layout captures document the subsequent refinement. The temporary fault flags were removed before returning to the normal development runtime. No fault-injection hooks are shipped in this pull request.

The native App uses a separate QA identifier and isolated schema-11 practice database. Its business IPC and SQLite storage are real. Browser fixtures replace native transport or same-origin HTTP; they do not establish native storage, credentials, or live-service acceptance.

## Validation

- App: types, lint, coverage and production build passed. The final component run passed 415 tests, with one existing optional benchmark skipped.
- App: the full browser run passed 77 tests. After the submission review fixed stale diagnostic-copy feedback, the targeted desktop/narrow error-layout checks were rerun.
- Web: types, lint, coverage and production build passed; 115 component tests and 34 existing browser tests passed. The two added error/retry layout cases also passed separately.
- macOS: focused ZIP and language integration tests, Rust formatting and Clippy are recorded separately from browser acceptance.
- At acceptance, the original local PR #253 records (58 files, including 25 screenshots) and previous native acceptance records (54 files, including 27 screenshots) were SHA-256 verified unchanged. Screenshot files were subsequently removed in the cleanup described above.

`manifest.json` records the original SHA-256 of each removed screenshot. Full local logs and accessibility snapshots remain under the ignored App/Web `.build/` directories; generated build outputs and local databases are not committed.

Windows/Android native manual acceptance, release installers, live model/payment calls, OS permission-denial branches and a full screen-reader pass were not performed locally. GitHub CI results are reported on the pull request separately from these local captures.
