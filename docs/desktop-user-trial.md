# Consented desktop trial

Tracks [#92](https://github.com/shenyankm/PractiQ/issues/92). This protocol is ready for review; recruitment, participant consent and actual results remain pending. No participants were contacted, enrolled or observed for this PR. Distribution requires a tested build with the limitations described by the [release policy](releases.md). The planning target is 5–10 volunteers over four weeks after a build is available; it is not a user count or scheduled commitment.

## Invite and obtain consent

A maintainer must explicitly authorize contacting volunteers. Give each participant the exact build, platform requirements, known limitations, expected trial length and this optional consent text before recording feedback:

> I choose to try PractiQ voluntarily. I can skip any task or withdraw before the agreed summary date. Feedback will use an anonymous participant code and will contain platform/build identity, task outcomes and observations. Please record my observations only after I agree. Public quotations need my separate permission. Do not collect my API keys, personal answers, documents, databases or backups.

Keep consent and contact information separately under the coordinator's control; do not commit either. Agree on the summary date and private contact channel before starting. Delete identifying raw notes after the participant approves a sanitized summary, or at withdrawal. Store only anonymous consented observations in the public summary. If feedback contains secrets or private material, use [SECURITY.md](../SECURITY.md) and sanitize it before any public report.

## Task protocol

Run the offline tasks first with [the no-model sample bank](../app/fixtures/all-types.zip). Use an isolated app data area and synthetic answers; never replace personal study data for a trial. Do not modify gold answers or quality warnings to make the task pass.

| ID | Participant task | Observable completion |
| --- | --- | --- |
| T1 | Install and open the selected tested build | Application starts; platform/build and obstacle recorded |
| T2 | Settings → Restore backup → import the sample question-bank ZIP | Sample bank appended; existing data retained; warnings visible |
| T3 | Start practice, enter/submit a synthetic answer, skip and return | Answer state survives navigation; missing reference remains ungraded |
| T4 | Configure and finish a short mock exam | Selected duration/count retained; score review accessible |
| T5 | Review results and optionally apply an eligible manual self-assessment | Score/answer snapshots and any manual change understandable |
| T6 | Export a sample bank and import into an isolated empty dataset | Available source content, nulls, warnings and associations retained |
| T7 | Create a synthetic study-data backup and restore after confirmation | Replacement confirmation understood; saved synthetic practice preserved |

Offer AI tasks only as a separate optional choice after explicit participant Start import or grading/retry action. Explain provider, selected model, what data leaves the device and participant-approved cost ceiling before enabling it. Use public synthetic documents with supplied answers or rubrics. File selection and standalone Office conversion must not submit to a model. Do not configure providers or launch paid calls on a participant's behalf. Missing evidence stays ungraded.

For each task ask participants to describe what they expected, where they hesitated, any reproducible obstacle and whether help was needed. Collect no screen/audio recording by default. Separately obtain consent for any sanitized screenshot or quotation; remove personal filesystem paths and sensitive content before publishing.

## Record outcomes

Use anonymous codes such as P01 only after consent. Record a row per task, not a row per impression. Blank means unrecorded, not success. Attempts that stop with an obstacle are failed or incomplete; distinguish participant withdrawal from application failure.

| Participant code | Build SHA/version | OS/architecture | Task | Attempted? | Outcome: completed/failed/incomplete/not attempted | Help needed | Reproduction/obstacle | Consent for sanitized quote? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Pending | Pending | Pending | T1–T7 | Unrecorded | Unrecorded | Unrecorded | Unrecorded | Unrecorded |

Report actual invited/consented/started/completed/withdrawn counts separately. For each task show attempted N, completed N, failed N, incomplete N and not attempted N; explain missing observations. Report completion among attempted tasks with its denominator. Do not infer retention, efficiency improvement, model accuracy or sustained adoption from this trial.

## Triage, retest and publish

Reproduce confirmed problems with sanitized synthetic inputs and the current build. Search existing issues, then use the applicable [issue template](../.github/ISSUE_TEMPLATE/) with exact steps, expected/actual behavior and platform/build. Link existing issues instead of duplicating them; prioritize data integrity, unrecoverable workflows and release blockers. Record explicit deferrals and invite a retest only when contacting that participant is separately authorized.

Publish an anonymized summary that names the build/date, actual denominators, consented observations, linked issues/fixes, retest outcomes and remaining limitations. Omit quotations without separate permission and explain participation shortfalls. Close #92 only after this real evidence is reviewed. The protocol alone, maintainer demonstrations and synthetic CI are not user validation.
