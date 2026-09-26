# Verify document extraction and subjective grading

This guide separates document extraction quality, subjective grading samples, and engineering checks. Extraction evaluation covers text, CSV, PDF, and images. Word cases and converter checks have been removed and replaced with input-rejection regressions; the corrupt-file rejection check now uses PDF. Historical DOCX results below and in `server/reports/` describe earlier versions, not current support or quality.

Use an existing Python 3.14+ environment and run the commands from `server/`.

Evaluation uses real local file writes and `document_parser`, calling the graph locally with an in-memory checkpoint. It measures extraction of questions and supplied answers. Engineering tests and load tests cover HTTP behavior, durable recovery, and capacity. Evaluation does not use LangSmith or an LLM judge, change prompts automatically, or publish releases.

## Check subjective grading and source-score extraction

`scripts/evaluate_grading.py` uses fixed synthetic questions to check grading and source-score extraction separately. It calls the service's model logic directly with a temporary grading database. It does not verify HTTP authentication, desktop interactions, or exactly-once provider calls.

Configure the shared multimodal `LLM_MODEL` in the repository-root `.env`, then run from `server/`. These commands call the model and incur charges. Choose a new report path for every run:

```sh
python scripts/evaluate_grading.py --live --repeats 2 \
  --output reports/grading/your_grading_run.json
```

By default, the script runs four text cases twice each, followed by one image partial-credit case. Text cases cover full credit, partial credit, an incorrect answer, and an answer containing embedded instructions. Reports retain expected values, actual scores, absolute error, model names, and call outcomes.

Check source-score extraction separately to confirm that questions without an explicit score retain `null`:

```sh
python scripts/evaluate_grading.py --live --source-scores-only \
  --repeats 2 --output reports/grading/your_source_score_run.json
```

Inspect `exactMatches`, `total`, and individual results. A successful script exit does not mean every sample passed. The script also permits overwriting output files; preserve failed reports instead of replacing them with newer results.

These rule-based synthetic samples are not independent teacher annotations or cross-subject calibration. They do not establish accuracy for formal exam grading.

## Extraction dataset and human gold labels

`evals/cases.json` uses `schemaVersion: 2` and currently contains 22 synthetic cases. The scorer version in `scripts/evaluate.py` is `4.0.0`. The manifest covers Text, CSV, PDF, and Image; seven basic question types; reading, word-bank, and cloze composites; and cases involving Chinese, missing source answers, long stems with identical prefixes, legitimate duplicates, long text spanning chunks, text without questions, and corrupt PDFs. Contract and desktop tests for newer English question types, such as listening and grammar cloze, do not mean those types are covered by this live-model quality evaluation. Manifest fields mean:

- `id` is a stable, unique case identifier. `path` must point inside the manifest directory; path and symlink escapes are forbidden.
- `tags` group cases by scenario. With `critical: true`, any discrepancy in an annotated field or structure fails the case.
- Normal cases must specify `expectedQuestions` and expect `SUCCEEDED`.
- Rejection cases specify only an error such as `expectedError: {"code": "NO_QUESTIONS_FOUND", "statusCode": 422}`. Both values must match. External-service unavailability cannot be labeled an expected success.
- `expectedGroups` annotates titles and zero-based question indices. `expectedVisualKinds` annotates visual kinds and counts. Omission or `null` means unannotated; `[]` explicitly requires no such structure.
- `stemAliases` and `answerAliases` allow only source-verified equivalents, such as LaTeX multiplication/division symbols or chemical subscripts. Aliases must obey the question-type contract. Do not add answer aliases when the source has no answer.
- `sourceHasNoAnswers: true` explicitly marks an entire document as answerless. Every output answer must be null, including rewritten, unmatched, and extra questions. Do not use it for documents mixing answered and unanswered questions.
- `expectedMissingFields` and `expectedNeedsReview` annotate missing fields and review status for valid drafts, per question.
- `expectedVisuals: [{"kind": "diagram", "page": 0}]` checks both kind and zero-based page. Embedded original images may have a null page. Use this field or the older `expectedVisualKinds`, not both; `[]` still explicitly means no visuals. The runner also reads every visual reference and verifies size, SHA-256, and image decoding, without exporting references into reports.
- `expectedProcess` can specify `requiredCallKinds` and `maxModelCalls`, checked by fixed-workflow process assertions.
- `split` defaults to `regression`. `image-holdout-instruction` is a separate `holdout` case; existing cases remain in the regression set. Debug against regression cases and run both sets before release. Do not repeatedly inspect the holdout to tune prompts. One holdout case verifies the process, not generalization. Real material requires de-identification, authorization, and independent human annotation before inclusion.

