# Consented desktop trial

Tracks [#92](https://github.com/shenyankm/PractiQ/issues/92). This protocol is ready for review; recruitment, participant consent and actual results remain pending. No participants were contacted, enrolled or observed for this PR. Distribution requires a tested build with the limitations described by the [release policy](releases.md). The planning target is 5–10 volunteers over four weeks after a build is available; it is not a user count or scheduled commitment.

## Invite and obtain consent

A maintainer must explicitly authorize contacting volunteers. Give each participant the exact build, platform requirements, known limitations, expected trial length and this optional consent text before recording feedback:

> I choose to try PractiQ voluntarily. I can skip any task or withdraw before the agreed summary date. Feedback will use a participant code and will contain platform/build identity, task outcomes and observations. The coordinator can link that code to me; public summaries will remove participant codes and identifying details. Please record my observations only after I agree. Public quotations need my separate permission. Do not collect my API keys, personal answers, documents, databases or backups.

Keep consent and contact information separately under the coordinator's control; do not commit either. Agree on the summary date and private contact channel before starting. Delete identifying raw notes after the participant approves a sanitized summary, at withdrawal, or on the agreed summary date, whichever comes first, including when no response arrives. Delete identifying consent/contact records and the code-to-person mapping at withdrawal or by that date. Publish only consented, sanitized observations without participant codes or identifying details. If feedback contains secrets or private material, use [SECURITY.md](../SECURITY.md) and sanitize it before any public report.

## Task protocol

Run the offline tasks first with [the no-model sample bank](../app/fixtures/all-types.zip). The app uses one [`v4/` data directory](question-model.md#versions-and-directories) per system account and has no profile switch. Prepare a dedicated system account on a test machine or a clean virtual machine with no personal PractiQ data. Run T1–T5 and T7 there, using synthetic answers, and confirm that banks and practice history are empty before T2. For T6, prepare a second fresh system account or clean virtual machine as the empty import destination; keep the first account's synthetic study data for T7. Do not move or delete `v4/`, or restore a backup over personal study data, to prepare a trial. Do not modify gold answers or quality warnings to make a task pass.

| ID | Participant task | Observable completion |
| --- | --- | --- |
| T1 | Install and open the selected tested build | Application starts; platform/build and obstacle recorded |
| T2 | Settings → Restore backup → import the sample question-bank ZIP | Sample bank imported; warnings visible |
| T3 | Start practice, enter/submit a synthetic answer, skip and return | Answer state survives navigation; missing reference remains ungraded |
| T4 | Configure and finish a short mock exam | Selected duration/count retained; score review accessible |
| T5 | Review results and optionally apply an eligible manual self-assessment | Score/answer snapshots and any manual change understandable |
| T6 | Export a sample bank and import into the second fresh account or virtual machine | Available source content, nulls, warnings and associations retained |
| T7 | In the first trial account, create a synthetic study-data backup and restore after confirmation | Replacement confirmation understood; saved synthetic practice preserved |

Offer AI tasks as a separate optional choice. Before configuring a provider or taking any model action, explain the provider, selected model, what data leaves the device and the participant-approved cost ceiling, then obtain explicit opt-in. Only after that agreement may the participant configure their own provider and explicitly choose Start import or grading/retry. Start import authorizes conversion and AI submission without another confirmation and may send content and incur costs. Use public synthetic documents with supplied answers or rubrics. File selection and standalone Office conversion must not submit to a model. Do not configure providers or launch paid calls on a participant's behalf. Missing evidence stays ungraded.

For each task ask participants to describe what they expected, where they hesitated, any reproducible obstacle and whether help was needed. Collect no screen/audio recording by default. Separately obtain consent for any sanitized screenshot or quotation; remove personal filesystem paths and sensitive content before publishing.

## Record outcomes

Use participant codes such as P01 only after consent; these remain identifiable to the coordinator until the mapping is deleted. Copy the seven rows below for each participant and record each task separately. Blank means unrecorded, not success. Attempts that stop with an obstacle are failed or incomplete; distinguish participant withdrawal from application failure.

| Participant code | Build SHA/version | OS/architecture | Task | Attempted? | Outcome: completed/failed/incomplete/not attempted | Help needed | Reproduction/obstacle | Consent for sanitized quote? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Pending | Pending | Pending | T1 | Unrecorded | Unrecorded | Unrecorded | Unrecorded | Unrecorded |
| Pending | Pending | Pending | T2 | Unrecorded | Unrecorded | Unrecorded | Unrecorded | Unrecorded |
| Pending | Pending | Pending | T3 | Unrecorded | Unrecorded | Unrecorded | Unrecorded | Unrecorded |
| Pending | Pending | Pending | T4 | Unrecorded | Unrecorded | Unrecorded | Unrecorded | Unrecorded |
| Pending | Pending | Pending | T5 | Unrecorded | Unrecorded | Unrecorded | Unrecorded | Unrecorded |
| Pending | Pending | Pending | T6 | Unrecorded | Unrecorded | Unrecorded | Unrecorded | Unrecorded |
| Pending | Pending | Pending | T7 | Unrecorded | Unrecorded | Unrecorded | Unrecorded | Unrecorded |

Report actual invited/consented/started/completed/withdrawn counts separately. For each task show attempted N, completed N, failed N, incomplete N and not attempted N; explain missing observations. Report completion among attempted tasks with its denominator. Do not infer retention, efficiency improvement, model accuracy or sustained adoption from this trial.

## Triage, retest and publish

Reproduce confirmed problems with sanitized synthetic inputs and the current build. Search existing issues, then use the applicable [issue template](../.github/ISSUE_TEMPLATE/) with exact steps, expected/actual behavior and platform/build. Link existing issues instead of duplicating them; prioritize data integrity, unrecoverable workflows and release blockers. Record explicit deferrals and invite a retest only when contacting that participant is separately authorized.

Publish a sanitized summary that names the build/date, actual denominators, consented observations, linked issues/fixes, retest outcomes and remaining limitations. Remove participant codes and identifying details, omit quotations without separate permission and explain participation shortfalls. Close #92 only after this real evidence is reviewed. The protocol alone, maintainer demonstrations and synthetic CI are not user validation.
