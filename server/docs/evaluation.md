# Verify document extraction and subjective grading

The October 14–15, 2026 campaign, including the resumed DashScope iteration,
is archived in the [import acceptance report](import-acceptance-20261015.md),
[resume metric notes](import-resume-metrics-20261015.md), and
[machine-readable summary](evidence/import-20261015-summary.json). The user stopped
model work after DashScope returned `Arrearage`. The last complete focused stage
scored 26/27; the final stage recorded 20 completed trials, one paused trial and
six not run, and independently lost 50/72 PDF material observations. Acceptance
remains failed/incomplete. Historical per-format maxima come from different
source snapshots; no final MAIN99 or current-candidate large-file improvement is
established. Unknown usage remains unknown.

This guide separates document extraction quality, subjective grading samples, and engineering checks. The active extraction dataset covers text, PDF and images through Tencent parsing. CSV uploads are no longer supported; historical CSV gold labels and source files remain in `evals/legacy-csv-cases.json` for scoring saved results. Word/Excel/PPT originals go directly to Tencent within the per-job limit; oversized Office sources use the isolated service converter for pagination. Office availability and source limits follow the [service Office guide](desktop-office.md). Verify the deployed engine separately, without model calls, using the [unchanged Office fixtures and conversion procedure](../../app/fixtures/office/README.md). The practice app contains no Office engine. Historical DOCX model results below and in `server/reports/` describe earlier parsers, not the quality of the current service conversion path.

Use an existing Python 3.14+ environment and run the commands from `server/`.

Evaluation uses real local file writes and `document_parser`, calling the graph locally with an in-memory checkpoint. It measures extraction of questions and supplied answers. Engineering tests and load tests cover HTTP behavior, durable recovery, and capacity. Evaluation does not use LangSmith or an LLM judge, change prompts automatically, or publish releases.

## Check subjective grading and source-score extraction

`scripts/evaluate_grading.py` uses fixed synthetic questions to check grading and source-score extraction separately. It calls the service's model logic directly with the initialized PostgreSQL database configured by `DATABASE_URI`. Evaluation requests use new IDs and remain in its grading ledger. It does not verify HTTP authentication, desktop interactions, or exactly-once provider calls.

Configure the shared multimodal `LLM_MODEL` in the repository-root `.env`, then run from `server/`. These commands call the model and incur charges. Choose a new report path for every run:

```sh
python scripts/evaluate_grading.py --live --repeats 10 \
  --output reports/grading/your_grading_run.json
```

By default, the script runs four text cases and one image partial-credit case ten times each. Text cases cover full credit, partial credit, an incorrect answer, and an answer containing embedded instructions. Reports retain expected values, actual scores, absolute error, model names, and call outcomes.

Check source-score extraction separately to confirm that questions without an explicit score retain `null`:

```sh
python scripts/evaluate_grading.py --live --source-scores-only \
  --repeats 2 --output reports/grading/your_source_score_run.json
```

Inspect `exactMatches`, `total`, and individual results. Exit code 0 means all grading samples passed; 1 means FAILED and 2 means invalid input or BLOCKED. Reports are created exclusively: an existing output path is rejected before paid calls, so choose a fresh path for every run.

These rule-based synthetic samples are not independent teacher annotations or cross-subject calibration. They do not establish accuracy for formal exam grading.

## Extraction dataset and human gold labels

`evals/cases.json` uses `schemaVersion: 2` with synthetic cases. The active scorer version in `scripts/evaluate.py` is `6.5.0`; freeze a separate three-repetition baseline for this version rather than reusing historical 6.2.0/6.3.0/6.4.0 reports. The active manifest covers Text, PDF, and Image; seven basic question types; reading, word-bank, and cloze composites; and cases involving Chinese, missing source answers, long stems with identical prefixes, legitimate duplicates, long text spanning chunks, text without questions, and corrupt PDFs. Two focused text cases cover multiple-choice and ordinary fill-blank extraction. Six additional regression cases cover listening without audio, grammar fill, sentence selection, paragraph matching, translation/writing, and supplied or absent grading evidence. Their source and labels are synthetic maintenance fixtures, not independent teacher annotations. Real-model results remain separate from fixture validation. Manifest fields mean:

- `id` is a stable, unique case identifier. `path` must point inside the manifest directory; path and symlink escapes are forbidden.
- `tags` group cases by scenario. With `critical: true`, any discrepancy in an annotated field or structure fails the case.
- Non-rejection cases specify `expectedQuestions`; `expectedStatus` defaults to `SUCCEEDED`. The no-question fixture explicitly expects `PARTIAL` and missing `questions`, rather than an error.
- Rejection cases specify only an error such as `expectedError: {"code": "DOCUMENT_PROCESSING_FAILED", "statusCode": 400}`. Both values must match. External-service unavailability cannot be labeled an expected success.
- `expectedGroups` annotates titles and zero-based question indices. `expectedVisualKinds` annotates visual kinds and counts. Omission or `null` means unannotated; `[]` explicitly requires no such structure.
- `stemAliases` and `answerAliases` allow only source-verified equivalents, such as LaTeX multiplication/division symbols or chemical subscripts. Aliases must obey the question-type contract. The matching fixture canonically requires `Match words and numbers (one-to-one)`; dropping its printed qualifier is not an equivalent alias and changes the dataset identity. Do not add answer aliases when the source has no answer.
- `sourceHasNoAnswers: true` explicitly marks an entire document as answerless. Every output answer must be null, including rewritten, unmatched, and extra questions. Do not use it for documents mixing answered and unanswered questions.
- `expectedMissingFields` and `expectedNeedsReview` annotate missing fields and review status for valid drafts, per question.
- `expectedVisuals: [{"kind": "diagram", "page": 0}]` checks both kind and zero-based page. Embedded original images may have a null page. Use this field or the older `expectedVisualKinds`, not both; `[]` still explicitly means no visuals. The runner also reads every visual reference and verifies size, SHA-256, and image decoding, without exporting references into reports.
- `expectedProcess` specifies required extraction/figure call kinds and call limits. Only `document_parse`, `vision_parse` and `vision_describe` are accepted; each structured pass permits at most four attempts within its unit. Reports retain the fixed `model_api=responses` metadata and extraction prompt/schema fingerprints. Scorer `6.5.0` removes the optional AI review stages; establish a fresh baseline rather than treating historical scorer reports as current acceptance.
- `split` defaults to `regression`. `image-holdout-instruction` is a separate `holdout` case; existing cases remain in the regression set. Debug against regression cases and run both sets before release. Do not repeatedly inspect the holdout to tune prompts. One holdout case verifies the process, not generalization. Real material requires de-identification, authorization, and independent human annotation before inclusion.

