# Source-grounded import agent collaboration

The existing parser graphs support a bounded extraction/review workflow for each text fragment or primary page. It uses the same configured multimodal model in separate calls with independent roles, not a second document parser or a free-form agent conversation. The existing neighboring-page context and PRIMARY ownership rules remain in force. This feature implements [issue #217](https://github.com/shenyankm/PractiQ/issues/217); measured live-model quality improvement remains a separate evaluation requirement.

## Enable explicitly

Set the trusted service environment variable `AI_IMPORT_REVIEW=true` before starting the service. The default is `false` so upgrades do not silently add billable calls. The setting is not accepted from uploads, browser preferences or native application settings. Read-only deployments still start no model work.

Web's explicit **开始导入** action authorizes the configured extraction, review and bounded repair workflow. The upload instructions disclose additional calls and cost. Selection, polling, result viewing, partial acceptance and ZIP export remain passive. Existing failed-unit retry/reparse authorization and request-ID boundaries are unchanged.

Code and semantic configuration are included in the execution fingerprint. Finish existing tasks on their original deployment; changing this setting or upgrading the parser does not migrate old checkpoints or rewrite their signatures.

## Roles and limits

1. **Extraction agent**: the existing text/vision parser faithfully extracts supplied questions, options, answers, scores, rubrics and source associations. It never solves unanswered questions.
2. **Review agent**: a separate call sees the actual source fragment/page images and extracted structured result. It checks missing questions/subquestions, stem/options discrepancies, supplied-answer/analysis mismatches, associations and invented content. Findings have a bounded code, zero-based question index (null only for `missing_question`; every other code must reference an existing question), literal source evidence, repair instruction and repairability flag. Text evidence must be a literal substring of the source, and referenced indexes must exist. Image evidence remains a model observation, not independently verified pixels.
3. **One repair**: only a report whose findings are all source-evidenced and repairable permits a correction call. Existing questions must retain order, IDs, parent IDs and literal source anchors; omitted questions may be appended. Destructive identity/drop proposals are rejected. Only a `missing_question` finding permits appending questions. Existing groups and figures retain their positions and cannot be removed; a changed entry requires association findings for every original and proposed owner. Shared or unassociated entries without those findings remain unchanged. Shared-option/audio references, passage material and embedded visual/table blocks also remain unchanged without an association finding for their question. New groups/figures may reference source-evidenced appended questions. These conservative checks can reject a useful proposal; the original remains available for human review.
4. **One recheck**: a separate review of the proposed extraction must find no discrepancies before the proposal replaces the original. Unresolved findings or an incomplete recheck reject the proposal; there is no second repair or debate loop.

Source, extracted records and reviewer findings are untrusted data, never agent instructions. Agents have no additional filesystem, SQL, network or credential tools. Ordinary schema/source merging, deduplication, group validation, figure verification and crop checks still run after collaboration. Cross-unit conflicts remain governed by the existing merge/retry logic; this is not a second whole-document completeness pass.

A review with no detected discrepancies does not clear existing review or missing-field flags. Accepted repairs are still marked for human review, and preserve original missing-field flags. Uncertain source and absent answers remain incomplete rather than becoming solved content. Human review is not an accuracy guarantee either.

## Outcomes and provenance

The unit audit records one of:

- `no_discrepancy`: no discrepancy detected in the original extraction; not verified accuracy.
- `issues`: findings remain, or the repair call could not complete; retain the original extraction.
- `unreviewed`: review could not complete or its source evidence/indexes were invalid; retain the original extraction.
- `repaired`: one proposal passed the bounded recheck; retain human review flags.
- `repair_rejected`: the proposal changed protected identity, dropped questions, had unresolved findings or could not be rechecked; retain the original extraction.

Checksum-addressed unit-result artifacts retain the original extraction, structured reports, proposed extraction when available, rejected reports and failure codes alongside the final extraction/visuals. Checkpoints retain only the artifact reference, counts and a compact audit status, not full original/proposed copies. Merge/preview/resume continue verifying artifact checksums. Artifacts expire with the existing task retention and must accompany service backups. Do not include them in offline practice backups.

Existing result warnings show each unit's audit status/failure code and up to five bounded findings with source quotes. Accepted repairs show the initial findings they addressed, including repair instructions and source quotes; disputed rechecks show the final findings. Full reports remain in the saved unit artifact. The public API/ZIP schema is unchanged; no result-editing or review-only endpoint is added. An unresolved missing-question finding produces a partial result. Incomplete review preserves usable extraction and review warnings rather than turning useful content into an empty failed unit. Re-reviewing a successfully extracted unit requires explicit **parse again**; passive reads and accepting partial results never rerun it.

## Cost and recovery

Calls use the existing `structured_call` boundary, durable per-attempt receipts, provider safeguards and input limits. Usage kinds are `import_review`, `import_repair` and `import_recheck`, in addition to existing extraction/figure calls. Invalid but billed outputs retain usage; unknown calls retain unknown usage. Missing or invalid usage in any review stage is recorded as an incomplete audit, preserving preceding known usage, the original extraction and the durable unknown-usage receipt on replay. Source text, reports and images are not added to telemetry logs.

The global `AI_TASK_MAX_MODEL_CALLS` limit remains unchanged (400 by default). Each structured stage permits at most four provider attempts. Enabled text units conservatively reserve up to 16 attempts (extraction, review, repair, recheck); enabled page units reserve up to 20 including figure verification. Unused reservations are not refunded. Normal success usually takes extraction plus review, but the reservation ceiling reduces how many units a fixed task budget can admit: at the default budget, up to 25 full text reservations or 20 full page reservations. Operators must assess representative documents before opting in; this is a call-count ceiling, not a monetary budget.

Review input includes source plus serialized extraction. Large units may exceed the existing model input limit; they stay visibly unreviewed rather than silently truncating source context. Budget/input/provider failures do not imply review success. Cancellation, deadlines, Store failures and existing pause controls stop work rather than being swallowed. Durable model attempts are reused on graph replay, including when an audit artifact write fails before checkpointing. Exactly-once remote requests remain unguaranteed if a response was not durably recorded.

## Verification and rollout

Fake-model tests cover bounded review/repair/recheck, invalid or nonliteral evidence, protected identity, incomplete calls, usage, missing questions, text and image integration, artifact persistence, replay and exhausted budgets. The evaluator recognizes all review stages and checks the four-attempt ceiling separately for each stage within a unit; reports record `import_review`. Scorer version `6.1.0` requires a fresh baseline for live comparisons. Run `make verify AI_PYTHON=/path/to/python3.14` and `make web-check`.

Before broad deployment, compare extraction-only, extraction/review, and extraction/review/repair against labeled representative documents. Measure missed errors, false positives, repair regressions, latency and provider cost. Two roles using the same model may share blind spots; neither fake tests nor no-discrepancy reports establish semantic accuracy. Keep the default off until that deployment's evidence supports opt-in.
