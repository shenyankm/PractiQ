# PNG type-label correction — November 6, 2026

Baseline: `47e2d8c93c8af4930a966c68d99abd649c54eeb1`. The original
[November 5 failure](../performance/ocr-review-20261105.md) contained three correct
true/false questions with `questionTypeId=null`. Its source and failed evidence
remain unchanged. [New evidence](../../evidence/2026-11-06-type-labels/) separates
each run and its source identity.

## Cause and change

The shared extraction prompt allowed a recognized mode as a type label, but its
reading/word-bank JSON examples omitted the field. Missing labels were derived
as review flags and never entered correction. The Chinese choice example also
used a canonical alias despite a literal source label being available.

Examples now include labels and consistently copy supplied labels. Fresh model
responses use the existing Pydantic validation context to require a nonempty
`questionTypeId` when `answerMode` is known. Missing/blank labels enter the existing
bounded correction loop. The model must copy an explicit source label, or use
the recognized mode when no label is supplied. The service does not silently
assign a default, replace a supplied custom label or solve missing answers.

This check applies only to newly received model responses, including responses
already parsed by the SDK. Public contracts remain nullable. Unknown modes,
saved results, bank ZIPs and passive reads retain their previous review behavior.
No schema, generated contract, migration, dependency or desktop code changes.

## Deterministic regression

The new tests force the original missing-label response followed by a corrected
response. Both calls retain known token usage. Real graph/Store substitutes
verify failed/passed receipts and two spent budget slots. A one-call task budget
prevents a second provider call; identical repeated omissions stop with
`OUTPUT_STALLED`. Unknown modes and historical missing labels remain accepted
for review. Present labels are preserved.

Existing model fixtures now include this metadata so their unrelated tree,
answer-provenance, Office, context and duplicate tests still isolate their
intended behavior. The public nullable fields were not tightened to make these
tests pass. Focused suites passed **279** and **521** tests before the final
Office fixture completion; the final Office, label and workflow group passed
**71** tests. Ruff, Pyright and generated-contract parity passed.
Full current-head service CI exercises `make verify`
on Python 3.14 and 3.15; use the PR checks for its final results.

## Live outcomes and final PNG acceptance

The same PNG SHA-256 was used throughout:
`741967673509a2bc53c54147b162b6e98f423ae0c673790adcd25adafa4a80cb`.

| Run | Result | Boundary |
| --- | --- | --- |
| Initial fixed prompt | 3/3 TXT/Markdown/PNG content and browser/native chains passed; 24 repeated native cases passed | Before the final Chinese example wording correction; retain its separate code hash |
| Final full run | Failed | TXT stopped with `MODEL_RESULT_UNKNOWN`; Markdown passed; PNG returned an empty question array. Missing exports caused downstream native checks to fail. No unknown TXT call was replayed |
| Final PNG-only run | Passed | Final service code hash matches the candidate; three supplied stems, modes and answers preserved; all three labels present; exact HTTP/ZIP equality and native practice/reopen/backup/restore passed |

`png-comparison.json` records the original null labels beside the final labels.
The final PNG run made one known model call and no unknown calls. Missing supplied
analysis still remains null and reviewable; review flags were not globally cleared.

The workflow harness supports `--case png` to explicitly select one source and
one native repetition. Default coverage remains all three sources with eight
native repetitions each. Selection is checked against actual browser samples;
native ZIP hashes and result coverage remain mandatory. This allowed PNG-only
acceptance without repeating the uncertain TXT request.

The full-run empty output and provider uncertainty are retained as separate
live-quality/reliability limits. This fix prevents accepting a known-mode
question with a missing label; it does not establish general model accuracy,
question completeness or installed-package acceptance. Native checks use the
existing release Rust/SQLite executable, excluding Tauri IPC/WebView. Provider
configuration is omitted and terminal output has trailing whitespace removed.

## Existing imports and deployment

Historical results and practice snapshots are not rewritten. An existing import
needs an explicit parse-again/new-import action on the updated service; normal
provider charges and budgets apply. Unknown-result recovery remains explicit.
The existing source/configuration signature still rejects resume across code
versions; finish old work with its original deployment or create a new task.
