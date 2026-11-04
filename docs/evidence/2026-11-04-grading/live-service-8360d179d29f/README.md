# Authorized real-provider follow-up

The user authorized real-model calls after the initial automatic/native acceptance. This run used the configured `deepseek-v4.1-flash` model at `amr-link.open-design.ai` through the existing service grading code and Responses API. Inputs were the unchanged 26 AI-authored synthetic cases in `server/evals/grading-practice-v2.json`, with one repetition. They have no independent teacher labels.

| Observation | Result |
| --- | --- |
| Numeric grading | All 24 full/partial/wrong/instruction cases matched their declared scores |
| Conflicting rubric | Model abstained as expected |
| Missing reference/rubric | Service refused locally with zero provider work |
| Provider work | 26 requests for 25 model-evaluated cases, including one structured-output correction |
| Usage | 39,226 input tokens; 9,559 output tokens; usage known for all calls |
| Limits | At most 104 requests, 4,096 output tokens per request; concurrency 1; SDK transport retries disabled |
| Durable receipt replay | Replaying the first completed request added zero provider requests |
| Isolation | Fresh disposable PostgreSQL; removed after the run; no production task/study database used |
| Cost | Unknown: gateway monetary rates were not configured |

## Retained failure and offline correction

[report.json](report.json) is the unchanged initial **FAILED 25/26** report. Its only mismatch was `missing_reference`: the service correctly returned `ungraded` with a local reason and empty usage, but the evaluator accepted only a model abstention with `reviewReasons`.

A regression test first reproduced that false negative. The evaluator now recognizes this narrow local refusal only when there is no grading basis, a reason is present, and there is no result, model call or usage. Tests also reject a refusal with a supplied basis, a recorded call, nonempty/missing usage and an unknown provider outcome.

[rescored.json](rescored.json) is a separate **PASSED 26/26** offline rescore. Every response and the anchor hash match the original report; no labels or provider outputs changed and no extra provider request was made. It records the original report hash and updated scorer hash. The initial report retains the original scorer/source hashes. [calls.json](calls.json) preserves the failed schema-validation attempt as well as its successful correction; [cleanup.json](cleanup.json) records disposable database removal.

The scorer/evidence focused suite passed 29 tests and Ruff passed for the changed evaluator/test files. Full server verification (3,676 passing tests) predates this narrow evaluator correction; the live follow-up did not rerun that full suite. The [check record](checks.json) contains the final follow-up checks. [driver.txt](driver.txt) records the one-time live orchestration source, originally run from `app/.build/live_grading_service.py`; running it again incurs provider work and must use a fresh output directory.

## Limits

One repetition of explicit synthetic rules cannot establish consistency, rubric coverage, fairness or teacher agreement. `calibrationStatus` remains `NOT_ESTABLISHED`. This run invoked the real service grading logic directly; it did not exercise service HTTP authentication or the native Rust Chat Completions path against a real provider. The existing native UI/HTTP/store/backup checks used a loopback substitute and remain separately recorded. No release, notarization or clean-machine trial was performed.
