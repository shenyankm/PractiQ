# Source comparison and human corrections

Open a task under **导入记录**, expand a question, and choose **对照原文与校对**.

- Filter missing answers, missing type metadata, or material associations needing inspection. Filters affect display only.
- Compare the associated saved page/text fragment. Exact text matches are highlighted. Split images prefer the retained complete page; multiple sources can be selected.
- When a complete page image is unavailable, the view labels saved OCR evidence and offers the original file download. It does not infer a missing page number or present OCR output as the original file.
- Completed results support stems, existing text/Markdown/LaTeX content blocks, type labels, ordinary answer modes, options, reference answers, explanations and rubrics. Material parents keep answers on their children; this editor does not rebuild material relationships.
- Saves append revisions in PostgreSQL Store without changing model results, checkpoints, source evidence, resources or practice snapshots. Human corrections retain review flags and do not start models.
- **原始解析与修改历史** shows originals and saved changes. Reopening a task reads persisted corrections.
- **下载修订版 ZIP** exports saved changes through the selected revision. The task's **下载题库 ZIP** exports the original. Both retain source associations, resources and diagnostics.

## State and recovery

| State or action | Behavior |
| --- | --- |
| Incomplete task or unavailable checkpoint | Inspect sources; correction saves are unavailable. |
| Editing | Task replacement or detail refresh requires explicit draft-discard confirmation. Other workspace pages hide the editor without unmounting it. |
| Saving or reading receipts | Inputs, selectors, option controls, save and cancel are locked for the request; task replacement is blocked. |
| Save succeeded | Close the editor, show the saved result and enable revised export. |
| Definitively rejected first save | Retain and unlock the draft for correction. |
| Network failure or uncertain receipt | Retain the submitted draft and original request ID. Inputs and discard remain locked; explicitly read saved revisions or retry the original request. Block task replacement and operations resetting the result view. |
| Original request ID found | Confirm the previous save without another write and release the task guard. |
| Another window saved first | Reject overwriting its version. Reload revisions and inspect history before deciding whether to save the draft. |
| Source verification failure | Display an error and explicit retry; never substitute another source. |
| Task expiry/deletion | Revisions share the existing task lifetime; downloaded banks are unaffected. |
| Read-only service | Reads/exports remain available; saves are rejected. |

Record selection, recovery links, detail refresh and parent mutations that may replace/reset the task use the same guard. Passive original downloads retain drafts. A parent operation already in progress prevents opening a new editor until it finishes.

Drafts and unconfirmed request IDs remain in the current editor, including while another workspace page is visible. Browser reload/closing prompts before leaving; recovery after a confirmed full reload is not provided. Changed checkpoints reject old saves. Download a ZIP before task expiry for long-term retention.

## Contract and persistence

`DocumentCorrectionSave`, `DocumentCorrections` and `DocumentQuestionCorrection` in `contracts.py` are authoritative; the existing exporter derives Web/App types.

- `GET /api/document-tasks/{threadId}/corrections` reads current-checkpoint history.
- `PUT` takes `requestId`, `checkpointId`, `expectedRevision`, `questionIndex` and complete `question`. Initially `expectedRevision=null`; later it is the last entry's `requestId`.
- Explicit accepted-request replay is idempotent. Reusing its ID with different content returns `REQUEST_CONFLICT`; concurrent saves return `CORRECTION_CONFLICT`; changed checkpoints return `STALE_CHECKPOINT`.
- IDs, source evidence, resources, confidence and relationships are protected. Existing content blocks allow text/formula changes but retain type, role, structure and JSON resources. Validate the complete question tree before saving.
- History is checkpoint-scoped in PostgreSQL Store, serialized by the task control lock and one atomic write. Limits: 500 changes and 8 MiB; excess returns `CORRECTION_HISTORY_LIMIT` while preserving prior entries.
- Preview adds nullable corrections. Review units optionally expose retained complete pages and page indices from existing input manifests.
- Export optionally takes `revision_id`; omitting it preserves original export behavior. Checkpoint/task-state checks still apply during export.

No new parser, provider work, service/practice schema migration, dependency or ZIP format is introduced. See the [acceptance record](../../docs/history/import/workbench-20261106.md).
