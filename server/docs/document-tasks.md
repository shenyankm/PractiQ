# Document task controls / 文档长任务控制

All five registered graphs use the same execution path and one required
`LLM_VISION_MODEL`. Remove `LLM_TEXT_MODEL` from deployment configuration. Images,
PDF and rendered DOCX pages directly return structured questions, groups and
figures. There is no OCR transcription or subsequent text-model pass. Text, CSV
and Excel send bounded source-text fragments to the same model.

页面单元携带上一页、本页和下一页图像（文档边界处减少），只提取**起始于本页**的题目。
相邻页用于续文、材料和原文答案；超过此窗口的内容保留为不完整草稿，不推断补全。
成功页面按页序合并，保留原文真实重复题。补跑失败页面不重跑成功页面，也不重建文本 chunk。
DOCX 内嵌原图仍独立描述并保留原图引用，不另起 OCR 调用。

## API

Every route requires `Authorization: Bearer <AI_SERVICE_TOKEN>`. Upload the file
using `/api/uploads` and its returned PUT URL first. Use the returned `document`
unchanged. Unknown input fields, raw state, node names, paths and model results
are rejected.

```python
from uuid import uuid4
import httpx

# document is the verified reference returned by the upload API.
with httpx.Client(base_url="http://127.0.0.1:8090",
                  headers={"Authorization": f"Bearer {token}"}) as client:
    request = {"requestId": str(uuid4()), "graphId": "document_parser",
               "document": document, "failurePolicy": "return_partial"}
    response = client.post("/api/document-tasks", json=request)
    response.raise_for_status()
    task = response.json()
    path = f"/api/document-tasks/{task['threadId']}"

    pause = {"requestId": str(uuid4()), "action": "pause", "runId": task["runId"]}
    client.post(path + "/control", json=pause).raise_for_status()
    # Poll until PAUSED; PAUSING means in-flight work is still being saved.
    state = client.get(path).json()
    if state["state"] == "PAUSED":
        client.post(path + "/control", json={
            "requestId": str(uuid4()), "action": "resume",
            "checkpointId": state["checkpointId"],
        }).raise_for_status()
```

`graphId` defaults to `document_parser`; other values are `text_csv_parser`,
`pdf_parser`, `docx_parser`, `excel_parser`. Optional `parentThreadId` links a
new parsing task without replacing the parent. Create/control return HTTP 202
with `threadId`, `runId`, `requestId` and `accepted`. Acceptance is not completion.

`GET /api/document-tasks/{threadId}` returns `state`, `phase`, committed
`progress.visuals/chunks` (total/succeeded/failed/remaining), `failures`, `blocking`,
`allowedActions`, `checkpointId`, `expiresAt`, `status`, `result`, `processing`,
`usage`, and `unknownUsageCalls`. Execution state and result quality are separate:
`COMPLETED` may have `status="PARTIAL"`. Running events remain available through
native Agent Server streams; GET reconstructs progress without client history.

| Execution state | Controls |
| --- | --- |
| RUNNING | `pause`, `interrupt` with target `runId` |
| PAUSING | `interrupt` with target `runId` |
| PAUSED / INTERRUPTED | `resume` with latest `checkpointId` |
| WAITING_REVIEW | `retry_failed` only for eligible failures; `accept_partial` only with usable results |
| FAILED | `resume` for unfinished nodes; `retry_failed` for recorded retryable units |
| COMPLETED + PARTIAL | `retry_failed` for recorded retryable units |
| COMPLETED + SUCCEEDED | Read or create a new task |

Use `allowedActions` rather than assuming an error can be retried. Failed input
validation, invalid crops and execution-version mismatches are not automatically
retriable. Normal resume does not retry a completed PARTIAL result.

```json
{
  "requestId": "11111111-1111-4111-8111-111111111111",
  "action": "retry_failed",
  "checkpointId": "<latest checkpointId from GET>",
  "units": [{"stage": "vision_parse", "index": 1}]
}
```

Indices are zero-based. Valid failure stages for retry are `vision_parse`
(page), `vision_describe` (embedded image), and `document_parse` (source-text
fragment). Omit `units` or send `[]` to retry every recorded retryable failure.
Only failed units with remaining retries are eligible. Each `(stage, index)` may
start at most **two additional rounds** after its initial attempt. Counts are
checkpointed before new calls; pause/resume and duplicate request IDs do not reset
or increment them. Successful peers remain intact; final merge runs again.
All-fragment/page failure records remain available, including after exhaustion.

