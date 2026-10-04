# Document import tasks

The independent AI service's Web frontend handles source selection, upload, task history, progress and saved-result review. The desktop app imports downloaded question-bank ZIP files under **Settings → Restore backup**. It contains no AI document-task interface.

## Start and review

Enter the service access token in the Web frontend; it remains in browser memory. Choose up to ten supported files, select the Office mode when available and explicitly start import. File selection makes no upload or model request. The server validates the source bytes and stores the original SHA-256; Office normalization remains part of that same source task.

Inspect saved questions, supplied answers, images, source associations, quality warnings, errors and usage. `COMPLETED` can contain `PARTIAL`; a completed task is not a claim that extraction is accurate. Missing answers remain null and require review. Parsing does not solve unanswered questions.

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

Office tasks retain the original document identity and mode. PDF is the default; text mode includes ordered Excel sheets, including hidden sheets. Duplicate checks use the raw source hash and mode. A mode change is new parsing work. Converted artifacts and the engine identity are verified on resume; an incompatible deployment requires the original version or a new task.

Task results expire after 180 days. Download needed banks before then. Safe task deletion requires stopping active work and does not delete already imported banks or practice history. Existing desktop AI files and import receipts from older builds remain untouched; they are not migrated into the independent service.

The empty **My banks** page still offers **Add example bank**. It imports the bundled all-types ZIP locally without model configuration or calls.

See the [API contract](../server/docs/document-tasks.md) and [Office guide](../server/docs/desktop-office.md).