Check gold labels against source files manually; never copy model outputs back as correct answers. PDF and image figures are evaluated using visual-model categories such as `diagram`. Humans review the meaning of visual descriptions.

After updating the dataset, run:

```bash
python scripts/evaluate.py --validate-only
python -m pytest tests/test_evaluation.py
```

CI checks coverage of all four formats, the nine answer modes in `ANSWER_MODES`, seven difficult-case tags, and a manifest entry for every fixture. `choice` covers both single and multiple choice. The manifest validator accepts any nonempty dataset size for small debugging sets.

## Scoring and gates

`qualityPassed` means an execution meets its expected status, all annotated fields and structures, visual-artifact checks, and process expectations. It is independent of execution status: `SUCCEEDED` can still fail quality, while correctly returning null for missing source answers can pass. Expected rejections are reported separately from normal-task success rates and failure timing.

`reliability` reports document execution success and quality pass rates. When every case has at least three repetitions, it also reports `allRepetitionsPassRate` and `anyRepetitionPassRate`; otherwise these are N/A. `reliabilitySlices` groups results by format, tag, and dataset split. Three repetitions do not establish production reliability confidence.

`fidelity` separately counts fabricated answers, extra questions, field inconsistencies, and questions needing source confirmation. Unmatched questions and source warnings are not automatically hallucinations; these counts cannot establish an overall hallucination rate.

Stem matching removes only leading question numbers and layout whitespace, preserving case, punctuation, and full content. It does not truncate stems or use case-insensitive keys. Production deduplication also requires matching source locations and actual chunk overlap. Identical stems match one-to-one in occurrence order. Extra questions reduce precision; missing questions reduce recall and field accuracy. Options are compared in label/content order, and answers use structured values consistent with the source gold labels.

| Metric | Numerator / denominator |
|---|---|
| questionPrecision | Matched questions / output questions |
| questionRecall | Matched questions / gold questions |
| answerModeAccuracy | Questions with the correct answer mode / gold questions |
| optionsAccuracy | Choice questions with correct options / gold choice questions |
| parsedAnswerAccuracy | Questions with correct source answers / gold questions, including null answers |
| groupF1 | 2 × fully matched groups / (gold groups + output groups), checking titles and members |
| visualF1 | 2 × matched visuals / (gold visuals + output visuals), using multiset counts of kind and annotated page |

Metrics range from 0 to 100. A missing denominator yields N/A; an explicitly empty annotated structure with an empty output scores 100. Overall metrics use micro-averages over questions or structures, with breakdowns by format, question type, and tag.

Gates require all annotated overall quality metrics to reach at least 90%, all normal cases to be `SUCCEEDED`, all expected rejections to match, and all critical cases to have no discrepancies. Matched questions without source answers must never receive fabricated answers. Unmatched and extra questions in wholly answerless cases must also retain null answers. `PARTIAL` preserves results and stage failures but does not count as a normal-case success.

| Status / exit code | Meaning |
|---|---|
| PASSED / 0 | All gates passed, including non-regression when a valid baseline was supplied |
| FAILED / 1 | A quality, expected-status, critical-case, or non-regression gate failed |
| BLOCKED / 2 | Missing configuration, unavailable model/local storage, invalid input, or incomparable baseline |

External failures are not valid baselines with a model-answer score of zero. Reports retain available results and failure timing. Tokens are returned usage observed through callbacks; `complete: false` and `missingUsageCalls` mean total consumption cannot be inferred. Prices and missing usage are not estimated. P50/P95 timing is reported separately for all executions, successful executions, and failed or `PARTIAL` executions; timing is not an initial blocking gate.

The `efficiency` numerator includes usage from every evaluation attempt, including rejection cases, failures, and corrections. Its denominator includes only normal documents that pass quality; both counts are shown. Tokens per qualifying document are N/A when usage is missing. Monetary cost is N/A because prices are not configured. Platform estimates and known usage are not complete bills. Stage P50/P95 comes from existing events; concurrent stages within one document cannot be summed into total duration.

`trajectory` links thread/run, page or chunk, callKey, attempt, schema, validation results, and retry/correction/accept/stop events locally. `RETURNED` means only that the provider returned; `validation=passed` means structural validation passed. Assertions check preparation, text assembly, allowed model kinds/schemas, page context, the four-attempt limit, and task call limits, while allowing concurrent units to finish out of order. Events exclude message bodies, images, credentials, and exception bodies. Document status and model timing continue to use Prometheus; these metrics do not measure semantic accuracy.

