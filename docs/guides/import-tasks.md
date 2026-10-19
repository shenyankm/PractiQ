# Document import tasks

The Web workspace outlines three steps: select and import, check results, then export a question-bank ZIP for offline practice. Task status filtering has a visible label. An empty filtered list offers **查看全部任务**, which resets the filter and pagination using read-only requests. An empty unfiltered list offers **选择第一份文档**, which focuses the file picker; selection remains passive until **开始导入**.

The independent AI service's Web frontend handles source selection, upload, task history, progress and saved-result review. The desktop app imports downloaded question-bank ZIP files under **Settings → Import and restore**. It contains no AI document-task interface.

## Start and review

Enter your self-hosted service access token (`AI_SERVICE_TOKEN`). It remains in page memory and clears on reload. Choose up to ten supported files and explicitly start import. File selection makes no upload or model request. The server validates source bytes and stores the original SHA-256; Tencent asynchronous recognition remains part of the same task.

**自动去重** is off by default. When enabled before **开始导入**, it merges only questions or complete composite-question trees with identical business payloads and source evidence, retaining source associations and warnings. Missing or conflicting evidence is kept for review. When disabled, possible duplicate candidates appear in result warnings and all copies remain. The choice is fixed for each submitted file and retained by explicit retries and parse again; start a new import to change it. Selecting the checkbox makes no request.

Inspect saved questions, supplied answers, images, source associations, quality warnings, errors and usage. `COMPLETED` can contain `PARTIAL`; a completed task is not a claim that extraction is accurate. Missing answers remain null and require review. Parsing does not solve unanswered questions.

Deployments can opt in to [independent AI source review](../../server/docs/import-agent-review.md) with `AI_IMPORT_REVIEW=true`. Start import then includes review and, for source-evidenced discrepancies, at most one repair and recheck; these consume the existing model budget and can increase cost. Result warnings distinguish no discrepancy, repaired, rejected, unresolved and unreviewed outcomes. Missing source answers are never solved, and AI review does not clear existing human-review flags or establish accuracy. Reviewing saved results remains read-only.

Model calls use your configured provider directly, with recorded usage and a per-task call budget. Unknown results remain available for inspection and explicit recovery. **下载题库 ZIP** exports completed questions from paused tasks when available, retaining missing-field and review warnings; export never resumes parsing. See [personal use](../../server/docs/personal-use.md).

Download a completed result as a bank ZIP, then open it with the desktop importer. Review flags do not block ZIP import or offline practice. Native import lets you create a bank or append to an existing one. Personal answers and historical score snapshots stay local.

## State and actions

The server owns parsing state and `allowedActions`. Read the latest detail before choosing a control; send its unchanged run or checkpoint identifier.

| State | Meaning and next action |
| --- | --- |
| PENDING / RUNNING | Wait, pause or interrupt when allowed. |
| PAUSING | Wait for the server to acknowledge the pause. |
| PAUSED / INTERRUPTED / CANCELLED | Explicitly resume when allowed and compatible. |
| FAILED | Inspect the failure; explicitly resume or retry eligible failed units. |
| WAITING_REVIEW | Review retained content before accepting a partial result or retrying eligible units. |
| COMPLETED | Review and download; retry eligible failed units only through an explicit action. |
| EXPIRED | Results cannot be resumed or downloaded; existing desktop banks remain available. |

Reading lists, details, preview artifacts and downloading ZIP files do not call a model. Resume, failed-unit retry and parse again can call the configured provider and incur charges. Accepting partial content preserves missing fields and warnings; it does not verify their correctness. Successful checkpointed units are reused.

An uncertain mutation is not a successful transition. Persistent server receipts bind request IDs to their original payloads; explicit replay must reuse both. Do not create an automatic new request after a connection failure. Query saved state first. Web refresh/reopening performs reads, never a control or new parsing action.

## Office and retention

Office originals use Tencent asynchronous parsing directly within the active per-job limit. Oversized Office sources use the isolated service converter for PDF pagination; users do not select a conversion mode. Source hashes, split-part associations and any conversion manifests are retained. Converted artifacts and the engine identity are verified on resume; an incompatible deployment requires the original version or a new task. See [Tencent parser setup](../../server/docs/tencent-document-parser.md) for local mode and optional private COS staging.

Task results expire after 180 days. Download needed banks before then. Safe task deletion requires stopping active work and does not delete already imported banks or practice history. Existing desktop AI files and import receipts from older builds remain untouched; they are not migrated into the independent service.

The empty **My banks** page still offers **Add example bank**. It imports the bundled all-types ZIP locally without model configuration or calls.

See the [API contract](../../server/docs/document-tasks.md) and [Office guide](../../server/docs/desktop-office.md).

## Workspace controls

The picker lists only service-supported extensions; server/client validation remains authoritative. **移除文件** removes a selected file before submission without an upload or model call. Files with created or failed requests retain their existing receipt/retry behavior.

Task controls and ZIP export stay in the main action group. **其他任务操作** contains reparse and deletion; expanding it makes no request. Parsed results can be searched by stem, supplied/shared option text or source text and filtered by explicit review flags. Filtering is local to the result view, resets pagination, retains shared-material context and changes neither the export nor the stored review flags. Unchanged Markdown and formulas are reused across parent updates. A question's full structured record is generated only when its own detail is first opened, retained while that question card remains mounted, and refreshed if the question changes. See [Workspace UX decisions](../product/ux-workspace.md).
