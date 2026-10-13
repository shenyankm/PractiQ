# Current macOS native interaction and restore verification

This is behavior evidence, not an end-to-end latency measurement. An unsigned release macOS `.app` was built from the retained source with a unique application identifier, `com.practiq.perf-loop-20261013-01a13529`. The corresponding app-data namespace did not exist before launch. Only that newly created namespace and synthetic archives were accessed. The normal user identifier/data/credential namespaces were never opened. No service was configured and no model call was made.

Build command (from `app/`):

```sh
npm run tauri -- build --bundles app --no-sign --config ../docs/evidence/2026-10-13-performance-loop/ui-isolation.json
```

See `final-native-qa-build.log`, `native-qa-build.json` and `ui-isolation.json` for the build, binary hash and isolation configuration. This QA bundle deliberately has no deployment resources; it is not a distribution installer, signature/notarization or clean-machine release acceptance.

CUA interacted with the actual system WebView at `tauri://localhost`:

1. Empty initial state displayed zero banks/questions. The existing Add example bank action created one bank with 20 answerable questions.
2. Native study setup showed exact available statistics. Advanced quota selection requested one single-choice question, one true/false question and one complete reading group. The preview showed one group plus two individual questions. Starting the resulting three-question practice preserved order, supplied answers and reading material.
3. Selecting A for the prime-number example and explicitly submitting displayed the supplied reference A, correct automatic feedback and its existing explanation. Next navigated to true/false, then the reading question. View passage displayed the original Mia/library/birds material.
4. A restart preserved the three-question practice and its submitted 1/3 status. Settings reported the service as unconfigured.
5. Export backup used the native save picker and the loop's temporary directory. The completed toast identified `native-qa-backup.zip`. The manifest is backup version4/schema11 with one PNG and one WAV asset, plus the practice database. No credential/service settings were added.
6. Export bank used the native picker, producing `native-qa-bank.zip` in the same temporary directory. Settings > Restore backup > Import question-bank ZIP validated that file before the explicit import action. The review showed 20 questions, two review-required questions, no missing resources and retained material associations. Explicit confirmation appended a separate QA imported copy, preserving the original bank and practice. Its list contains18 roots representing20 answerable questions; this is group-aware counting, not dropped content.
7. Settings > Restore backup > Restore learning-data backup required replacement confirmation, described validation/recovery, then opened the native file picker. Selecting the original test backup completed with an original-data recovery path under the unique QA namespace. The imported duplicate was replaced and the original bank/practice restored.
8. After restart, the UI again displayed one bank/20 questions and the unfinished practice with1/3 submitted. Independent read-only verification proved all32 tables match the saved backup immediately after restoration and after reopening. PNG/WAV bytes, sizes and SHA-256 agree. Schema11, v4, frozen snapshots and null/type-aware rows agree.

Read-only verification commands (existing Python3.14 interpreter):

```sh
python3.14 docs/evidence/2026-10-13-performance-loop/verify_native_qa.py before-restore
python3.14 docs/evidence/2026-10-13-performance-loop/verify_native_qa.py after-restore
python3.14 docs/evidence/2026-10-13-performance-loop/verify_native_qa.py reopen
```

Actual commands used the absolute Python path in `environment.json`. Raw results are `native-qa-before-restore.json`, `native-qa-after-restore.json` and `native-qa-reopen.json`; scripts assert the fixed, newly created QA namespace and open SQLite read-only. The pre-restore two-bank state and post-restore one-bank state confirm replacement rather than append. Archive CRC/checksum and all table digests are checked outside any performance timing.

## Interaction limitation and initial-version comparison

CUA close/Escape attempts did not dismiss the View passage surface; after native export, a menu remained open, and after restore an empty closing confirmation surface remained. Restarting the isolated app restored a usable UI and preserved the data. This observation has no established cause and is not a latency measurement. The application frontend, dependency lock and Vite configuration are byte-identical to the initial commit across89 files (`native-ui-identical-frontend.json`). A fresh archive of initial commit16e47c9 was built with another absent identifier, com.practiq.perf-baseline-20261013-01a13529, and the same three-category quota/supplied-answer/reading-material flow was exercised. Its View passage popup also remained visible after Close and Escape, confirmed in AX state and screenshot. Thus this observation predates the retained changes; its application/CUA cause remains unlocalized. See native-ui-baseline-build.log, ui-baseline-isolation.json and native-ui-baseline-observation.json. Smooth modal dismissal in the actual WebView is not accepted.

Native timing, minimum macOS version, Windows, actual Android/emulator/device behavior and signed/distribution packages remain unverified. Chromium touch-layout checks and native Rust tests are reported separately in the main evidence README.

An earlier UI-control build attempt was stopped because its snapshot included prior benchmark/control instrumentation; it is excluded. The fresh initial-commit archive initially omitted shared/theme.css, so its first build failed; the shared tree was added from the same commit and the final build passed. These preparation failures contribute no acceptance measurement. Both QA applications were closed after verification and all synthetic recovery data retained.