## Run, compare, and save

Run these commands in `server/`. Configuration comes from the repository-root `.env`.

```bash
# Single-case smoke test; --case may be repeated.
python -m dotenv -f ../.env run -- python scripts/evaluate.py --case text-basic

# Use only regression cases for debugging; omitting split runs all cases.
python -m dotenv -f ../.env run -- python scripts/evaluate.py --split regression

# Formal baseline or candidate: three repetitions per case, each with its own thread.
python -m dotenv -f ../.env run -- python scripts/evaluate.py --repetitions 3

# Replace the placeholder with the actual baseline report path.
python -m dotenv -f ../.env run -- python scripts/evaluate.py --repetitions 3 \
  --baseline 'reports/evaluations/your_baseline_run/report.json'

# Compare existing reports without .env, model calls, or local storage access.
python scripts/evaluate.py --compare \
  'reports/evaluations/your_baseline_run/report.json' \
  'reports/evaluations/your_candidate_run/report.json'
```

By default, runs produce `report.json` and `report.md` under `reports/evaluations/<runId>/`; the terminal prints the actual paths. `--output` accepts a new `.json` path and also produces a matching Markdown file. Existing files cannot be overwritten. The old `reports/evaluation.json` remains historical v1 failure evidence and is not a valid v2 baseline.

Reports record the Git commit and dirty state, source/dependency and prompt fingerprints, model, allowlisted runtime parameters, selected gold labels and file-content hashes, scorer version, per-execution field differences, processing failures, model calls, and timing. They exclude credentials, signed URLs, object references, and raw exception bodies.

A valid baseline must be PASSED. Both baseline and candidate must have at least three repetitions and identical dataset hashes, scorer versions, selected cases, and repetition counts. Comparison uses unrounded metrics and forbids decreases in overall metrics. Reports show percentage-point changes, per-case count changes, and code/model/parameter changes. A single run can check absolute gates but cannot serve as a formal comparison baseline. Changes to scoring semantics require a new `SCORER_VERSION` and a new live baseline; do not mix scoring versions. Historical reports remain read-only. The current comparator requires the current `SCORER_VERSION` and does not migrate or rewrite historical scores. The runner disables `LANGSMITH_TRACING` and `LANGCHAIN_TRACING_V2` and sends no data to a remote evaluation platform.

## Offline fault probes and local review

`make verify` and CI run the full pytest suite once and convert its JUnit results into a fault-probe report:

```bash
python -m pytest --junitxml=reports/checks/probes.xml
python scripts/evaluate.py --probes reports/checks/probes.xml
```

Probes reuse tests for recovery, budgets, reference validation, converters, similar sources, and structured output. They distinguish recovery success, correct stopping, route validity, and preservation of unknown usage. Each parameterized scenario is one observation; missing, skipped, or setup-failed scenarios do not pass. JUnit records code and test fingerprints; stale evidence returns BLOCKED. Test exception bodies are not exported. These results establish only deterministic fault-test behavior. Actual process restart remains NOT_ASSESSED in this probe summary. Isolated SQLite tests in `tests/test_agent_server.py` separately verify forced termination and recovery; they do not replace recovery acceptance against production persistent directories.

The `review_candidate` log event contains only task identifiers, format, status, and error codes. Save `practiq.events` message bodies as JSONL in a local persistent log directory, then generate a review queue:

```bash
python scripts/review_queue.py /absolute/logs/practiq.events.jsonl \
  --output reports/reviews/2026-09-18.json
```

All execution errors, `PARTIAL` results, and quality-review flags are selected. Other tasks are sampled at approximately 5% using format and a stable thread-identifier hash, not exactly 5% of every small batch. Runs are deduplicated, and replay does not change selection. The queue contains only metadata. Reviewers read source material through existing authenticated task APIs and record decisions. Confirmed problems are de-identified and given gold labels before entering the regression set. This process does not automatically classify problems, change prompts, or publish releases. JSON/Markdown outputs cannot overwrite existing files, and generated reports need not be committed to Git.

Merge human decisions with `--decisions /absolute/review-decisions.json`, using a JSON array:

```json
[
  {
    "threadId": "your_first_thread_id",
    "runId": "your_first_run_id",
    "verdict": "incorrect",
    "errorCategory": "model_output"
  },
  {
    "threadId": "your_second_thread_id",
    "runId": "your_second_run_id",
    "verdict": "correct",
    "errorCategory": null
  }
]
```