Each failure includes `retriesRemaining` (0–2). Exhaustion preserves the original
`code`, changes `retryable` to false and removes `retry_failed` when no eligible
units remain. Explicitly selecting an exhausted unit returns HTTP 409
`RETRY_LIMIT_EXCEEDED` without starting any part of that request. Omitted/empty
`units` selects only eligible failures; no eligible failures returns
`INVALID_RETRY_UNITS`. The native Graph and review controls enforce the same limit.

## Safety and replay boundaries / 暂停与重放边界

- `pause` persists a signal for one thread/run. New phases, batches and model
  attempts check it. Work that already passed the check may finish and save;
  later expensive calls stop. Store read/write errors stop scheduling.
- LibreOffice, extraction and synchronous threads are not forcibly terminated by
  safe pause. DOCX conversion has a 60-second timeout; preparation is bounded at
  180 seconds (a timed-out synchronous worker may finish in the background).
- `interrupt` uses native `cancel(action="interrupt")`, never rollback. It does
  not guarantee cancellation of an already accepted remote provider request.
- Resume keeps the thread and creates a new run. The API resumes all relevant
  interrupt IDs in one command. If normal completion wins a pause race, the
  query reports completion.
- Each unit/round has four model attempts, including validation corrections.
  Native durable tasks retain completed attempts across resume and artifact
  write failures. Ordinary resume never resets this budget; explicit failed-unit
  retry opens a new round within the two-additional-round limit. Correction uses
  the original task/source plus only the latest failed response and validation
  error. Two consecutive identical failed outputs AND errors end that round as
  `OUTPUT_STALLED`, except repeated truncation remains `OUTPUT_TRUNCATED`;
  transient transport errors do not count as repeated outputs. Truncation is
  rejected before JSON repair, retains its code through checkpoints and task
  failures, and is not eligible for manual unit retry. Varying failed outputs
  exhaust the same four-attempt budget and retain the last failure code. Old
  attempt checkpoints without a validation code default to `OUTPUT_INVALID`.
  The 3 × 4 logical-attempt bound is not a provider billing guarantee.
- A unique `callKey` identifies each real call. Known usage accumulates across
  recovery/retry and is deduplicated by this key. An interrupted request without
  a confirmed response remains in `unknownUsageCalls`; it is not zero cost.
  Unconfirmed work can replay and be billed again. Provider-side exactly-once
  execution is not promised.
- Source and derived objects are verified by key, size and SHA-256 before use.
  Resume checks required objects before new model work. Changing model, output
  protocol, prompts/contracts, extraction rules, code or storage location is
  rejected by the execution snapshot. Credentials are excluded from snapshots.

## Idempotency and review / 幂等与人工决策

Every mutation requires a UUID `requestId`. Reuse the **same ID and body** after
network failure; a changed body with that ID returns 409 `REQUEST_CONFLICT`.
Pause/interrupt target one run, so delayed old requests cannot interrupt a later
run. Resume/retry/review require a fresh checkpoint; stale actions return 409.
Native single-thread run exclusion (`reject`) plus persistent execution admission
prevents duplicated model work even if a network race creates a no-op run.

Thread creation provides atomic insert-if-absent for immutable control receipts:
internal native threads with metadata `kind=document_control_receipt` reserve
request identity. They are not parsing tasks and have no runs. Task listing should
filter `kind=document_task`. Store alone is last-writer-wins and is not used as a
pretend compare-and-set lock. No application task table, queue or private Agent
Server database access is added.

`failurePolicy="return_partial"` remains the default. `"review"` pauses after a
phase with processing failures. Choose `retry_failed`, or `accept_partial` using
only a fresh checkpoint and request ID. No usable result means no accept option.
Missing business fields, low confidence and `needsReview` retain draft semantics
and alone do not trigger a decision. Crop failures can be accepted but cannot be
blindly retried.

At the result stage, `"review"` also pauses for `SOURCE_TEXT_NOT_FOUND`,
`AMBIGUOUS_OVERLAP` and `OVERLAP_CONFLICT`. The interrupt payload keeps `kind`,
`stage`, `failures`, `canAccept` and adds `qualityIssues` (old payloads may omit it):

