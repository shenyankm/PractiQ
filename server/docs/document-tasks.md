# Create, control, and review document tasks

This guide covers task creation, polling, pause, resume, and human review. Three graphs share LangGraph checkpoints, Store, and a persistent SQLite queue. Subjective grading uses a [separate endpoint](service-guide.md#request-subjective-grading).

## Create and query

First obtain a `document` reference through the [authenticated upload API](service-guide.md#import-workflow). This example omits the reference fields; replace the `document` string with the complete returned object before sending:

```json
{
  "requestId": "11111111-1111-4111-8111-111111111111",
  "graphId": "document_parser",
  "document": "Replace with the complete reference object returned by upload",
  "failurePolicy": "return_partial"
}
```

`POST /api/document-tasks` returns HTTP 202 with `threadId`, `runId`, `requestId`, and `accepted`. A 202 response means the task is durably queued, not that parsing has finished. All business APIs require `Authorization: Bearer your_service_token_here`, using `AI_SERVICE_TOKEN`.

`graphId` accepts `document_parser` (the default, for all formats), `text_csv_parser`, or `pdf_parser`. Optional `parentThreadId` links only to an existing task in the new runtime and does not overwrite it. Unknown fields, raw state, URLs, Base64, server file paths, and client-supplied model results are rejected.

`GET /api/document-tasks/{threadId}` returns `threadId`, `runId`, `parentThreadId`, `fileName`, `modelConfigured`, `resumeCompatible`, `state`, `phase`, `progress`, `failures`, `blocking`, `allowedActions`, `checkpointId`, `expiresAt`, `updatedAt`, `status`, `result`, `processing`, `usage`, `unknownUsageCalls`, and `modelBudget`. Before the first checkpoint, it returns an opaque `pending:<runId>` token used only for task control. This is not a LangGraph checkpoint; clients must not parse or construct it.

`DocumentTaskDetail` in `contracts.py` is the authoritative response model. The existing exporter derives `taskDetail` in `app/src-tauri/contracts.json` and `DocumentTaskDetail` in `app/src/contracts.generated.ts`; `app/scripts/export-contracts.py --check` rejects field, nullability, state, phase, or action drift.

All detail fields are present. `runId`, `parentThreadId`, `checkpointId`, `status`, `result`, and `processing` can be null. `status` is `SUCCEEDED`, `PARTIAL`, or null; a running task may retain a previous result. `modelConfigured` reports whether the service has model settings, and `resumeCompatible` also checks the saved execution signature. `allowedActions` describes the saved task state; these flags do not start work or replace the model configuration and signature checks performed during control.

`phase` is `pending`, `prepare`, `vision`, `chunk`, `vision_review`, `chunk_review`, `result_review`, `result`, or `completed`. `progress.visuals` and `progress.chunks` each contain `total`, `succeeded`, `failed`, and `remaining`. Failures reuse `UnitFailure`: `stage` is `document_parse`, `vision_parse`, `vision_describe`, or `visual_crop`, with `index`, `code`, `retryable`, and `retriesRemaining`. Failure messages are resolved by clients from codes. `blocking` preserves saved interrupt payloads or error codes. `usage` contains completed `ModelCallUsage` records, and `unknownUsageCalls` lists call IDs whose usage is uncertain. `modelBudget` contains `limit` and `reserved`.

Expired detail requests still return HTTP 410 / `TASK_EXPIRED`; the list endpoint exposes the `EXPIRED` state. Authentication and error response shapes are unchanged.

Choose controls from `state` and `allowedActions`:

| State | Available controls |
|---|---|
| PENDING / RUNNING | pause or interrupt with the target runId |
| PAUSING | interrupt |
| PAUSED / INTERRUPTED / CANCELLED | resume with the latest checkpointId when allowedActions permits it |
| WAITING_REVIEW | retry_failed / accept_partial as specified by allowedActions |
| FAILED | resume unfinished nodes or retry_failed for eligible failed units |
| COMPLETED | retry_failed for eligible failures in a PARTIAL result |

An explicit `interrupt` reports `CANCELLED` once stopped; process interruption reports `INTERRUPTED`. Neither automatically resumes. A cancelled task retains its saved work and can resume only through an explicit allowed action.

State and quality are independent: `COMPLETED` may contain `PARTIAL`, and `SUCCEEDED` may still require content review. Progress reflects only persisted data. Clients poll with GET and do not use native SSE, thread, run, or Store APIs.

## Controls and idempotency

Submit controls to `POST /api/document-tasks/{threadId}/control`. For example, resume a task:

```json
{
  "requestId": "22222222-2222-4222-8222-222222222222",
  "action": "resume",
  "checkpointId": "Copy unchanged from the latest GET response"
}
```

Each mutation uses a UUID `requestId`. Replaying a request, including concurrently, returns its original receipt even after execution has started or the checkpoint has advanced. The same ID with different content returns `REQUEST_CONFLICT`. An old run returns `STALE_RUN`, an old checkpoint returns `STALE_CHECKPOINT`, and a busy task returns `TASK_BUSY`. Query separately to distinguish request acceptance from actual stopping.

`pause` is cooperative: dispatched extraction/model calls may finish, but subsequent batches stop. `interrupt` persists cancellation intent before canceling execution. It does not guarantee cancellation of remote model calls or underlying synchronous threads. Unknown calls from immediate interruption are retained.

`retry_failed` may omit `units` or send `[]` to retry all eligible units. It may also select units, for example `[{"stage":"vision_parse","index":1}]`. Indexes are zero-based; stage is `vision_parse`, `vision_describe`, or `document_parse`. Each unit allows at most two additional retry rounds, with the remainder in `retriesRemaining`. Successful units are reused. Follow `allowedActions` for exhausted retries, input limits, preparation failures, repeated truncation, and other non-retryable errors. Ordinary resume does not retry already completed PARTIAL units.

## Human review

The default is `failurePolicy="return_partial"`. With `"review"`, stage failures or source-quality issues trigger an `interrupt`. Source issues include `SOURCE_TEXT_NOT_FOUND`, `AMBIGUOUS_OVERLAP`, and `OVERLAP_CONFLICT`.

Review payloads contain `kind=review`, `stage`, `failures`, `qualityIssues`, and `canAccept`. Retryable failures allow `retry_failed`; usable results are required for `accept_partial`. Source-quality-only review permits acceptance without automatically rerunning successful units.

`MISSING_FIELDS`, general `NEEDS_REVIEW`, and missing source answers mark drafts but do not independently pause tasks. Acceptance preserves missing fields and quality flags; it does not mark the content as verified. The service has no result-editing API. The desktop can preview and accept partial results, then edit imported questions locally.

## Recovery and retention

After an unexpected restart, the independent service resumes unfinished runs with the original run ID, deadline, and remaining budget. Paused, explicitly interrupted, and awaiting-review tasks remain waiting. Explicit resume can create a new run deadline but does not reset the task budget. Desktop mode keeps unfinished tasks interrupted after restart and calls the model again only after an explicit Resume action.

Control receipts and queue entries are persisted in one transaction. Execution uses checkpoints to determine whether a control has already been applied. External model calls and the database cannot provide cross-system exactly-once behavior: a response not yet persisted may be requested again. Unknown usage and consumed budget remain recorded.

Tasks expire 180 days after creation, returning `TASK_EXPIRED`. Changes to code, locked dependencies, Python patch version, model, or storage semantics return `EXECUTION_VERSION_MISMATCH`; use the original version or create a new task. Upgrades do not migrate old Agent Server checkpoints.

To explicitly parse the same source with the current model, send `POST /api/document-tasks/{threadId}/reparse` with `{"requestId":"a-new-UUID"}`. This verifies the retained source checksum and expiry, reuses the existing task-creation path, and returns the standard 202 receipt. The new task links to the original through `parentThreadId`; the original result and usage remain unchanged. Replays use the same request ID. This is a new paid parsing operation, not a resume. Desktop Office tasks reuse their uploaded PDF/TXT/CSV artifacts, so retry/reparse does not require LibreOffice or the original Office file. Their local operation receipts retain the original filename/hash, conversion mode, engine version and artifact hash.

The desktop bootstrap accepts empty strings for all three `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL` fields to start a read-only service. Authentication, storage validation, and retention checks remain required. List, detail, review, and verified artifact reads remain available for importing completed results without a model or Keychain read. Uploads and new parsing/grading/control work return `MODEL_NOT_CONFIGURED`; pause and interrupt are still available. Partial-result acceptance executes graph finalization and retains the model configuration and execution-signature requirement. A later explicit model action can restart the service with complete model settings; startup never automatically resumes desktop runs.

## Format boundaries

All formats use `LLM_MODEL`. TXT/CSV send text; PDF/images send images directly for extraction. Each page includes adjacent-page context and emits only questions starting on that page. Content outside the window remains incomplete and is not invented.

See [operations](operations.md) for deployment, exclusive locking, recovery acceptance, and cleanup.

## Task list

`GET /api/document-tasks?limit=20&offset=0` uses the same Bearer authentication. It returns `items` containing threadId, fileName, createdAt, expiresAt, state, status, checkpointId, questionCount, and reviewCount, plus `hasMore`. Limit is 1–100. Results sort by creation time and task ID descending. Summaries read saved checkpoints without loading all call logs; expired tasks appear as EXPIRED. Use the single-task endpoint for full state. The optional `state_filter` is one of `active`, `paused`, `completed`, `cancelled`, `failed`, `review`, `interrupted`, or `expired`. Filtering precedes pagination across the full history; `active` includes PENDING, RUNNING and PAUSING. `completed` means parsing completed, regardless of whether the desktop has imported the result into a bank.

Optional `sha256` filters by the source document's 64-character lowercase hexadecimal digest, with the same pagination. This supports duplicate-source reminders without parsing the document or making a model call.

## Read-only review preview

`GET /api/document-tasks/{threadId}/preview` uses the same authentication and expiry checks. It returns threadId, checkpointId, state, phase, units, failures, quality, and questionSources. An example unit:

```json
{
  "stage": "document_parse",
  "index": 0,
  "questions": [],
  "groups": [],
  "visualElements": [],
  "sourceRef": null
}
```

Stage review returns saved successful units and their source references; result review returns merged output plus source-only units with empty questions/groups and retained source references. Match `questionSources.stage` and `unitIndex` to these units to locate original text or page images. Failures identify failed scopes; quality and questionSources describe review issues and provenance. This endpoint does not merge, crop, call models, accept results, or write question banks. Read source content through the validated artifact API. Acceptance must carry the preview's checkpointId; an old preview cannot accept a newer result.

## Recovery errors and desktop receipts

Records with unsupported source formats or graph identifiers return HTTP 409 / `TASK_FORMAT_UNSUPPORTED` for detail, preview, control and reparse requests. Lists filter these records before pagination. Startup recovery, scheduling, queue admission and metrics exclude them; their saved records and checkpoints remain unchanged. Supported tasks in the same service database continue to work.

Startup first checks the final checkpoint's run ownership and result validity. Completed runs have their terminal state repaired; review interruptions remain waiting without executing nodes. Other unfinished desktop tasks wait for explicit resume. Execution-signature validation remains in place; checkpoints are not migrated across incompatible versions.

Model 401/403 responses are saved as `AI_PROVIDER_AUTH_ERROR` without automatic retry. After correcting credentials, explicitly use retry_failed to start another failed-unit round. Successful units, historical usage, and remaining budget are preserved. Permanent provider errors remain non-retryable, and ordinary resume cannot replay a cached error.

Before creation/control POST requests, the desktop saves requestId and the original payload in `ai/requests/`. Connection loss, invalid receipts, and uncertain server errors leave the operation pending confirmation. Definitive 4xx responses, except 408, terminate it. Explicit replay uses the same ID and content; corrected input creates a new operation with a new ID. Rust retains code, message, httpStatus, and requestId. HTTP requests and image downloads do not hold the service-process lock.

Desktop batches use prepare_batch, run_batch, batches, and cancel_batch commands. Pass run_batch titles only on initial confirmation; pass null when continuing. `ai/import-batches/` manifests store tasks, result digests, checkpoints, titles, and item states. In database schema 11, `ai_imports` stores a unique `(thread_id,digest)` receipt in the same transaction as the bank import. Resume reconciles against database receipts. Manifests and pending requests are excluded from study-data backups; committed receipts are included with the database. Restoration accepts only backup container format 4 and database schema 11. Older versions are rejected without automatic migration. See [version boundaries](../../docs/question-model.md#versions-and-directories).

## Office input boundary

`sourceType` accepts only `text`, `csv`, `pdf`, and `image`. Word/Excel uploads and new `docx_parser` tasks return 422. Direct access to unsupported tasks returns 409 / `TASK_FORMAT_UNSUPPORTED`; convert the source to PDF/TXT/CSV and create a new task. Historical records and existing banks are not deleted. Importing saved results still requires the current question contract; offline file import uses a [bank ZIP](../../docs/question-bank-package.md).

The desktop [LibreOffice adapter](desktop-office.md) converts native-picked snapshots before invoking these unchanged upload/task APIs. Text-mode Excel stages all nonempty sheet task requests durably before the first task POST. A failed POST leaves accepted receipts and remaining pending requests available through existing recovery controls; replay keeps each request ID. Office discovery/export itself starts no HTTP service and reads no model configuration.
