# Grading array-format experiment (2026-10-09)

Baseline: `7920df81f7dbf0096eff45c5ab5d61fd5952e8b4`. The existing subjective grader returned the correct score for every bundled anchor, but each of three image-anchor runs first returned `evidence` or `reviewReasons` as a string/null rather than an array. Local validation rejected those responses and the existing bounded correction made an extra model call. Tell the model that both fields must be JSON arrays, with `[]` for no entries, never null or a quoted string. This is the only adopted experimental factor.

Keep the original question/context, grading reference/rubric, images, trust rules, schema validators, finite retry/call budget, durable receipts, unknown usage and explicit user grading/retry triggers. Parsing prompts and source extraction are unchanged. Roll back by reverting the two prompt lines; no API, data, backup or database migration is involved. Risk: a prompt may influence explanations on models and questions outside these five anchors. This small experiment establishes reference-score preservation on its fixed inputs, not teacher calibration or general grading quality.

## Fixed inputs and budget

Use the five existing rule-authored anchors in `server/scripts/evaluate_grading.py`: full, partial, wrong, embedded instruction and image partial credit. Their supplied reference/rubric gives expected scores 500, 300, 0, 0 and 200 cents. The image is the evaluator's original synthetic red square. The [raw reports and summary](evidence/2026-10-09-grading-arrays/README.md) preserve evaluator hash, driver/source hashes, every score, validation issue, usage and observed request duration. Neither anchor labels nor scorer thresholds were changed.

The user approved these inputs, Beijing `qwen3.7-flash-2026-07-15`, thinking disabled, output cap 16,384 tokens, cumulative CNY 10 / 1,200 outbound calls. Run each phase three times using the existing evaluator and a disposable PostgreSQL database. A temporary transport records unknown usage before dispatch, reserves CNY 1.30 worst-case per call, and stops if usage is unknown or the approved balance/call limit cannot cover another request. Costs use [published Beijing list prices](https://help.aliyun.com/zh/model-studio/qwen3-7-flash), without treating discounts/free tokens or unknown usage as zero. At evidence capture, the entire goal had 437 calls, CNY 0.6775372 known estimated cost and no unresolved unknown calls. The provider ledger contains only this experiment's phases; it is not an invoice.

Environment: macOS 27.0.1 arm64, Python 3.14.7, pinned service dependencies, existing LangChain/OpenAI-compatible transport and isolated PostgreSQL. Reference and schema were identical across phases. Network/provider state is uncontrolled; latency is a small observed sample, not stable tail latency or production capacity. A focused local test run overlapped the rejected null-context phase; its timing does not enter the adopted comparison.

## Results and decision

| Metric, three repetitions of five anchors | Original prompt | Array instruction | Conclusion |
| --- | ---: | ---: | --- |
| Exact reference scores | 15/15 | 15/15 | Preserved for these anchors |
| Model calls | 18 (6/6/6) | 15 (5/5/5) | Three format-correction calls avoided |
| Known input tokens | 19,892 | 16,149 | 18.8% lower in this batch |
| Known output tokens | 3,419 | 2,989 | 12.6% lower in this batch |
| Estimated cost, CNY | 0.0067136 | 0.0056210 | 16.3% lower; small absolute saving |
| Five-anchor elapsed median (range), seconds | 13.259 (12.568–13.265) | 11.935 (11.933–12.559) | About 1.324 seconds lower in these observations |

The failure mechanism repeats in all three baseline image requests and is absent in all three candidate image requests. Retain strict rejection and correction: a new prompt cannot guarantee that future models always obey the schema. The focused prompt regression covers Chinese/English feedback, partial credit, rescaling and cache replay; existing grading tests cover missing evidence, rejection, provider failure, unknown cost and cancellation/recovery. No parser quality improvement is claimed: the separate full parsing baseline still failed its existing gates and cannot serve as a passing non-regression baseline.

Four new offline Badcase regressions replay string/null values independently for each array field, retaining rejected-call usage and the corrected cached score. These use model substitutes and establish recovery behavior, separately from the real five-anchor comparison. Final `make verify` passed 1,757 tests with 93% combined coverage, lock consistency, Ruff, Pyright, evaluation fixtures, recovery probes and the package build. Latest-head hosted gates and Codex review remain required before merge.

An earlier array-hint sample had only one avoided call and was initially rejected as insufficient evidence. The new fixed grading-only baseline revealed the same image-array failure in all three repetitions, allowing a bounded repeat of the single factor. Retain the earlier record in the goal journal; do not retroactively describe its weak evidence as acceptance.

A separate candidate removed only null question fields. It preserved 15/15 scores and reduced input tokens to 18,231, but still used 18 calls; output grew to 3,777 tokens, cost stayed near baseline (CNY 0.0066678), and observed elapsed totals rose to 14.157/14.385/15.129 seconds. Revert it: reduced input alone did not justify the overall tradeoff. The adopted array candidate uses the original complete payload.

## Handbook correspondence and reproduction

Reference [aliyun/ai-agent-handbook](https://github.com/aliyun/ai-agent-handbook/tree/6d12dd2dc006eefd0f89f213c4e0ca2edfe7e9a8), pinned commit `6d12dd2dc006eefd0f89f213c4e0ca2edfe7e9a8`, read on October 9, 2026. Its task orchestration and state/context guidance map to the existing LangGraph stage completion, checkpoints and source fingerprints. Observability maps to call-kind/task associations, validation paths and durable usage receipts. Safety maps to treating assessment text/images as untrusted data and grading only against supplied references/rubrics. Golden datasets and Badcase guidance map to versioned human-defined anchors, repeated same-input evaluation, single-factor correction and retention of rejected experiments. These correspondences use the existing implementation; no new framework, multi-Agent workflow, RAG, vector store or cloud observation system is introduced.

After obtaining explicit budget approval and configuring service credentials privately, run `python server/scripts/evaluate_grading.py --live --repeats 3 --output /absolute/new-report.json` at baseline and candidate with identical settings. The repository evaluator does not enforce a currency budget itself: use an approved bounded transport/spend monitor for this experiment, never an unbounded provider run. The committed usage ledger and original reports make this completed run auditable; credentials, private databases and temporary storage are excluded.