```json
{
  "kind": "review",
  "stage": "result",
  "failures": [],
  "qualityIssues": [{"questionIndex": 0, "code": "SOURCE_TEXT_NOT_FOUND"}],
  "canAccept": true
}
```

For quality-only review, GET reports `WAITING_REVIEW` and
`allowedActions: ["accept_partial"]`. Submit the existing control with
`action="accept_partial"`, a new `requestId` and the latest `checkpointId`.
Accepting preserves result content, execution status and all quality flags;
it does not certify correctness. `return_partial` never blocks for these issues.
`MISSING_FIELDS` and ordinary `NEEDS_REVIEW` alone remain non-blocking drafts.
Quality issues are not failed units and cannot be selected for `retry_failed`.
If recorded execution failures also remain retryable, retry follows the existing
unit budget and routes back to that processing stage before merging again.

## Quality and source provenance / 质量与来源

`processing.questionSources` maps final `questionIndex` to `stage`
(`document_parse` or `vision_parse`) and zero-based `unitIndex`. A question merged
from two overlapping fragments has two source entries; indexes match the final
question list and groups. Text checkpoints retain character offsets in the verified
extracted-text artifact and actual overlap ranges beside chunk references, not another copy of the
whole source text.

Text overlap is removed only for adjacent fragments with identical extracted
content and one unique `sourceText` match at the same original position wholly
inside the overlap. Matching ignores whitespace only, preserving case and full
text. Missing/ambiguous locations or conflicting extraction retain both entries.
Genuine repeats at different source positions and all page repeats are preserved.

`processing.quality` defaults to
`{"reviewRequired": false, "reviewQuestionCount": 0, "issues": []}`;
`questionSources` defaults to `[]`. Each issue has `questionIndex` and `code`:

| Code | Meaning |
| --- | --- |
| `SOURCE_TEXT_NOT_FOUND` | Missing quote or quote not found in its source fragment |
| `AMBIGUOUS_OVERLAP` | Quote/overlap cannot identify one unique source occurrence |
| `OVERLAP_CONFLICT` | Same source position has different extracted content |
| `MISSING_FIELDS` | Existing `missingFields` needs review; consult the question |
| `NEEDS_REVIEW` | Other existing or rule-derived review flag |

Source/overlap issues force `needsReview=true` without deleting, rewriting or
retrying the question. Counts summarize final retained questions, not issue rows.
These are quality hints, not processing failures: `SUCCEEDED` can still require
review, and `failurePolicy="review"` does not pause for quality hints alone.
Page images have page provenance only; no text match or semantic correctness is
claimed. A matching quote does not prove that the extracted answer is correct.
No additional model call or automatic answer generation is introduced.

## Native API and retention

Native `{ "document": ... }` input and final output contracts remain available.
For reliable native continuation use the same thread, a new run, `durability="sync"`,
`multitask_strategy="reject"`, `recursion_limit=10000` and
`max_concurrency=2 * AI_GRAPH_MAX_CONCURRENCY` (default 4). The extra executor slots
are for durable child tasks; actual calls remain bounded by the configured batch
size (default 2). Do not override concurrency to 1 while a parent awaits a task.
Resume with null input or a native resume command as appropriate; do not supply an
old checkpoint to fork. The wrapper controls apply only to wrapper-created tasks.

The recovery deadline is creation plus 180 days. Reads do not refresh Store TTL
or the application's deadline. Controls and call records use the remaining window;
Agent Server removes expired checkpoints asynchronously. Files are retained.
Old unversioned checkpoints must execute on their original image. Drain old tasks
before switching, and retain paused tasks on their original deployment. Rollback
must not feed new checkpoints to old code. Migration copies and verifies objects
but does not make an incompatible execution snapshot resumable.

## Production crash drill

**Release gate, not established by unit tests or `langgraph dev`.** Use an isolated
standalone Agent Server with independent PostgreSQL, Redis and persistent test
storage. Never load the following hooks in a real deployment. Existing storage
volumes and production databases must not be used.

1. Start the countable fake HTTP provider on loopback using a development
   interpreter: `python scripts/recovery_provider.py --log /absolute/test/calls.jsonl`.
   It returns synthetic structured responses and fsyncs every call ID and token
   count. `GET http://127.0.0.1:8091/calls` exposes the test ledger.