`verdict` is `correct`, `incorrect`, or `uncertain`. Only `incorrect` requires `errorCategory` (`extraction`, `model_output`, `merge`, or `gold_label`); other verdicts require null. Every entry must belong to the queue selected from this log batch, with no duplicate `(threadId, runId)`. Partial decisions are allowed; omitted entries remain null and display as pending review. Extra fields are rejected. Do not add content, answers, or credentials to decision files. Use a new `--output` path when regenerating. Local decisions do not alter server results or clear quality flags; accepting a server result does not automatically create a correct verdict.

The [first v3 report](../reports/evaluations/fc0f9716-001e-4849-9b4c-94399d9b501f/report.md), dated 2026-09-18, covered all 25 cases with three live-model executions each and FAILED. Of 69 normal-task executions, 66 succeeded and 61 passed quality. All 23 normal cases passed at least once; 17 passed all three repetitions. All six expected rejections matched. Process assertions and visual-artifact validation passed, but visual F1 was 80%. The filename-instruction case fabricated an answer once; other failures involved cross-page answers, extra questions, and visual-output validation. All failure evidence is retained, and this run is not a qualifying baseline. Holdout results were not used to tune prompts in this round.

At that time, the production crash-recovery matrix for the separate Agent Server/PostgreSQL/Redis stack was incomplete. An additional isolated-directory check used only local runtime configuration with tracing disabled: `/ok` returned 200 on both development-server starts, and the original thread remained readable after a graceful stop and restart, without model calls. This verifies development-mode thread persistence and graceful restart, not mid-execution crashes, model-result reuse, or production database recovery.

## Continuous improvement

Keep fixed datasets and failure evidence, and validate changes in this order:

1. Use Markdown gate reasons and metric breakdowns to locate per-question expected/actual values and `processing.failures` in JSON.
2. Review the source manually to distinguish incorrect gold labels, valid equivalents, extraction/visual-recognition errors, model-output errors, and merge errors.
3. Add confirmed failures as cases. Once source data and correct annotations are fixed, change one factor: prompt, model, or code.
4. Run all engineering checks, then run three live evaluation repetitions on the same dataset. Compare quality, tokens, and timing against a valid baseline.
5. Review differences manually. After acceptance, record the new report path as the next baseline. Preserve old reports and regression samples; never replace baselines automatically.

PRs should record the reason for the change, case IDs, engineering-check commands, live report paths, and baseline differences. CI does not call real models and cannot establish semantic quality after prompt changes; local live runs provide that evidence. Passing a small synthetic dataset does not establish production quality or generalization.

## Review the first live run

The [first v2 report](../reports/evaluations/b66d5814-eea3-439b-9117-e2243a8bcc9c/report.md) covered all 19 cases once and FAILED. It is not a valid three-repetition baseline. Findings included:

- `csv-basic` extracted no questions. Visual descriptions for `docx-formula-image` still violated the contract after four outputs, returning PARTIAL.
- Cases such as `xlsx-multi-sheet` lost source answers. Some short-answer questions in long-stem, duplicate, and cross-chunk samples were labeled as fill-in-the-blank.
- Some stems retained source type prefixes such as `Multiple choice:`, causing strict matching failures. Expressions such as `Na` and `\mathrm{Na}` also required human equivalence review.
- Both expected rejections matched, and answerless-source cases did not fabricate answers. Successful status did not mean every field was correct.

Review these differences before changing gold labels, scoring rules, or the agent. If humans confirm new equivalent aliases, rerun on the fixed new dataset. Do not compare directly against reports with a different dataset hash or overwrite this evidence.

## Prompt and output constraints

Document parsing extracts only supplied answers and explanations, returning null when absent rather than solving questions. It preserves genuine duplicate questions and determines types from source labels or response requirements. Groups include explicit source sections and `[sheet]` text markers (which do not imply Excel-file support), using zero-based indices within the current chunk. Prompts include examples of an unanswered fill-in-the-blank question, an answered short-answer question, and a worksheet true/false question. Stems retain original wording, punctuation, and blank-underscore counts; LaTeX conversion belongs in formula content blocks. Visual models extract structured questions directly from pages. Unreadable content retains missing fields and review flags rather than fabricated content. Images without text return null `extractedText`. Instructions inside documents, filenames, images, and request fields are treated as data. These semantic constraints do not guarantee complete prompt-injection prevention or extraction accuracy.

Regression tests cover question completeness, model correction, and usage for every call. Passing FakeModel tests does not demonstrate improved live-model quality.

### Bailian structured-output configuration

