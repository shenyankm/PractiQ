# Native AI import acceptance — 2026-09-29

> Historical evidence. This records the former desktop import UI and embedded Python service. Current source import uses the independent service/Web flow; it is not acceptance of that architecture. See the [documentation index](README.md) for current guides.

**Verdict: the workflow works, but extraction quality does not pass acceptance.** This run used the actual macOS release application, native file picker, configured `qwen3.7-flash`, packaged Python service, import-history UI and local question-bank importer. No fake model responses or preview IPC were used. The user configured desktop credentials. Only synthetic repository fixtures were submitted. Three banks containing six questions were imported and preserved for inspection under `Acceptance-20260929-*`.

## Observations

| Native input | Runtime | Result and source comparison |
| --- | --- | --- |
| `basic.txt` | 43.8 s | Two questions imported. Choice options 4/5/6 and reference B retained; freezing-point statement retains true. Missing analyses remain missing with review flags. |
| `pdf-scanned.pdf` | 18.6 s | Both scanned questions imported. Division answer 25 and the false answer for “5 is even” retained. Blank punctuation changed, but the mathematical content is intact. |
| `text-grading-evidence.txt` | 65.0 s | Both questions imported. Evaporation answer, 5 points and supplied rubric retained; the answerless writing question keeps null answer/score/rubric. **However, evaporation was labeled `questionKind=writing`, and the writing question was labeled `translation` with invented `sourceLanguage=en`, `targetLanguage=zh`. This fails fidelity acceptance.** |
| `text-listening-evidence.txt` | 209.1 s | No questions imported. Native UI reaches “Waiting for review”, reports OUTPUT_INVALID, and exposes retry/review controls. Four model calls, 24,973 input tokens and 17,526 output tokens were recorded. The supplied transcript and one choice question did not produce a valid composite result. |

The timing is the service run interval, excluding manual file selection and bank-import clicks. Imported banks, source associations and review flags survived application restart. Read-only SQLite verification checked actual imported typed answers, source scores, rubrics, question kinds and language fields. No test fixture was marked reviewed to disguise the remaining warnings.

## Findings

1. **High: invented question-kind and language metadata.** The short-answer row still appears superficially usable because its answer is retained, but writing/translation metadata is incorrect. The current structural validator accepts these internally consistent, unsupported values. Quality checks must compare these fields to source evidence, including explicit absence; successful task completion alone is insufficient.
2. **High: listening extraction fails repeatedly.** A 164-byte source with a transcript and one supplied answer consumed four calls and ended with zero usable questions. Failure is preserved rather than silently importing corrupt content, but this is not an acceptable listening-import result.
3. **Medium: required description is not identified clearly.** Bank name, model and file can all be ready while Start import remains disabled; the description is required but its label does not explain that requirement. This was observed and not silently changed during acceptance.
4. **Resolved at user request: redundant parsing confirmations.** Start import previously showed another native dialog for each file, and Parse again showed another confirmation. The updated implementation treats the button click as the explicit action, removes these prompts, and keeps the model-transmission/cost notice on the page. Matching content opens existing tasks; Parse again creates a new task directly. Destructive restore/delete and result-review decisions are separate operations.

## Direct-start change verification

The updated macOS app was rebuilt and reopened. The import page shows the revised notice. A new `direct-start.txt` source was selected through the native picker; clicking Start import created task `ed4ea811-6918-5016-967b-f5c1e4a6c117` and completed parsing to Ready to import without any parsing-confirmation interaction. The extra result was left unimported to avoid adding a duplicate bank. Existing three banks and six questions remained visible after restart.

`make app-check` passed: 227 frontend tests, 133 Rust tests, three opt-in tests ignored, plus TypeScript/lint/Clippy. One obsolete test covering the removed confirmation callback was removed. The existing form test still verifies that clicking Start import submits the native selection token and bank metadata. `npm run tauri -- build --bundles app` passed. The application bundle was rebuilt; the earlier DMG has not been rebuilt for this change.

## Supplemental service run and evidence

Before desktop configuration was available, a separate isolated instance of the packaged service ran the same four samples over authenticated HTTP with `.env` credentials and `qwen3.7-flash`. It exercised actual uploads, idempotent task creation, queue processing, result retrieval and a credential-free read-only restart. Three sources completed; listening failed. All task results and recorded usage survived restart without additional calls. This is supplemental evidence, not a substitute for the native run above. The two runs used their independently configured endpoints and should not be treated as a controlled model comparison.

Local evidence is under `server/reports/checks/native-import-20260929/` (ignored by Git):

- `report.json` and `*-state.json`: isolated packaged-service results.
- `native-questions.json`, `native-answers.json`, `native-runs.json`: actual desktop import/storage evidence for the test banks.
- `expected.json` and copied source documents: expected reference content.
- `run_live.py`: rerunnable live HTTP probe; it reads credentials at runtime and never embeds them.

No credential was written into these reports. No production source was modified to improve extraction scores, no failing output was replaced with expected output, and no commit or push was made. The retained failed listening task remains available for inspection.

## 全格式追加验收

新增 10 份全题型测试集的真实模型重跑，见[中文验收报告](ai-import-all-formats-acceptance-20260929.zh-CN.md)。该轮完整通过 0/10，不替代本文已完成的少量原生桌面操作记录。
