# Consented desktop trial

Tracks [#92](https://github.com/shenyankm/PractiQ/issues/92). This protocol is ready for review; recruitment, participant consent and actual results remain pending. No participants were contacted, enrolled or observed for this PR. Distribution requires a tested build with the limitations described by the [release policy](releases.md). The planning target is 5–10 volunteers over four weeks after a build is available; it is not a user count or scheduled commitment.

## Invite and obtain consent

A maintainer must explicitly authorize contacting volunteers. Give each participant the exact build, platform requirements, known limitations, expected trial length and this optional consent text before recording feedback:

> I choose to try PractiQ voluntarily. I can skip any task or withdraw before the agreed summary date. Feedback will use a participant code and will contain platform/build identity, task outcomes and observations. The coordinator can link that code to me; public summaries will remove participant codes and identifying details. Please record my observations only after I agree. Public quotations need my separate permission. Do not collect my API keys, personal answers, documents, databases or backups.

Keep consent and contact information separately under the coordinator's control; do not commit either. Agree on the summary date and private contact channel before starting. Delete identifying raw notes after the participant approves a sanitized summary, at withdrawal, or on the agreed summary date, whichever comes first, including when no response arrives. Delete identifying consent/contact records and the code-to-person mapping at withdrawal or by that date. Publish only consented, sanitized observations without participant codes or identifying details. If feedback contains secrets or private material, use [SECURITY.md](../SECURITY.md) and sanitize it before any public report.

## Task protocol

Run the offline tasks first with [the no-model sample bank](../app/fixtures/all-types.zip). The app uses one [`v4/` data directory](question-model.md#versions-and-directories) per system account and has no profile switch. Prepare a dedicated system account on a test machine or a clean virtual machine with no personal PractiQ data. Run T1–T5 and T7 there, using synthetic answers, and confirm that banks and practice history are empty before T2. For T6, prepare a second fresh system account or clean virtual machine as the empty import destination; keep the first account's synthetic study data for T7. Do not move or delete `v4/`, or restore a backup over personal study data, to prepare a trial. Do not modify gold answers or quality warnings to make a task pass.

Use the sample's visible stems to select `q4`, “简述你希望养成的学习习惯。” (short answer with a reference), and `q8`, “观察 PractiQ 图标，描述你的印象。” (no reference answer or rubric). The first ordered item, `q0`, has a reference answer and does not test missing-reference behavior.

| ID | Participant task | Observable completion |
| --- | --- | --- |
| T1 | Install and open the selected tested build | Application starts; platform/build and obstacle recorded |
| T2 | Settings → Restore backup → import the sample question-bank ZIP | Sample bank imported; warnings visible |
| T3 | Start ordinary practice; use Advanced settings → Select manually for q0, q4 and q8. Skip q0, submit synthetic answers to q4/q8, navigate away and back, then finish practice | Answer state and skip survive navigation; q8 remains ungraded |
| T4 | Configure and finish a short mock exam | Selected duration/count retained; score review accessible |
| T5 | History → View record for the T3 ordinary practice, not the T4 mock exam. Review q4's reference and optionally choose I got it right / I got it wrong for q4; leave q8 ungraded | Answer snapshots retained; q4's chosen self-assessment recorded if requested; q8 remains ungraded |
| T6 | Export a sample bank and import into the second fresh account or virtual machine | Available source content, nulls, warnings and associations retained |
| T7 | In the first trial account, create a synthetic study-data backup and restore after confirmation | Replacement confirmation understood; saved synthetic practice preserved |

Offer AI1 and AI2 separately; opting into one does not authorize the other or a retry. Before configuring a provider or taking any model action, explain the provider, selected model, what data leaves the device and the participant-approved cost ceiling, then obtain explicit opt-in. Only after that agreement may the participant privately enter their own trial-only key and explicitly choose Start import or grading/retry. Start import authorizes conversion and AI submission without another confirmation and may send content and incur costs. Use public synthetic documents with supplied answers or rubrics. File selection and standalone Office conversion must not submit to a model. Do not request, view or copy participants' keys, configure providers or launch paid calls on their behalf. Missing evidence stays ungraded.

Before offering paid AI work, the participant must verify a provider-enforced hard spending limit at or below the agreed amount, scoped to the trial key/account, or a restricted prepaid balance that rejects further charges without overdraft, automatic top-ups or paid fallback. Check the provider's documented enforcement, including concurrent/in-flight calls, and record the mechanism, amount and currency without credentials. A budget alert or PractiQ's token-usage display does not enforce a monetary ceiling. If a safeguard cannot be verified, do not offer paid AI tasks; record the reason rather than promise that a written ceiling bounds charges. Recheck remaining capacity and obtain a separate opt-in before any retry.

| ID | Optional participant task | Observable completion |
| --- | --- | --- |
| AI1 | Import → select [all-question-types.txt](../app/fixtures/ai-import/all-question-types.txt), enter a synthetic bank title/description, then Start import. Review saved questions and warnings before explicitly importing a bank | Reviewed result imported; complete/partial parsing status and any source mismatches recorded separately; available supplied answers, nulls and warnings retained. An attempt without a reviewable/imported result is failed or incomplete, not completed |
| AI2 | Create a separate mock exam with manual q4/q8 selection, enter synthetic answers and submit it. In the submitted exam, explicitly choose Start/resume AI grading for the eligible q4; leave q8 ungraded | q4's grading result and supplied reference evidence visible; q8 remains ungraded. Failed, unknown or ungraded q4 results are failed/incomplete observations; no automatic retry |

At completion or withdrawal from AI work, stop further grading or request a parsing pause, then wait for current model requests to return and parsing tasks to become inactive. These controls do not cancel a request already in flight. Have the participant revoke the trial-only provider key and use Settings → AI model → Configure → Clear saved API key. Verify clearing succeeds and the key is no longer configured; record cleanup success/failure without the key. If local clearing cannot be verified, destroy the disposable account/VM after revocation rather than retain its credentials. Do not reuse a trial environment with an active participant key.

For each task ask participants to describe what they expected, where they hesitated, any reproducible obstacle and whether help was needed. Collect no screen/audio recording by default. Separately obtain consent for any sanitized screenshot or quotation; remove personal filesystem paths and sensitive content before publishing. Show the exact sanitized image or quotation before requesting publication approval. Keep a private record of its stable screenshot/quote ID/version, approved image or exact text, participant approval and approval date under the same deletion deadline as other consent records. Record approved screenshot/quote IDs in the task row; a task-wide Yes is not permission for every observation. Changed crops, redactions or text require new approval, and unapproved artifacts must not be published.

## Record outcomes

Use participant codes such as P01 only after consent; these remain identifiable to the coordinator until the mapping is deleted. Copy all nine rows below for each participant and record each task separately. For each AI row, record not offered (with reason), offered/awaiting decision, declined or opted in. Blank means unrecorded, not success. Attempts that stop with an obstacle are failed or incomplete; distinguish participant withdrawal from application failure.

| Participant code | Build SHA/version | OS/architecture | Task | AI offer/opt-in | Attempted? | Outcome: completed/failed/incomplete/not attempted | Help needed | Reproduction/obstacle | Approved screenshot/quote ID(s), if any |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Pending | Pending | Pending | T1 | N/A | Unrecorded | Unrecorded | Unrecorded | Unrecorded | Unrecorded |
| Pending | Pending | Pending | T2 | N/A | Unrecorded | Unrecorded | Unrecorded | Unrecorded | Unrecorded |
| Pending | Pending | Pending | T3 | N/A | Unrecorded | Unrecorded | Unrecorded | Unrecorded | Unrecorded |
| Pending | Pending | Pending | T4 | N/A | Unrecorded | Unrecorded | Unrecorded | Unrecorded | Unrecorded |
| Pending | Pending | Pending | T5 | N/A | Unrecorded | Unrecorded | Unrecorded | Unrecorded | Unrecorded |
| Pending | Pending | Pending | T6 | N/A | Unrecorded | Unrecorded | Unrecorded | Unrecorded | Unrecorded |
| Pending | Pending | Pending | T7 | N/A | Unrecorded | Unrecorded | Unrecorded | Unrecorded | Unrecorded |
| Pending | Pending | Pending | AI1 | Unrecorded | Unrecorded | Unrecorded | Unrecorded | Unrecorded | Unrecorded |
| Pending | Pending | Pending | AI2 | Unrecorded | Unrecorded | Unrecorded | Unrecorded | Unrecorded | Unrecorded |

For every AI attempt, create a private record below before the model action, linked to its participant-code/task row by a unique attempt ID. Record that attempt's explicit opt-in decision/date, including separate opt-in for a retry, provider/model and verified spending safeguard with amount/currency and remaining capacity. Keep failed attempts when a later attempt succeeds. After AI work ends or the participant withdraws, record both provider revocation and local key-clearing results/dates for the attempts that used that key; never record the key. Unrecorded fields do not authorize a call or demonstrate successful cleanup. Apply the same deletion deadline as the task notes and consent records.

| Participant code | Task | Attempt ID | Initial/retry | Opt-in decision/date | Provider/model | Verified safeguard mechanism | Limit amount/currency; remaining capacity | Outcome | Reproduction/obstacle | Credential cleanup status/date: provider revocation and local clearing |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Pending | AI1 or AI2 | Pending | Unrecorded | Unrecorded | Unrecorded | Unrecorded | Unrecorded | Unrecorded | Unrecorded | Unrecorded |

Report actual invited/consented/started/completed/withdrawn counts separately. For each offline task show attempted N, completed N, failed N, incomplete N and not attempted N; explain missing observations. For AI1 and AI2 separately report offered, awaiting decision, declined, opted in and not offered counts. Report attempts, completion/failure/incomplete outcomes and not attempted counts among that task's opted-in participants; show the denominator explicitly and separate retry-attempt outcomes from participant counts. Do not count declined or unoffered AI work as application failures, or combine AI outcomes with offline-task denominators. Do not infer retention, efficiency improvement, model accuracy or sustained adoption from this trial.

## Triage, retest and publish

Reproduce confirmed problems with sanitized synthetic inputs and the current build. Search existing issues, then use the applicable [issue template](../.github/ISSUE_TEMPLATE/) with exact steps, expected/actual behavior and platform/build. Link existing issues instead of duplicating them; prioritize data integrity, unrecoverable workflows and release blockers. Record explicit deferrals and invite a retest only when contacting that participant is separately authorized.

Publish a sanitized summary that names the build/date, actual denominators, consented observations, linked issues/fixes, retest outcomes and remaining limitations. Remove participant codes and identifying details, omit quotations without separate permission and explain participation shortfalls. Close #92 only after this real evidence is reviewed. The protocol alone, maintainer demonstrations and synthetic CI are not user validation.