Check gold labels against source files manually; never copy model outputs back as correct answers. PDF and image figures are evaluated using visual-model categories such as `diagram`. Humans review the meaning of visual descriptions.

### Source-grounded composite annotation correction (2026-10-15)

The user confirmed a source review of `text-composites` before the resumed
evaluation. Its word-bank and cloze passages retain their printed final periods;
ordering and matching items retain printed `0`/`1` labels. The matching stem also
accepts the literal source title `Match words and numbers (one-to-one)`, while
the annotated `one_to_one` policy remains required. See the
[unchanged source](../evals/fixtures/text/composites.txt), lines 7, 10, 13, 15–16.
Regression controls reject lost periods, lost labels and invented title suffixes.

At that archived annotation stage, this correction left all 33 cases, source bytes, answers,
critical/holdout flags, scorer `6.2.0` and thresholds unchanged. The manifest hash changes from
`84dd2203df0da65dc02ab85dbdd2d6b50f363449f2a1b6cc1920f523fcdc0b7e` to
`65c9d1b5b302453774c1538acbcf590b36b388788fcbbd8e3d9647787328aefc`.
Keep the original frozen dataset and failed reports; freeze the corrected dataset
separately and run fresh evaluations. Scores using these two dataset hashes are
not a directly comparable before/after measure of extraction improvement.

Source review on October 9, 2026 corrected only `text-translation-writing`'s
`sourceLanguage` from `zh-CN` to `null`. The instruction states only "into English",
not the source language. The existing extraction contract requires an explicit
language direction; do not infer a source-language tag from the passage's script.
An intermediate `zh` annotation was rejected during review because it still
required an unstated language. Earlier reports retain their original hashes and
failures. Answers, other labels, critical gates and the holdout remain unchanged. The manifest/dataset
hash changes, so retain earlier reports and establish a new three-repetition
baseline before comparing candidates. Scoring semantics and version are unchanged.

### Approved visual-context process correction (2026-10-15)

Scorer `6.3.0` changes only the visual-context process window, following explicit
user approval. A page may use the previous two pages and the next page as context,
with at most four distinct pages including the primary page. Missing primary
pages, duplicates, earlier pages and later pages still fail the process check.
This matches the existing bounded production window used to retain long material.
Content scoring, source gold, answers and quality thresholds are unchanged.

Preserve scorer `6.2.0`, its locks and its failed reports. Freeze `6.3.0` separately
and establish a fresh three-repetition baseline. Scoring saved outputs under both
versions explains the process-rule difference; it does not demonstrate a new
extraction improvement or replace the required fresh live matrix. Do not compare
quality scores across these scorer versions as a before/after model result.

### Answerless PNG provenance and source review

