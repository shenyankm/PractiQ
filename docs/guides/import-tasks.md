# Document import tasks

The App import workspace outlines three steps: select and import, check results, then import the result directly into the local bank. Task status filtering has a visible label. An empty filtered list offers **查看全部任务**, which resets the filter and pagination using read-only requests. An empty unfiltered list offers **选择第一份文档**, which focuses the file picker; selection remains passive until **开始导入**.

The App’s **Document import** area provides source selection, task history,
progress and saved-result review. Configure providers in global Settings, then
choose documents with the native file picker. File paths stay outside the
renderer; embedded Node workers own parsing. No account is required. **Import
bank** reads the saved result and verified resources directly into SQLite,
without a ZIP or file-save dialog.

## Start and review

Open **Document import** after saving model and Tencent credentials under
**Settings → AI model and recognition**. Choose up to ten supported files and
explicitly start import. File selection makes no upload or model request. The
embedded runtime validates source bytes and stores the original SHA-256;
Tencent asynchronous recognition remains part of the same task.

**自动去重** is off by default. When enabled before **开始导入**, it merges only questions or complete composite-question trees with identical business payloads and source evidence, retaining source associations and warnings. Missing or conflicting evidence is kept for review. When disabled, possible duplicate candidates appear in result warnings and all copies remain. The choice is fixed for each submitted file and retained by explicit retries and parse again; start a new import to change it. Selecting the checkbox makes no request.

**自动去重**和**AI 生成答案与解析**位于设置页，以开关形式自动保存，默认关闭。开启 AI 生成并保存成功后，再点击**开始导入**，服务会在提取完成后补充缺失答案或解析，保留原文已有或部分提供的答案；资料不足仍留空。生成内容会标记为待核对，并共享任务调用预算。重试保留原选项，查看和导出不会触发生成。

Inspect saved questions, supplied answers, images, source associations, quality warnings, errors and usage. `COMPLETED` can contain `PARTIAL`; a completed task is not a claim that extraction is accurate. Missing answers remain null and require review. Parsing does not solve unanswered questions.

Model calls use your configured provider directly, with recorded usage and a
per-task call budget. Unknown results remain available for inspection and
explicit recovery. **导入题库** imports completed questions from paused tasks when
available, retaining missing-field and review warnings; import never resumes
parsing. Current credentials are encrypted locally and excluded from learning
backups, together with AI task state.

Choose **Import bank** for the current saved result, or select questions and choose **Import selected questions**. Required material and shared-option groups travel together. The native importer verifies the shared JSON contract, resource checksums, media types and limits before atomically creating a local bank. Review flags do not block import or offline practice. Personal answers and historical score snapshots stay local.

## State and actions

The embedded runtime owns parsing state and `allowedActions`. Read the latest
detail before choosing a control; send its unchanged run or checkpoint identifier.

| State | Meaning and next action |
| --- | --- |
| PENDING / RUNNING | Wait, pause or interrupt when allowed. |
| PAUSING | Wait for the worker to acknowledge the pause. |
| PAUSED / INTERRUPTED / CANCELLED | Explicitly resume when allowed and compatible. |
| FAILED | Inspect the failure; explicitly resume or retry eligible failed units. |
| WAITING_REVIEW | Review retained content before accepting a partial result or retrying eligible units. |
| COMPLETED | Review and download; retry eligible failed units only through an explicit action. |
| EXPIRED | Results cannot be resumed or downloaded; existing desktop banks remain available. |

Reading lists, details, preview artifacts and importing saved results do not call a model. Resume, failed-unit retry and parse again can call the configured provider and incur charges. Accepting partial content preserves missing fields and warnings; it does not verify their correctness. Successful checkpointed units are reused.

An uncertain mutation is not a successful transition. Persistent SQLite receipts
bind request IDs to their original payloads; explicit replay must reuse both.
Do not create an automatic new request after a worker/connection failure. Query
saved state first. App reopening performs reads, never a control or new parsing
action. LangGraph.js checkpoints and Store reuse validated successful units.

## Office and retention

Office originals use Tencent asynchronous parsing directly within the active
transport/type limit. Export oversized Office documents as PDF before import;
the App does not discover or run LibreOffice. Bounded PDF/image/text preparation
retains source hashes, ordered split receipts, original-page/pixel ranges and
engine identity. Resume verifies the saved artifacts and execution fingerprint;
an incompatible build cannot resume paid work silently. Optional private COS
input staging is configured under advanced AI settings. It is temporary, never
the authoritative store, and does not fall back automatically to Base64.

Task results expire after 180 days. Import needed banks before then. Safe task
deletion requires stopping active work and does not delete already imported
banks or practice history. Historical Python task files/checkpoints and old
service volumes remain untouched; their serialization is not loaded as
LangGraph.js checkpoints. Previously exported compatible results remain importable.

The empty **My banks** page still offers **Add example bank**. It imports the bundled all-types ZIP locally without model configuration or calls.

See the [data contract](../reference/question-model.md) and
[migration acceptance ledger](../maintainers/electron-migration.md).

## Workspace controls

The picker lists supported extensions; native/runtime validation remains
authoritative. **移除文件** removes a selected file before submission without an
upload or model call. Files with created or failed requests retain their existing
receipt/retry behavior.

Task controls and direct bank import stay in the main action group. **其他任务操作** contains reparse and deletion; expanding it makes no request. Parsed results can be searched by stem, supplied/shared option text or source text and filtered by explicit review flags. Filtering is local to the result view, resets pagination, retains shared-material context and changes neither the export nor the stored review flags. Unchanged Markdown and formulas are reused across parent updates. A question's full structured record is generated only when its own detail is first opened, retained while that question card remains mounted, and refreshed if the question changes. See [Workspace UX decisions](../product/ux-workspace.md).
