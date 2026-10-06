# Review implementation and local acceptance — 2026-09-29

> Historical evidence. This records a 2026-09-29 local candidate and its then-uncommitted state. Embedded-service, Linux app and bundled Office checks below apply only to that candidate; later implementation does not rewrite these observations. See the [documentation index](README.md) for current guides.

This follows the remaining G-01–G-07 items in [the prior repair record](review-fixes-20260928.md). The user authorized implementation, selected `qwen3.7-flash` for live evaluations, and deferred independent human anchors and clean Windows/Linux machines. Earlier ISSUE-002–016 fixes are retained. Current v4/schema-11 policy rejects incompatible databases instead of migrating them; older directories remain untouched.

This is a local development candidate, not Stable acceptance. Changes remain uncommitted. No release, signing, notarization, upload or publication was performed. Model credentials were read only by the local evaluation process; the model override did not change `.env`.

## Changes and evidence

| Item | Implemented and locally exercised | Remaining acceptance |
| --- | --- | --- |
| G-01: extraction | Scorer 6.0.0 adds annotated source/evidence and visual-to-question association gates. Dataset expands from 22 to 28 cases, covering listening, grammar, supplied grading evidence, sentence selection, paragraph matching, translation and writing. Live extraction completed three repetitions: 84 trials, including six expected rejections. Of 78 normal trials, 42 passed quality (53.85%); all six expected rejections matched. Overall result: FAILED. | A passing final-source baseline is still required. These authored regression labels are not independent human labels. Visual semantic review remains manual. |
| G-02: Office fidelity | Preserved a table-ending DOCX regression. The private worker appends an empty paragraph only in a temporary DOCX text-conversion snapshot when the body ends in a table, preserving original source bytes. Added a strict packaged-worker fidelity check. | Legacy DOC loses its equation fraction under bundled LibreOffice 26.8.0.3; the new fidelity gate correctly fails. No guessed equation reconstruction or alternate parser was introduced. |
| G-03: packaging | Rebuilt the macOS app/DMG and exercised the packaged service, restart behavior, grading replay and eight Office format/mode cases under isolated resource relocation. | Clean-machine installation, update/uninstall, native dialogs, signing/notarization and Windows/Linux execution remain pending. A locally built package is not evidence of these checks. |
| G-04: storage failures | Added test-only I/O fault injection for storage-full and permission failures; tested SQLite lock rejection, rollback after publication failure, and actual child-process termination before/after database replacement. Recovery verifies images, audio, snapshots and SQLite integrity. Explicitly tested the 512 MiB backup boundary with a sparse file. | Simulated OS errors and process kills do not establish physical disk-full, power-loss or every-filesystem behavior. |
| G-05: grading | Evaluator repeats all five text/image cases, preserves failures, reports score mean/variance/range and error, accepts independently annotated external anchors, and refuses report overwrite before paid calls. Live 10 repetitions each: 50/50 exact expected scores, zero per-case variance/range. | All five cases are synthetic. Independent human scoring, representative answer diversity and calibration remain pending. |
| G-06: scale/UI | Release benchmark uses 10,000 questions and 100,000 saved attempts; measures paging, draft writes, backup and restore. Browser checks exercise 960×640, 1920×1080 and 2560×1440 layouts and keyboard focus. | Benchmark is synthetic SQLite/serialization, excludes IPC/WebView and sustained media use, and ran alongside other workloads. Full native accessibility, long audio sessions and sustained memory behavior remain pending. |
| G-07: maintenance | Added SECURITY.md with private reporting and dependency update policy. Inventories local-target Cargo, npm production closure, bundled Python and LibreOffice; bundles full notice texts and pinned supplemental sources. | All 953 entries have notice texts, but `react-remove-scroll-bar@2.3.8` has an inaccessible published upstream gitHead. Its supplemental license is pinned to another upstream commit and explicitly marked unverified; the license check fails pending attribution review. Legal obligations and other platforms still require review. |

## Verification

- `make verify AI_PYTHON=...`: 697 passed, 2 skipped, 92% combined coverage; Ruff, Pyright, 28 evaluation fixtures, recovery probes and Python package build passed.
- `make app-check AI_PYTHON=...`: 227 frontend tests; 134 Rust tests passed, 3 ignored; TypeScript, lint and Clippy passed. The three opt-in Rust checks (performance, native Keychain roundtrip and 512 MiB boundary) were separately run and passed.
- `npm run test:browser` from `app/`: passed, with mocked IPC. This is not native UI acceptance.
- `make app-package-check AI_PYTHON=...`: passed on this macOS machine, including eight bundled Office conversions. This general conversion gate does not replace the stricter fidelity gate.
- Final packaged fidelity: DOCX PDF fraction/image passed; table-ending DOCX text export passed with the last row exactly once; legacy DOC PDF fraction failed. All source hashes stayed unchanged. No model calls in fidelity checks.
- Scale medians: first page 3.254 ms, history page 19.829 ms, backup 416.074 ms, restore 2,130.420 ms; draft-write P95 0.641 ms. Backup size 4,396,662 bytes. These are one-machine observations, not a comparative performance guarantee.

## Local artifacts and reproduction

Generated evidence lives under `server/reports/checks/` and is ignored by Git. Do not replace failed reports with a passing summary:

- `review-extraction-20260929.json` and `.md`: three-repeat live parsing, failures and validation trajectories.
- `review-grading-20260929.json`: 50 live grading observations and statistics.
- `review-fidelity-20260929.json`: pre-fix baseline; `review-fidelity-final-20260929.json`: final packaged worker.
- `review-scale-20260929.json`: release-mode database benchmark.
- `review-licenses-final-package-20260929.json`: final-package inventory and unresolved attribution; the earlier `review-licenses-complete-texts-20260929.json` records the staged bundle.
- `office.json`, `probes.json`, coverage/JUnit reports: normal local gates.
- `review-candidate-manifest-20260929.json`: final source-file, changed-file, evidence and DMG SHA-256 manifest, rooted at the recorded base commit. This freezes local evidence without creating a release tag.

Use the selected Python 3.14+ interpreter for Make targets. `make app-fidelity-check` and `make app-license-check` intentionally return nonzero for the unresolved cases above. For repeat runs, invoke their scripts with a fresh `--output` path; evidence files are not overwritten. See [evaluation instructions](../server/docs/evaluation.md) for live parsing/grading and the external-anchor format. Real calls need explicit operator intent and configured credentials.

The three-repeat run started during scorer implementation; its recorded code hash is not the final source hash and it cannot serve as a frozen-candidate baseline. A release candidate must retain a source/artifact hash manifest, rerun quality on its final frozen source, resolve the DOC fidelity and license findings, and complete the outstanding human/platform/native checks. No current result establishes a passing release baseline.