2. Configure the isolated candidate with `LLM_PROVIDER=dashscope`,
   `LLM_API_KEY=fake`, `LLM_VISION_MODEL=synthetic-vision`,
   `AI_STRUCTURED_OUTPUT_METHOD=function_calling`. Set
   `PRACTIQ_RECOVERY_DRILL=1`, `PRACTIQ_RECOVERY_PROVIDER=http://127.0.0.1:8091`
   (or its isolated test-network origin), and `PRACTIQ_RECOVERY_DIR` to an existing
   persistent test directory. Use the candidate's normal auth, DB and Redis config.
3. Override the test deployment graph mapping to
   `{"document_parser":"/deps/server/tests/recovery_fixture.py:document_parser"}`.
   Hooks wrap the real model HTTP path and real file store; they do not replace
   checkpoints or access private database tables.
4. For each row below, use a **fresh test directory/provider log**, set
   `PRACTIQ_RECOVERY_POINT`, and upload a synthetic PNG. Create a task through the
   normal API. The hook fsyncs `<point>.fired` then exits the application process
   with code 86 once. Restart the **same image, configuration, DB and mounts**.
5. Query the saved thread. Allow native crashed-run recovery to finish; if it is
   INTERRUPTED/FAILED with `resume` available, resume its latest checkpoint.
   Assert the final question and crop exist, SHA checks pass, and all known usage
   keys are unique. Compare the call delta with the provider log.

| Point | Injection boundary | Expected provider calls for one page |
| --- | --- | --- |
| `before_request` | Durable call-start record, before HTTP request | 1 after recovery; an unknown start record may remain |
| `after_response` | HTTP response received, before durable result is confirmed | 2 allowed; unknown usage remains visible |
| `after_artifact` | Crop upload completed, before merge checkpoint | 1; retry storage/merge only |
| `after_checkpoint` | Merge/review checkpoint committed, before finish node | 1; preserve question, crop and usage |
| `after_retry_checkpoint` | Retry count committed, before retry batch | 3 with two initial invalid responses; retain retry count 1 |

For `after_retry_checkpoint`, start the fake provider with `--invalid-responses 2`.
Its log makes this counter survive provider restart. The first round stops with
`OUTPUT_STALLED` after two calls. Submit `retry_failed`, restart after the injected
crash, then resume; the single failed page succeeds with one further call and its
persisted retry count remains 1. Reusing the control request must not add calls.
In a separate run use `--invalid-responses 6`: exhaust both additional rounds,
verify `retriesRemaining=0`, no `retry_failed` action and explicit retry HTTP 409.
For a partial-result case include a successful peer and check its call count stays
unchanged. Compare final source mappings and quality flags before/after recovery.

Repeat all rows with `AI_STORAGE_BACKEND=local` on a persistent absolute path and
with `oss` using an independent private test bucket and real credentials. Also
exercise safe pause during correction, immediate cancellation, concurrent duplicate
controls, expired checkpoints, modified/missing source artifacts and execution
configuration changes. Record image digest, backend, thread/run/checkpoint IDs,
call-log deltas, unknown usage, final object hashes and pass/fail. Do not record
credentials or original private documents. Deployment remains gated until both
backend matrices pass.

The implementation reuses [Agent Server custom routes](https://docs.langchain.com/langsmith/custom-routes)
and [native persistence](https://docs.langchain.com/oss/python/langgraph/persistence).

## 任务预算与运行截止

查询新增 `modelBudget: {"limit": 400, "reserved": 8}`，表示总上限与已预留槽，
不是已计费调用数。gate 在派发前持久化单元额度，单元每次真实尝试前扣槽；
暂停、补跑、进程中断后的未知调用均不重置额度，未使用槽也不归还。
用量仍通过 `usage` 和 `unknownUsageCalls` 表达，不能用 reserved 推算账单。

单 run 默认 30 分钟执行窗口；新建恢复 run 重置执行截止，保留原任务调用预算。
任务 180 天恢复期限保持不变。新的直接 Python graph 调用必须显式提供 Store、
thread_id 和 run_id；离线测试可使用 InMemoryStore，生产由 Agent Server 提供。

完整配置、静态 provider 配额和本地/生产验收区别见 [运维说明](operations.md#资源边界与本地验收)。
