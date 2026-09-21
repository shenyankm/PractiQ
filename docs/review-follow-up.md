# Closed PR review follow-up

This change addresses the 44 applicable suggestions from the 2026-09-21 audit of closed PRs against `8116674`. The 26 suggestions about retired architecture and two already-fixed items need no implementation. GitHub discussion resolution is separate from this code change.

## Product behavior and boundaries

- Imported reference answers determine missing fill-blank counts; explicit mismatches are rejected. Changing the count in the editor clears the old reference answer so it must be entered for the new shape.
- Composite search includes structured content; parent stars reflect descendant favorites, and toggling a parent applies to its subtree. Child toggles still affect the child. Structured inherited passages survive practice snapshots and grading.
- Ordinary practice hides full source pages until submission. Exams remove explicitly answer-labeled section content. Legacy free-text label detection is conservative and cannot infer unlabeled answers hidden in prose; typed content roles remain the preferred representation.
- PDF pages whose rendered PNG exceeds 25 MiB are rejected during preparation, even if the input PDF is smaller; reduce source resolution to retry. No lossy re-encoding is introduced.
- Grading requests exceeding field, image or aggregate limits fail locally before a receipt is written. Malformed image bytes yield a validation response. No automatic model retry was added.
- Restored databases determine batch import completion; transient read failures resume polling.

## Traceability