All agents share model and protocol selection in `llm.py`. `AI_STRUCTURED_OUTPUT_METHOD=function_calling` is the default. `json_schema` explicitly enables Bailian `response_format.type=json_schema` with `strict=true`. `auto` selects native schema only for the officially supported Qwen3.7 Plus/Flash/Max and Qwen3.8 Flash/Max families, otherwise using tool calling. Explicit native mode fails for unsupported models instead of silently falling back. The support list follows [Bailian's official documentation](https://help.aliyun.com/zh/model-studio/qwen-structured-output).

Qwen3.7 calls disable thinking; model, token limits, and timeouts still come from existing configuration. Native mode receives the complete response before Pydantic validation, avoiding early SDK truncation errors that lose usage. Truncated output, unclosed JSON, and semantic validation failures are rejected and enter the existing bounded correction and usage-recording path. Explicit token truncation cannot be accepted through local JSON repair.

See the [optimization record](../reports/evaluations/prompt-optimization-summary.md) for protocol-selection evidence and live-run limitations.

Tool-call count, names, and argument structure are checked before using SDK-parsed objects; raw tool arguments take priority. Native JSON Schema and structured objects without tool calls remain subject to the same business validation. Group indices reject booleans, floats, and numeric strings. `isCorrect` and `needsReview` reject string/number coercion to booleans. Semantic descriptions of key fields and figure coordinates are sent with the schema; valid drafts, false, zero, and null retain their meanings. Truncation remains `OUTPUT_TRUNCATED`, including early stopping after repeated truncation, and does not allow manual retries with unchanged parameters.

Local JSON Repair is integrated into shared response validation: it closes brackets, removes trailing commas before closing brackets, and strips complete code fences before rerunning the original schema/content checks. Repair adds no model calls, and missing fields remain incomplete. Explicit token truncation, unfinished strings, missing values, and type/content contradictions still enter bounded correction. Repair does not relax quality gates.

### Failure limits and quality visibility

Gold labels for `text-source-identity` preserve stems that differ in case and questions with identical stems but different options. Offline tests cover chunk offsets, ambiguous sources, same-source content conflicts, early stopping on repeated invalid output, and retry limits. Live evaluation still runs baseline and candidate three times on the same dataset; gold labels are not changed to pass gates. Empty stems in valid drafts count as unmatched. Null answer modes appear in the report's `unknown` bucket while remaining null in the original result. `processing.questionSources/quality` provides only source and review hints. It does not change quality scoring or prove semantic validation of images or answers. Failure reports reuse graph failure classifications and remaining retry counts.

Compare call counts, known input/output tokens, and unknown usage alongside the original quality gates. If the baseline itself failed, formal comparison remains BLOCKED. Measured differences may be reported, but non-regression acceptance cannot be claimed. Durable recovery also requires the isolated local persistent-storage exercise in [operations.md](operations.md).

Human-defined synthetic gold labels added on 2026-09-18 cover embedded instructions, consolidated answers, and four-page material with answers on the last page. Together with existing two-column diagrams, tables, and answerless-source samples, they retain the 90% metric threshold and the requirement that every critical case pass. Source data is entirely human-constructed and contains no user material. The PDF contains a fixed four-page English observation log and one question/answer. Evaluation PASSED/FAILED is separate from execution success. Prompt changes cannot be accepted by lowering thresholds or deleting failing samples.

### Diagnose model validation failures

Each model call's `validationIssues` records failing field paths and Pydantic error types, up to 20 entries. Unknown field names become `?`; field values, source text, and exception context are excluded. Locate `calls` for the failed case/repetition, then distinguish structural errors such as `list_type`, truncation, business validation, and final scoring differences. HTTP success and task completion do not imply gold-label quality acceptance.

A captured response whose `questions` string wraps the remaining object fields is retained as an offline regression sample in `tests/fixtures/stringified-page-arguments.json`. Such responses remain rejected: trailing fields are not discarded, and content is not guessed. Shared correction explicitly requires real arrays and separate top-level fields; usage is counted normally. Initial prompts also specify array structure. The Bailian preset and the same custom Base URL in the desktop use identical Qwen3.7 thinking parameters. Other custom endpoints do not receive this provider-specific parameter.

An experiment with `vl_high_resolution_images=true` on Bailian Qwen3.7 improved a scanned sample but introduced duplicate questions and missing answers in long PDFs during full regression, so the parameter was not adopted. A single improved high-resolution sample does not establish overall quality improvement. See [Bailian's vision documentation](https://help.aliyun.com/zh/model-studio/vision) for image parameters. Strict character scoring and human-review flags remain in place.