`image-no-answer` retains the original 600×400 PNG contributed by Cid-oe in [fork PR #1](https://github.com/Cid-oe/PractiQ/pull/1), linked from [issue #114](https://github.com/shenyankm/PractiQ/issues/114#issuecomment-5976045114). The authoritative [source file at commit `7f297461`](https://github.com/Cid-oe/PractiQ/blob/7f2974618279e3fd0b27301f126a1a19206c4aac/server/evals/fixtures/image/answerless.png) is kept unchanged with SHA-256 `859c132e2b50555d146b73cb737be15087237222c7f430b4fe6c8aceba1bb92f`. Generation note: this supplied raster places two questions and their ordered choices as black text on a white background. The contributor supplied no generator, font provenance or generation command, so regenerating identical PNG bytes is not established; retain this exact public version when reproducing the evaluation.

Codex-assisted visual source review on 2026-10-04 checked both printed questions and all six options against the gold entry:

| Printed question | Ordered options |
| --- | --- |
| What is the tallest mountain on Earth? | A: K2; B: Mount Everest; C: Kangchenjunga |
| Which planet is known as the Red Planet? | A: Venus; B: Mars; C: Jupiter |

The entire image has no supplied answers, scores or rubrics. Both gold answers remain `null` and require review; no question was solved to construct them. The actual manifest-case regressions accept null answers and reject fabricated answers for matched, rewritten, extra and unmatched outputs. They exercise the offline scorer, not real-model image recognition or independent human annotation. Existing labels, critical/holdout semantics and quality thresholds are unchanged. Run the offline manifest and focused checks below, then `make verify AI_PYTHON=/absolute/path/to/python3.14` from the repository root before delivering the fixture PR.

`csv-no-answer` was authored directly as a tiny original UTF-8 CSV in
`evals/fixtures/csv/csv-no-answer.csv`; no binary generator, personal data or
third-party material is involved. Source review compared both printed question
stems and all six labeled options against the gold entry. The header and both rows
contain no answers, explanations, scores or rubrics. The gold therefore explicitly
retains null answer payloads and null grading evidence without solving either
question. Focused tests bind this actual case and reject invented answers on
matched, rewritten and extra questions, even when overall answer accuracy remains
above the unchanged threshold. These are synthetic offline checks, not independent
teacher annotations or real-model quality evidence. Validate this contribution
from the repository root with an existing Python 3.14+ interpreter:

```sh
AI_PYTHON=/absolute/path/to/python3.14
"$AI_PYTHON" server/scripts/evaluate.py --validate-only
(cd server && PYTHONPATH=src "$AI_PYTHON" -m pytest tests/test_evaluation.py)
make verify AI_PYTHON="$AI_PYTHON"
```

The first two commands are focused checks; full `make verify` is required before
delivery. None of these commands authorizes a live model run.

After updating the dataset, run:

```bash
python scripts/evaluate.py --validate-only
python -m pytest tests/test_evaluation.py
```

CI checks coverage of all four formats, the eleven answer modes in `ANSWER_MODES`, seven difficult-case tags, and a manifest entry for every fixture. `choice` covers both single and multiple choice. The manifest validator accepts any nonempty dataset size for small debugging sets.

## Tencent route compatibility (introduced in scorer 6.4.0)

The preparation stage records its trusted `extraction_route` before any model call.
Exact Tencent/original text identity uses `document_parse` / `ChunkParseResult`;
differing text and layout inputs use `vision_parse` / `OcrPageParseResult`.
The scorer requires one matching route record and retains schema, preparation,
per-unit attempt, total-call and context checks. Legacy `document_parse`
process/source-stage annotations follow the selected OCR route while retaining
question identity and unit indexes. Gold files, strict content comparisons and
quality thresholds are unchanged. Preserve 6.3.0 and 6.4.0 reports; cross-version
baseline comparison remains blocked. Scorer 6.5.0 removes the independent AI review
stages and requires a fresh three-repetition baseline.

For unsplit UTF-8 text/Markdown whose Tencent text differs, bounded original text
may accompany OCR as character/label comparison context. It does not enable the
original-text source-presence or deduplication proofs. Oversized context is omitted
before model admission; failed or uncertain provider submissions are not replayed.

Fixed Tencent figure crops may accompany OCR for visual classification in the
same bounded model call. Models cannot invent figures or change coordinates.
Unassociated document figures retain empty question associations, checked crop
artifacts, full-page references and human-review warnings. Diagram edge-cut checks
still reject unsafe crops; retaining an artifact does not establish semantic
completeness of detached labels. Passive projections never create crop artifacts.

## Scoring and gates

`qualityPassed` means an execution meets its expected status, all annotated fields and structures, visual-artifact checks, and process expectations. It is independent of execution status: `SUCCEEDED` can still fail quality, while correctly returning null for missing source answers can pass. Expected rejections are reported separately from normal-task success rates and failure timing.

`reliability` reports document execution success and quality pass rates. When every case has at least three repetitions, it also reports `allRepetitionsPassRate` and `anyRepetitionPassRate`; otherwise these are N/A. `reliabilitySlices` groups results by format, tag, and dataset split. Three repetitions do not establish production reliability confidence.

`fidelity` separately counts fabricated answers, extra questions, field inconsistencies, and questions needing source confirmation. Unmatched questions and source warnings are not automatically hallucinations; these counts cannot establish an overall hallucination rate.

Stem matching removes only leading question numbers and layout whitespace, preserving case, punctuation, and full content. It does not truncate stems or use case-insensitive keys. Production chunk-overlap merging requires matching source locations and actual overlap. Separately, repeated whole-question trees are detected across the document and retained by default; removal requires the explicit import option and equivalent source and business content. Identical stems match one-to-one in occurrence order. Extra questions reduce precision; missing questions reduce recall and field accuracy. Options are compared in label/content order, and answers use structured values consistent with the source gold labels.

| Metric | Numerator / denominator |
|---|---|
| questionPrecision | Matched questions / output questions |
| questionRecall | Matched questions / gold questions |
| answerModeAccuracy | Questions with the correct answer mode / gold questions |
| optionsAccuracy | Choice questions with correct options / gold choice questions |
| parsedAnswerAccuracy | Questions with correct source answers / gold questions, including null answers |
| structureAccuracy | Fully matched question structures / structural questions in gold or output, including missing and extra parents; checks material, mode, parent/blank/option-owner references, shared options, items, reuse policy, and gold-annotated choice/matching variants and blank counts |
| groupF1 | 2 × fully matched groups / (gold groups + output groups), checking titles and members |
| visualF1 | 2 × matched visuals / (gold visuals + output visuals), using multiset counts of kind and annotated page |

`choiceVariant`, `matchingVariant`, and `blankCount` participate in structure scoring only when the gold value is non-null; omitted or null values are unannotated and do not require an absent output field. An annotated variant or count is sufficient to include a question in structure scoring even without material or references.

Metrics range from 0 to 100. A missing denominator yields N/A; an explicitly empty annotated structure with an empty output scores 100. Overall metrics use micro-averages over questions or structures, with breakdowns by format, question type, and tag.

Gates require all annotated overall quality metrics to reach at least 90%, all normal cases to be `SUCCEEDED`, all expected rejections to match, and all critical cases to have no discrepancies. Any question-structure mismatch also fails the gate, including in non-critical cases and when averaging would keep `structureAccuracy` above 90%. The `text-composites` regression case is critical. References are compared through matched questions, so changing parser-assigned IDs alone is not a mismatch. Parents participate in structure scoring even though they are excluded from answerable-question counts. Matched questions without source answers must never receive fabricated answers. Unmatched and extra questions in wholly answerless cases must also retain null answers. `PARTIAL` preserves results and stage failures but does not count as a normal-case success.

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

Scorer 5 adds structure scoring and a strict structure gate. Version 5.0.1 also checks annotated choice/matching variants and blank counts; version 5.0.0 omitted these fields and is no longer a compatible baseline. Version 4 reports can have `qualityPassed: false` for material/relationship errors while their overall status is `PASSED`; they are incompatible with the current comparator. A new three-repetition live baseline is required before making current extraction-quality claims. The scorer's offline regression tests validate the gate, not model quality.

## Offline fault probes and local review

The shared text/page and PRIMARY-page extraction instructions require explicit section titles and printed instructions to remain in groups even when no questions exist, using empty question associations. Units with neither questions nor explicit sections return empty questions and groups; page markers and CONTEXT-only headings do not create groups. Answer-only PRIMARY pages still return empty questions/groups and never copy questions from neighboring pages. Context enrichment preserves PRIMARY's existing unassociated groups and rejects additional unassociated groups, including duplicate copies, inside the model correction boundary. Existing support for completing groups associated with PRIMARY questions and remapping their indexes after question reordering remains in place.

Parser merge regressions cover section-only units with unassociated titles/instructions, including question truncation and explicit deduplication. These sections retain empty associations; groups whose owners were all removed are still discarded. An unassociated section can merge with an identical section in an adjacent text chunk only when its title and supplied instructions each uniquely locate the same source positions entirely inside the verified overlap. Missing or ambiguous source evidence, distinct source occurrences and separate pages retain their copies. Adjacent source-anchored composite continuations retain the lowest extraction confidence across their fragments, alongside existing material, review flags and source associations.

Text and primary-page graph tests check the complete model instructions and use model substitutes to verify persisted unit results, final output and call accounting; they do not establish live-model extraction accuracy.

`make verify` and CI run the full pytest suite once and convert its JUnit results into a fault-probe report:

```bash
python -m pytest --junitxml=reports/checks/probes.xml
python scripts/evaluate.py --probes reports/checks/probes.xml
```

Probes reuse tests for recovery, budgets, reference validation, converters, similar sources, and structured output. They distinguish recovery success, correct stopping, route validity, and preservation of unknown usage. Each parameterized scenario is one observation; missing, skipped, or setup-failed scenarios do not pass. JUnit records code and test fingerprints and the collected probe cases; stale or incomplete evidence returns BLOCKED. Reports from explicit `::` nodeid selection are also blocked because selection can omit parameter cases before collection. Test exception bodies are not exported. These results establish only deterministic fault-test behavior. Actual process restart remains NOT_ASSESSED in this probe summary. Isolated PostgreSQL tests in `tests/test_runtime_recovery.py` separately verify forced termination and recovery; they do not replace recovery acceptance against production persistent directories.

The `review_candidate` log event contains only task identifiers, format, status, and error codes. Save `practiq.events` message bodies as JSONL in a local persistent log directory, then generate a review queue:

```bash
python scripts/review_queue.py /absolute/logs/practiq.events.jsonl \
  --output reports/reviews/2026-09-18.json
```

All execution errors, `PARTIAL` results, and quality-review flags are selected. Other tasks are sampled at approximately 5% using format and a stable thread-identifier hash, not exactly 5% of every small batch. Runs are deduplicated, and replay does not change selection. The queue contains only metadata. Reviewers read source material through existing authenticated task APIs and record decisions. Confirmed problems are de-identified and given gold labels before entering the regression set. This process does not automatically classify problems, change prompts, or publish releases. JSON/Markdown outputs cannot overwrite existing files, and generated reports need not be committed to Git.

The CLI reads JSONL events incrementally and retains only one metadata record per unique run for deduplication. The scorer indexes normalized stems while preserving the earliest unused prediction across aliases and duplicates. See the [synthetic tooling benchmark](../../docs/evidence/2026-10-13-shortcut-upgrades/README.md) for measured speed, memory costs and reproduction steps; these measurements do not establish model quality.

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

All agents share the model and fixed Responses protocol in `llm.py`. `AI_STRUCTURED_OUTPUT_METHOD=function_calling` is the default, and `auto` also uses function calling. `json_schema` is rejected before model work; the former Chat Completions native-schema branch is removed. Response arguments still pass the shared local strict validation and correction/accounting boundary.

Qwen3.7 calls disable thinking; model, token limits, and timeouts still come from existing configuration. Native mode receives the complete response before Pydantic validation, avoiding early SDK truncation errors that lose usage. Unclosed JSON and semantic validation failures enter the existing bounded correction and usage-recording path. Explicit token truncation cannot be accepted through local JSON repair: the unit stops after that paid attempt with `OUTPUT_TRUNCATED`, retaining its result receipt and usage instead of automatically requesting the same source at the same output limit again.

See the [optimization record](../reports/evaluations/prompt-optimization-summary.md) for protocol-selection evidence and live-run limitations.

Tool-call count, names, and argument structure are checked before using SDK-parsed objects; raw tool arguments take priority. Native JSON Schema and structured objects without tool calls remain subject to the same business validation. Group indices reject booleans, floats, and numeric strings. `isCorrect` and `needsReview` reject string/number coercion to booleans. Semantic descriptions of key fields and figure coordinates are sent with the schema; valid drafts, false, zero, and null retain their meanings. Truncation remains `OUTPUT_TRUNCATED` after one paid attempt and does not allow manual retries with unchanged parameters.

Local JSON Repair is integrated into shared response validation: it closes brackets, removes trailing commas before closing brackets, and strips complete code fences before rerunning the original schema/content checks. Repair adds no model calls, and missing fields remain incomplete. Unfinished strings, missing values, and type/content contradictions still enter bounded correction; explicit token truncation stops the unit. Repair does not relax quality gates.

Responses function-call arguments are validated from their original JSON, before accepting SDK-normalized objects. Duplicate keys within an object, including nested or Unicode-escaped keys, are rejected and enter bounded correction rather than silently replacing earlier content. This also applies after punctuation repair. Missing elements such as `[,]` are rejected rather than repaired into empty arrays; each paid correction retains its usage record.

### Failure limits and quality visibility

Gold labels for `text-source-identity` preserve stems that differ in case and questions with identical stems but different options. Offline tests cover chunk offsets, ambiguous sources, same-source content conflicts, early stopping on repeated invalid output, and retry limits. Live evaluation still runs baseline and candidate three times on the same dataset; gold labels are not changed to pass gates. Empty stems in valid drafts count as unmatched. Null answer modes appear in the report's `unknown` bucket while remaining null in the original result. `processing.questionSources/quality` provides only source and review hints. It does not change quality scoring or prove semantic validation of images or answers. Failure reports reuse graph failure classifications and remaining retry counts.

Compare call counts, known input/output tokens, and unknown usage alongside the original quality gates. If the baseline itself failed, formal comparison remains BLOCKED. Measured differences may be reported, but non-regression acceptance cannot be claimed. Durable recovery also requires the isolated local persistent-storage exercise in [operations.md](operations.md).

Human-defined synthetic gold labels added on 2026-09-18 cover embedded instructions, consolidated answers, and four-page material with answers on the last page. Together with existing two-column diagrams, tables, and answerless-source samples, they retain the 90% metric threshold and the requirement that every critical case pass. Source data is entirely human-constructed and contains no user material. The PDF contains a fixed four-page English observation log and one question/answer. Evaluation PASSED/FAILED is separate from execution success. Prompt changes cannot be accepted by lowering thresholds or deleting failing samples.

### Diagnose model validation failures

Each model call's `validationIssues` records failing field paths and Pydantic error types, up to 20 entries. Unknown field names become `?`; field values, source text, and exception context are excluded. Locate `calls` for the failed case/repetition, then distinguish structural errors such as `list_type`, truncation, business validation, and final scoring differences. HTTP success and task completion do not imply gold-label quality acceptance.

A captured response whose `questions` string wraps the remaining object fields is retained as an offline regression sample in `tests/fixtures/stringified-page-arguments.json`. Such responses remain rejected: trailing fields are not discarded, and content is not guessed. Shared correction explicitly requires real arrays and separate top-level fields; usage is counted normally. Initial prompts also specify array structure. The service applies the Qwen3.7 thinking parameter only when its configured endpoint matches the Bailian endpoint. Other custom endpoints do not receive this provider-specific parameter; clients do not configure providers.

An experiment with `vl_high_resolution_images=true` on Bailian Qwen3.7 improved a scanned sample but introduced duplicate questions and missing answers in long PDFs during full regression, so the parameter was not adopted. A single improved high-resolution sample does not establish overall quality improvement. See [Bailian's vision documentation](https://help.aliyun.com/zh/model-studio/vision) for image parameters. Strict character scoring and human-review flags remain in place.


## Scorer 6 evidence and release checks

`expectedEvidence` annotates exact source fields (including an explicit null), such
as `analysis`, `sourceScore`, `scoringRubric`, `scoreSourceText`, `sourceText`,
`questionKind`, language/writing metadata and listening instructions. Only
annotated fields are compared; any mismatch blocks the gate even in a noncritical
case. Text normalization changes whitespace only, not meaning. Do not rewrite
gold labels to match model output.

`expectedSources` uses question indexes plus `stage` and `unitIndex` to verify
page/chunk attribution independently of generated IDs. `expectedVisuals` may
annotate `questionIndexes` for every visual in a case (an empty list means
unassociated document material). Association errors also block the gate.
Scorer 6 reports cannot be compared with earlier scorers; establish a new passing
three-repetition baseline before claiming non-regression. Offline tests verify the
scorer, not the model.

Grading stability runs now repeat **every** text and image case, defaulting to ten
repetitions (explicit range 1–100). Each case reports graded/failed counts, mean,
population variance, range, mean absolute error and maximum absolute error, all in
hundredths of a point. Missing scores remain failures and are excluded from the
numeric statistics. Non-matching or failed trials return exit 1; setup failure
returns exit 2. Reports are exclusively created and never overwrite earlier runs.

```sh
python scripts/evaluate_grading.py --live --repeats 10 \
  --output reports/grading/new-stability-run.json
python scripts/evaluate_grading.py --live --repeats 10 \
  --anchors /absolute/path/independent-anchors.json \
  --output reports/grading/new-human-anchor-run.json
```

External anchors have `labelProvenance` (annotator/source and review date) and a
nonempty `cases` list. Each case has a unique `name`, integer `expectedCents`, and
`payload` containing the existing grading fields (`question`, `answer`,
`maxCents`, optional images/materials). Do not supply request IDs or digests.
Only use consented material; these calls send the payload to the configured
provider. Imported provenance is a declaration, not proof of independent review.
The bundled synthetic anchors cannot establish teacher calibration.

The [October 9 grading format experiment](../../docs/history/performance/performance-grading-arrays-20261009.md)
records three repetitions of these five fixed anchors before/after an array-only
instruction. Its passing score checks are independent of the failed full parsing
baseline; they do not establish general grading or extraction acceptance.

For the complete question-type input and expected-content checklist, see [the 16-type sample](../../app/fixtures/ai-import/README.md). The combined TXT is a manual service/Web extraction and offline app acceptance document; individual cases are scored by the existing manifest.

### Incomplete exports (2026-09-29)

Missing content does not block an export. Individual omissions are recorded in
`questions[].missingFields` (for example `stem`, `answerPayload`, `options`,
`material`, `media`), with `needsReview=true` and absent values left null. A missing
renderable source formula is flagged as `material`; it does not discard the question.
No reference answer is generated to fill a gap.

`result.missingFields` records document-level `questions` or `media` omissions.
Failed parsing units, truncated question extraction, and zero extracted questions
produce an exportable `PARTIAL` result; `processing.failures` retains unit indexes,
reason codes and retry eligibility. A zero-question result has confidence zero.
Storage/checksum, authorization and invalid contract boundaries remain enforced.
An empty missing-fields list is not proof that every printed question was found.

Desktop question-bank ZIP exports retain these document flags across import/export,
as well as question-level flags and nulls. The existing import warning storage
preserves the stable `PRACTIQ_MISSING:questions` / `PRACTIQ_MISSING:media` codes;
ZIP export derives `missingFields` from those codes, never from translated prose.
Empty banks can be exported, including retained document-level source images.

The no-question evaluation fixture now expects `PARTIAL` and
`expectedMissingFields=["questions"]` instead of `NO_QUESTIONS_FOUND`; this is an
explicit acceptance-rule change, not improved extraction quality. Mixed-format gold
questions and their expected count remain unchanged.

Model-only schema construction requires core evidence and matching item sides/IDs
without forcing every unrelated type-specific question field. Fully encoded JSON
arrays are decoded once, then subjected to the same validators; malformed or
truncated strings are not accepted. Derived review labels and inapplicable scalar
counts can be normalized without changing supplied answers or options. Final
question-tree validation attributes conflicts to the originating unit, allowing
partial export and explicit retry instead of an uncaught merge error.

Figures receive a bounded review against the source page and proposed crop. The
review checks table headers/last rows, chart titles/axes and material-versus-answer
roles. Unverified crops are withheld with `CROP_UNVERIFIED`, `media` and review
flags; the source page remains available. Explicit answer headers retain answer
protection. Figure-associated questions retain review flags even when the second model agrees.
Role correction also runs when crop completeness remains unverified; table header
evidence tolerates equivalent rendered/LaTeX formula spelling.
These model checks do not replace visual acceptance. They share the
existing four-call unit budget and per-call accounting, including failed checks and
checkpoint recovery; no extra retry budget is introduced.

### PR 83 review corrections

The outcome gate requires exact document `missingFields` sets, including for
`PARTIAL` cases. Grading anchor file, JSON and schema errors exit with code 2
before reserving output or making model calls. Writing-language omissions stay
null: prose matching cannot reliably distinguish alternatives, quotations and
actual response-language requirements.

A provider authentication/connectivity failure during figure verification stays
an attributed retryable page failure, with call usage preserved. It is not
converted into non-retryable `CROP_UNVERIFIED`.

`visualElements[].documentOnly` defaults to false. Zero-question imports mark
retained source visuals true; those visuals cannot also reference question IDs.
Desktop storage and ZIP exports preserve them without attaching them to unrelated
questions, including when appended to an existing bank or reimported from ZIP.
No database migration is required. Desktop validation rejects malformed
`missingFields` before adding derived missing-content flags.

The shared figure allowance is not increased: exhaustion after a transient
provider failure preserves that failure's retryability. An existing answer role
cannot be downgraded by the verifier. Structured arrays must be arrays on the
wire; quoted JSON arrays follow the usual validation/correction path.

For the frozen-source ten-format preparation and unresolved acceptance work in #90, use the [import quality worksheet](../../docs/acceptance/import-quality-acceptance.md).


## Fully answerless PDF regression fixture (#113)

`pdf-no-answer` adds one original synthetic, one-page PDF with two single-choice questions. This is an AI-assisted maintenance fixture, not independent contributor evidence or real-model acceptance. It is wholly answerless: the arbitrary sample assignments are not supplied, and the gold does not solve either question. Both answer payloads are null; analysis, source score, scoring rubric and score-source text are explicitly absent. The case is a critical regression with `sourceHasNoAnswers: true` and the existing PDF `vision_parse` process requirement. Existing gold entries, holdout labels, scorer and thresholds are unchanged.

The complete printed source is:

```text
Synthetic worksheet
Choose one option for each item.
1. Which tag was assigned to Sample Cedar?
A. Amber
B. Indigo
2. Which route was assigned to Sample Juniper?
A. Harbor
B. Meadow
```

Offline source review on 2026-10-04 checked the rendered page and extracted text against these lines and the two gold stems/options. The PDF contains no supplied answers, answer key, explanation, scoring instructions, rubric or scores; it has no annotations, attachments or form fields. SHA-256: `18aa64f287c98429dc71e7d2b612d568e6f9eefffadcb580962757cbb725b4cd`. The focused scorer regression accepts the unchanged null-answer output and rejects a fabricated answer on a matched, extra or rewritten/unmatched question, as well as fabricated grading evidence. These deterministic checks do not measure model extraction quality.

Reproduce the 974-byte PDF from the repository root with the existing Python 3.14+ interpreter. This fixture-only writer uses the standard library, plain ASCII source and the PDF standard Helvetica font; it adds no service dependency or parser:

```sh
AI_PYTHON=/absolute/path/to/python3.14
"$AI_PYTHON" - <<'PY'
from pathlib import Path

lines = [
    (18, 54, 786, "Synthetic worksheet"),
    (12, 54, 756, "Choose one option for each item."),
    (12, 54, 706, "1. Which tag was assigned to Sample Cedar?"),
    (12, 72, 678, "A. Amber"),
    (12, 72, 654, "B. Indigo"),
    (12, 54, 602, "2. Which route was assigned to Sample Juniper?"),
    (12, 72, 574, "A. Harbor"),
    (12, 72, 550, "B. Meadow"),
]
content = "".join(
    f"BT /F1 {size} Tf {x} {y} Td ({text}) Tj ET\n"
    for size, x, y, text in lines
).encode("ascii")
objects = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
    b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    b"<< /Length " + str(len(content)).encode("ascii") + b" >>\nstream\n"
    + content + b"endstream",
]
pdf = bytearray(b"%PDF-1.4\n")
offsets = [0]
for number, body in enumerate(objects, 1):
    offsets.append(len(pdf))
    pdf.extend(f"{number} 0 obj\n".encode("ascii") + body + b"\nendobj\n")
xref = len(pdf)
pdf.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode("ascii"))
for offset in offsets[1:]:
    pdf.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
pdf.extend(
    f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode("ascii")
)
Path("server/evals/fixtures/pdf/pdf-no-answer.pdf").write_bytes(pdf)
PY
```

Run the offline checks from the repository root:

```sh
"$AI_PYTHON" server/scripts/evaluate.py --validate-only
(cd server && PYTHONPATH=src "$AI_PYTHON" -m pytest tests/test_evaluation.py)
make verify AI_PYTHON="$AI_PYTHON"
```

The first two commands validate the dataset and scorer with substitutes. Complete `make verify` before delivering the fixture change; it remains separate from paid/live model evaluation.

## Composite option ownership

Verify material membership (`parentId`) separately from shared options (`optionSourceId`). A word-bank parent owns shared choices; a cloze child retains its printed local choices and leaves `optionSourceId=null`. Do not move those choices onto a cloze parent to satisfy a failed shared-options validation. Complete trees whose parents, children and blank references are anchored to the current unit are validated within the existing correction loop; IDs are never guessed or rewritten to pass. Incomplete trees and external continuations remain subject to final merge validation. Keep the failed attempts and their known usage in the report; a stopped page remains a partial result. Freeze fresh prompt and source fingerprints before a follow-up live run.

When an emitted `optionSourceId` resolves to a question in the current unit, its
owner must be a word bank and must equal the child's `parentId`. Reject inconsistent
local relations inside the existing correction loop rather than saving them and
discarding the page at final merge. Missing external owners still defer to merge;
the service never fills parent IDs or reconstructs passage blanks from answers.

Diagram candidates receive a four-percent page margin, clamped to the page, before
review so nearby labels remain visible. The review coordinates and candidate JPEG
use the same bounds. This margin does not establish completeness: uncertain checks
still prevent crop delivery, and saved crop bytes require independent verification.

The model schema asks for literal printed titles and question wording, including
local wording or hints for gaps without their own prompt. Standalone material
must remain in typed content parts, even when `sourceText` also quotes it.
An answer-only primary page supplies answer evidence through the existing page
context; it must not emit a copied question from a neighboring page. Verify these
rules with saved results and ZIPs; prompt instructions alone do not prove fidelity.

The model-facing schema requires `passage` and `contentBlocks` arrays, including
empty arrays when no material exists; the public import contract is unchanged.
Fresh grammar-fill and sentence-selection responses must retain their quoted
exercise title without the type prefix. When the quoted source explicitly shows
a numbered underscore gap, its number belongs to the blank marker, not adjacent
passage text. Violations enter the existing bounded correction loop; historical
checkpoint reads and text without that evidence remain unchanged.

The same title check covers explicit dash-separated exercise headings, including
word-bank, cloze, ordering, matching and explicit `Reading comprehension — title`
headings. Brief reading/listening audit references and inline `Reading: passage
text` are not treated as separately printed titles. A heading without title text
does not consume the next material line. All title discrepancies in a unit
are returned together through the existing correction loop.

Multi-page vision first extracts from PRIMARY alone. A second call may complete
those records using context pages followed by the primary image; ordinary question
IDs must remain exactly the same through the existing correction loop. Every
PRIMARY figure must also be retained during completion, keeping
its kind, bounding box and owning question IDs, with indexes remapped if questions
are reordered. Table text and rows may still be completed from context; the later
figure-verification pass owns bounding-box corrections. Original table rows/cells
must survive in order; extracted text and printed labels cannot disappear or be
rewritten, and an answer-bearing figure cannot become practice material. Context
may add rows and text without replacing PRIMARY content. Missing figures or changed
associations enter the same bounded correction loop. An empty
PRIMARY response skips context completion. Every PRIMARY composite parent must
retain its source ID and answer mode; omitting a parent enters correction even if
its children still refer to it as an external continuation. Drafts without stable IDs
retain their primary-only result rather than inventing IDs. Composite continuation
fragments and external parent references remain allowed. Both calls retain usage,
and page-context events record each model input window. The context draft omits
empty/default metadata while retaining extracted content, and remains subject to
the existing model-input limit. Context errors also carry prior known PRIMARY
usage to local callers; persisted call records remain available independently.
Each vision unit reserves a full correction loop for primary extraction and figure
verification, plus context completion when neighboring pages are supplied and the
three review passes when enabled. Reservations remain capped by the task-wide
model-call limit and are never refunded on resume.

A fresh ordinary question whose declared page anchor points outside PRIMARY is
also rejected within correction; its ID is never rewritten. These checks constrain
model output, not independent source truth: first-pass omissions or inventions
still fail the frozen live quality checks. Historical checkpoint loading does not
activate the scoped context-identity constraint.

For proven overlap at the same unique source position, an omitted type ID and a
built-in label matching the resolved kind/mode compare as metadata. The output
keeps its original type ID, nulls, review flags and source associations. Custom type
IDs and other content differences still conflict; ambiguous locations and actual
repeated source questions are retained. Saved-output replay verifies this merge
rule but does not replace fresh live evaluation.

Mixed numbered and unnumbered exercise headings do not establish an exact record
count or a complete source-ID set. Preserve the existing source spans and let the
model extract every exercise; a numbered child under a reading heading must not
make the entire document a one-record source. Explicit permission to reuse matching
paragraphs/items maps to `many_to_one`; missing policy stays null.

## Grading format Badcases

The [version-1 array-field corpus](../evals/badcases/grading-arrays-v1.json) adds four offline response-validation cases with explicit schema criteria and provenance to the real failure report. `test_invalid_grading_arrays_retain_usage_and_cached_score` evaluates bounded correction, retained usage and exact cached reference scores. These reconstructed invalid values are model substitutes, not additional live-model inputs or grading-quality labels; the frozen parser manifest and five live grading anchors remain separate.

### Source-bound structure and crossing-label corrections (2026-10-21)

For new Tencent OCR output, explicit composite headings with their supplied
material require a composite parent, rather than an answered ordinary replacement.
A unique verbatim passage match may separate a title/body newline lost by OCR;
this validates the printed title without synthesizing a passage or answers.
Native Excel `table_name` remains the worksheet group for all page questions,
including parents. Inferred column headers do not create section groups; explicit
`Section:` boundaries remain supported. Violations use the existing bounded model
correction loop, not a new parser or a fallback recognition path.

The original Tencent figure `bbox` stays immutable. A separate optional
`cropBbox` records actual crop bounds only for source-bound label recovery: a
standalone OCR label must cross that figure boundary, appear literally in the
figure's own Tencent text, and have a unique crossing association. Recovery adds
at most 25% area, includes no other OCR element in the added region, and is
skipped for pages with more than 1,000 elements. Detached/ambiguous labels and
nearby answer text retain the original crop failure. The final diagram still
passes the unchanged source-image cut-ink guard, byte limits and checksum checks.
Models cannot supply either coordinate change; both bounds and the complete
source page remain available for review. Partial projections still perform no
new writes. These rules do not establish semantic completeness for arbitrary
unrecognized labels, or prove that OCR omitted no surrounding text.

When OCR supplies exactly one unambiguous heading of a type, new-output title
checks use that source heading even if the model omits it from `sourceText`.
Native table XML cells supply literal display text instead of formatted column
aliases that may substitute underscores for spaces. Multiple distinct titles or
unresolved body boundaries remain ambiguous. Numeric item labels delimit merged
ordering/matching headings; explicit `(one-to-one)` qualifiers retain their
matching policy. Native worksheets allow only their sheet group and literal
`Section:` groups. These are validation constraints in the existing correction
loop; no questions or answers are generated from the hints.

For blank passages, a unique match of source words and printed gap positions can
validate punctuation between those positions and attached sentence endings;
whitespace wrapping is ignored for this validation. Ambiguous/overlapping matches,
unknown material and placeholder collisions establish no proof. This does not
prove that the entire passage was extracted. A unique numbered `Hint:` line with
one local grammar parent/child keeps the child hint separate from shared material
and requires blankCount=1. Unique-title enforcement likewise defers when several
records use that answer mode; it must not assign an unheaded parent to another
exercise's sole printed title. All checks request bounded correction and retain
the original source; none rewrite answers, fill a missing question or relax gold.

Choice stems cannot duplicate a separately extracted option after the question
mark when Tencent evidence confirms that boundary. Word-bank/cloze children with
an assigned parent blank cannot duplicate that gap marker and attached sentence
ending when their wording is exactly the preceding passage clause. The original
markers and punctuation stay on the parent. Separately printed child wording and
hints are preserved; uncertain clause boundaries are not synthesized. These
checks correct model field assignment without adding aliases or changing scoring.

An OCR fill-blank equation whose LaTeX command and equals sign are dollar-wrapped
but whose final blank is outside that wrapper enters bounded correction. Keep the
complete unsolved equation, exact underscores and punctuation together; readable
math symbols belong in the stem and LaTeX conversions in formula blocks. Currency
and surrounding prose are not treated as equation-only wrappers. Saved records
are unaffected; this validation applies only to active vision extraction.

For cost-limited incremental acceptance, freeze a complete three-repetition report
as the baseline. Carry its passed slots forward without invoking the graph; replace
only failed slots with already-saved successful focused results or new model work
using verified local Tencent archives. Record each slot's original report,
repetition and code hash. Block Tencent submission, polling, download and staging
in the replay harness; a missing or invalid archive must stop rather than fall back
to Tencent. Label this incremental acceptance across code versions, not a fresh
same-version live three-round evaluation. Preserve the original failures and apply
the unchanged scorer and quality gates to the assembled 90 slots.

Verified crop bounds follow every figure classification, including charts. An
existing Tencent subimage does not satisfy an expanded crop: active finalization
re-crops the source page and retains a failure if the source page is unavailable
or the unchanged boundary check rejects it. Unknown coordinates of any other
element suppress label repair. Retained Tencent subimages also provide bounded
figure previews for Office pages without a rendered page image. Optional original
text uses the same complete-message character accounting as the model limiter,
including figure prompt text, delimiters and additional message metadata. Native
worksheet aliases with non-string values remain source evidence but are never
used as group identifiers.
