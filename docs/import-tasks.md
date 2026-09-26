# Document import tasks

The Import page keeps document selection above a paginated task list, newest first. The task heading and table are hidden when there are no tasks; loading, errors, pending operations and pagination remain visible when needed. Each source document is one task. The detail drawer shows saved progress, review content, errors and model usage. ZIP import remains under Settings > Restore backup.

## State and actions

The server owns parsing state and `allowedActions`. The desktop combines that state with the current checkpoint's local import receipt; it does not persist a second parsing state machine.

| State | Meaning and next action |
| --- | --- |
| Queued / Parsing | Wait, pause or interrupt when allowed by the server. |
| Pausing | Wait for the server to acknowledge the pause. |
| Paused / Interrupted | Resume or retry failed units when allowed. |
| Parsing failed | Inspect the error, resume/retry when allowed, otherwise select the document again. |
| Awaiting review | Inspect saved content before explicitly accepting partial results or retrying failed units. |
| Ready to import | Preview and confirm a new bank or append to an existing bank. |
| Importing | Local import is in progress; duplicate submission is blocked. |
| Import failed | Saved parsing results remain available; preview and confirm again to retry. |
| Imported | Open the existing bank. The current result is not offered for duplicate import. |
| Expired | Parsing results cannot be resumed or imported. An existing bank remains accessible. |

Partial results, questions needing review and previously imported versions are separate indicators. Question-level review flags do not block imports. A retry that produces another checkpoint is evaluated separately from the previously imported result; old banks remain intact.

Single-import progress and errors are transient UI state. After reopening the app, the local receipt determines whether the result is imported or ready to import. Batch progress and pending control requests retain their existing recovery records. An uncertain control response is not treated as a successful state transition; explicit replay uses the original request identifier.

## Refresh and confirmation

Active tasks on the current page refresh every two seconds even when the drawer is closed. Only the selected task loads detailed progress. Old responses are ignored after page changes, closing the drawer or unmounting. Transient reads retry at most three times; missing and expired task reads stop immediately.

Batch selection applies to the current page. Selection clears on page changes and when a task becomes ineligible for import.

Local batch history has its own 20-batch pages; active batches remain visible on every history page. Import failures for the visible tasks and the selected task are resolved independently of the history page. An active pending import takes precedence over historical failures for the same task and checkpoint. Receipt reconciliation reuses one SQLite connection per page. Manifest discovery still scans the local batch directory; it does not load every historical item into the UI.

Selecting a file still requires explicit confirmation before parsing. Reviewing saved results and importing do not call a model. Resume/retry calls require explicit user action. Confirmed imports stay on the task list; opening a bank is a separate action. Local batch recovery controls remain visible without model configuration.

An empty My Banks page offers **Add example bank**. It imports the bundled all-types ZIP locally without model configuration or calls, covering every answer mode and English question kind, including chime audio for listening and an image example.