| Original review | Change |
|---|---|
| [#35: Validate the fill-blank count against its answer payload](https://github.com/shenyankm/PractiQ/pull/35#discussion_r4060529264) | Infer missing blank counts and reject mismatches in Python/Rust; editing a count clears the old reference answer. |
| [#35: Preserve searches across structured question content](https://github.com/shenyankm/PractiQ/pull/35#discussion_r4060529275) | Search structured question, section and visual values. |
| [#35: Reflect descendant favorites on promoted composite roots](https://github.com/shenyankm/PractiQ/pull/35#discussion_r4060529289) | Aggregate descendant favorites on roots and clear/set a selected subtree together. |
| [#35: Preserve structured passage blocks when hydrating children](https://github.com/shenyankm/PractiQ/pull/35#discussion_r4060529297) | Keep inherited passage blocks structured through snapshots, rendering and grading. |
| [#31: Localize known native diagnostic messages](https://github.com/shenyankm/PractiQ/pull/31#discussion_r4059950344) | Translate known native diagnostics instead of appending Chinese application text. |
| [#27: Cap rendered source pages at the desktop asset limit](https://github.com/shenyankm/PractiQ/pull/27#discussion_r4057090472) | Reject PDF renderings above the 25 MiB per-page asset ceiling before publishing references. |
| [#27: Restrict answer detection to actual answer labels](https://github.com/shenyankm/PractiQ/pull/27#discussion_r4057090477) | Detect answer labels, not ordinary solution/analysis words. |
| [#27: Hide original pages until practice answers are submitted](https://github.com/shenyankm/PractiQ/pull/27#discussion_r4057090478) | Expose original pages only after a practice attempt is submitted. |
| [#27: Escape Markdown syntax in raw table cells](https://github.com/shenyankm/PractiQ/pull/27#discussion_r4057090479) | Escape literal cell syntax while preserving inline math and equivalent-table role propagation. |
| [#23: Add desktop choices before mandating issue forms](https://github.com/shenyankm/PractiQ/pull/23#discussion_r4056694344) | Add desktop issue areas and remove obsolete setup references. |
| [#22: Remove the unsupported skill frontmatter key](https://github.com/shenyankm/PractiQ/pull/22#discussion_r4056688230) | Corrected or removed the unsafe/inapplicable skill example; repository commands and boundaries take precedence. |
| [#22: Point project discovery at the desktop app](https://github.com/shenyankm/PractiQ/pull/22#discussion_r4056688232) | Corrected or removed the unsafe/inapplicable skill example; repository commands and boundaries take precedence. |
| [#22: Invoke the locked shadcn CLI](https://github.com/shenyankm/PractiQ/pull/22#discussion_r4056688234) | Corrected or removed the unsafe/inapplicable skill example; repository commands and boundaries take precedence. |
| [#22: Avoid wrapping complete OKLCH values in Tailwind v3](https://github.com/shenyankm/PractiQ/pull/22#discussion_r4056688236) | Corrected or removed the unsafe/inapplicable skill example; repository commands and boundaries take precedence. |
| [#22: Make the first eval expect Switch controls](https://github.com/shenyankm/PractiQ/pull/22#discussion_r4056688238) | Corrected or removed the unsafe/inapplicable skill example; repository commands and boundaries take precedence. |
| [#22: Do not require the unavailable SelectGroup export](https://github.com/shenyankm/PractiQ/pull/22#discussion_r4056688240) | Corrected or removed the unsafe/inapplicable skill example; repository commands and boundaries take precedence. |
| [#22: Label the icon-only search button](https://github.com/shenyankm/PractiQ/pull/22#discussion_r4056688241) | Corrected or removed the unsafe/inapplicable skill example; repository commands and boundaries take precedence. |
| [#19: Clear the merge draft when cancelling](https://github.com/shenyankm/PractiQ/pull/19#discussion_r4056531238) | Clear cancelled merge drafts. |
| [#19: Restore focus to the merge trigger after closing](https://github.com/shenyankm/PractiQ/pull/19#discussion_r4056531243) | Restore focus to the merge trigger. |
| [#16: Preserve usage when parsing the model response fails](https://github.com/shenyankm/PractiQ/pull/16#discussion_r4056382230) | Corrected or removed the unsafe/inapplicable skill example; repository commands and boundaries take precedence. |
| [#16: Reserve projected cost before issuing the model request](https://github.com/shenyankm/PractiQ/pull/16#discussion_r4056382231) | Corrected or removed the unsafe/inapplicable skill example; repository commands and boundaries take precedence. |
| [#16: Run the repository's actual desktop verification target](https://github.com/shenyankm/PractiQ/pull/16#discussion_r4056382233) | Corrected or removed the unsafe/inapplicable skill example; repository commands and boundaries take precedence. |
| [#16: Include the eval harness before documenting its command](https://github.com/shenyankm/PractiQ/pull/16#discussion_r4056382235) | Corrected or removed the unsafe/inapplicable skill example; repository commands and boundaries take precedence. |
| [#16: Provide the linked React hooks ruleset](https://github.com/shenyankm/PractiQ/pull/16#discussion_r4056382237) | Corrected or removed the unsafe/inapplicable skill example; repository commands and boundaries take precedence. |
| [#16: Use the allowed-tools frontmatter key](https://github.com/shenyankm/PractiQ/pull/16#discussion_r4056382240) | Corrected or removed the unsafe/inapplicable skill example; repository commands and boundaries take precedence. |
| [#16: Remove product login guidance from the server skill](https://github.com/shenyankm/PractiQ/pull/16#discussion_r4056382242) | Corrected or removed the unsafe/inapplicable skill example; repository commands and boundaries take precedence. |
| [#16: Keep imported content out of dangerouslySetInnerHTML](https://github.com/shenyankm/PractiQ/pull/16#discussion_r4056382244) | Corrected or removed the unsafe/inapplicable skill example; repository commands and boundaries take precedence. |
| [#16: Keep the Vite development server on loopback](https://github.com/shenyankm/PractiQ/pull/16#discussion_r4056382246) | Corrected or removed the unsafe/inapplicable skill example; repository commands and boundaries take precedence. |
| [#16: Diff current changes against HEAD](https://github.com/shenyankm/PractiQ/pull/16#discussion_r4056382248) | Corrected or removed the unsafe/inapplicable skill example; repository commands and boundaries take precedence. |
| [#16: Expose the cloud security guide through skill discovery](https://github.com/shenyankm/PractiQ/pull/16#discussion_r4056382253) | Corrected or removed the unsafe/inapplicable skill example; repository commands and boundaries take precedence. |
| [#16: Apply the timeout to response-body reads](https://github.com/shenyankm/PractiQ/pull/16#discussion_r4056382258) | Corrected or removed the unsafe/inapplicable skill example; repository commands and boundaries take precedence. |
| [#16: Revalidate content before storing the cached extraction](https://github.com/shenyankm/PractiQ/pull/16#discussion_r4056382261) | Corrected or removed the unsafe/inapplicable skill example; repository commands and boundaries take precedence. |
| [#16: Validate uploaded bytes at the trusted boundary](https://github.com/shenyankm/PractiQ/pull/16#discussion_r4056382262) | Corrected or removed the unsafe/inapplicable skill example; repository commands and boundaries take precedence. |
| [#16: Keep desktop API keys in Keychain](https://github.com/shenyankm/PractiQ/pull/16#discussion_r4056382263) | Corrected or removed the unsafe/inapplicable skill example; repository commands and boundaries take precedence. |
| [#16: Tie the returned FFI reference to an owner lifetime](https://github.com/shenyankm/PractiQ/pull/16#discussion_r4056382265) | Corrected or removed the unsafe/inapplicable skill example; repository commands and boundaries take precedence. |
| [#16: Send cached instructions through the system channel](https://github.com/shenyankm/PractiQ/pull/16#discussion_r4056382267) | Corrected or removed the unsafe/inapplicable skill example; repository commands and boundaries take precedence. |
| [#16: Run timer cleanup when the wrapped block raises](https://github.com/shenyankm/PractiQ/pull/16#discussion_r4056382268) | Corrected or removed the unsafe/inapplicable skill example; repository commands and boundaries take precedence. |
| [#15: Reconcile imported batch items after database restore](https://github.com/shenyankm/PractiQ/pull/15#discussion_r4056373634) | Reconcile inactive imported batch items against database receipts after restore. |
| [#15: Retry polling after transient task read failures](https://github.com/shenyankm/PractiQ/pull/15#discussion_r4056373637) | Retry read polling after failures without issuing model actions. |
| [#12: Hide answer-bearing group instructions during exams](https://github.com/shenyankm/PractiQ/pull/12#discussion_r4056218698) | Filter answer-labeled group titles/instructions from unsubmitted exam projections. |
| [#12: Finalize rejected call records before exposing them](https://github.com/shenyankm/PractiQ/pull/12#discussion_r4056218701) | Finalize pre-provider rejected call records. |
| [#12: Convert malformed image failures into validation errors](https://github.com/shenyankm/PractiQ/pull/12#discussion_r4056218703) | Convert Pillow image errors into validation responses. |
| [#12: Enforce grading limits before creating the request](https://github.com/shenyankm/PractiQ/pull/12#discussion_r4056218706) | Check grading field/count/image limits before persisting requests. |
| [#12: Stop the deadline clock outside active timed exams](https://github.com/shenyankm/PractiQ/pull/12#discussion_r4056218708) | Only update the deadline clock for an active timed exam. |

## Verification

Regression checks cover schema parity, literal table rendering and classification, PDF asset bounds, malformed grading images, terminal call records, composite search/favorites/material inheritance, exam redaction, grading rejection before persistence, restore reconciliation, source-page visibility, idle clock rendering, polling recovery, localization and merge-dialog reset/focus.

Use `make verify`, `make app-check` and `make app-build` with the existing Python 3.14 interpreter. Check the packaged service using `app/scripts/check-bundle.py`. These checks use synthetic providers; they do not establish real-model extraction quality or signed Windows/macOS release readiness.

## PR #36 follow-up

- [Qualified answer labels](https://github.com/shenyankm/PractiQ/pull/36#discussion_r4061003719): recognize Correct Answer, Answer key, 正确答案 and related labels in structured and text tables; ordinary material such as Solution concentration remains material.
- [Content search](https://github.com/shenyankm/PractiQ/pull/36#discussion_r4061003724): search text-bearing fields and nested JSON content rather than schema keys, enum metadata, nulls and booleans. Literal schema words inside content remain searchable.
- [Inherited block rendering](https://github.com/shenyankm/PractiQ/pull/36#discussion_r4061003729): preserve distinct Markdown, text, LaTeX and JSON fields together; identical Markdown/text renders once.
- [Task read failures](https://github.com/shenyankm/PractiQ/pull/36#discussion_r4061003734): stop immediately for missing/expired tasks and permanent HTTP failures; allow at most three retries for transport, timeout, throttling or server errors, then refresh membership once. Retries only read state and never launch model actions.

## PR #36 second review

- [Qualified exam group labels](https://github.com/shenyankm/PractiQ/pull/36#discussion_r4061199058): hide groups whose titles or instructions carry qualified answer labels before hand-in, retaining ordinary prose and restoring all original group material after submission.
- [Terminal task retention](https://github.com/shenyankm/PractiQ/pull/36#discussion_r4061199068): keep completed/reviewable task data and controls when the separate best-effort membership refresh fails; show the refresh error without retrying or discarding the successful task read.
- [Locked shadcn execution](https://github.com/shenyankm/PractiQ/pull/36#discussion_r4061199073): document a locked install followed by direct execution of the installed CLI entry point throughout the skill and its references. Missing dependencies fail locally instead of invoking a package runner.
