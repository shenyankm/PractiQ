# Consented practice app trial

Tracks [#92](https://github.com/shenyankm/PractiQ/issues/92). This protocol is ready for review; recruitment, participant consent and actual results remain pending. No participants were contacted, enrolled or observed for this PR. Distribution requires a tested build with the limitations described by the [release policy](../maintainers/releases.md). The planning target is 5–10 volunteers over four weeks after a build is available; it is not a user count or scheduled commitment.

## Invite and obtain consent

A maintainer must explicitly authorize contacting volunteers. Give each participant the exact build, platform requirements, known limitations, expected trial length and this optional consent text before recording feedback:

> I choose to try PractiQ voluntarily. I can skip any task or withdraw before the agreed summary date. Feedback will use a participant code and will contain platform/build identity, task outcomes and observations. The coordinator can link that code to me; public summaries will remove participant codes and identifying details. Please record my observations only after I agree. Public quotations need my separate permission. Do not collect my API keys, personal answers, documents, databases or backups.

Keep consent and contact information separately under the coordinator's control; do not commit either. Agree on the summary date and private contact channel before starting. Delete identifying raw notes after the participant approves a sanitized summary, at withdrawal, or on the agreed summary date, whichever comes first, including when no response arrives. Delete identifying consent/contact records and the code-to-person mapping at withdrawal or by that date. Publish only consented, sanitized observations without participant codes or identifying details. If feedback contains secrets or private material, use [SECURITY.md](../../SECURITY.md) and sanitize it before any public report.

## Task protocol

Run the offline tasks first with [the no-model sample bank](../../app/fixtures/all-types.zip). The current trial target is macOS 14+ on Apple Silicon; retired Windows/Android evidence is historical, not a supported trial build. The app has no profile switch and keeps its [`v4/` data](../reference/question-model.md#versions-and-directories) per macOS system account. Prepare a dedicated system account on a test machine or a clean virtual machine. Each trial environment must contain no personal PractiQ data. Run T1–T5 and T7 there, using synthetic answers, and confirm that banks and practice history are empty before T2. For T6, prepare a second fresh, independent trial environment as the empty import destination; retain the first environment's synthetic study data for T7. Do not clear personal app storage, move or delete `v4/`, or restore a backup over personal study data to prepare a trial. Do not modify gold answers or quality warnings to make a task pass.



Use the sample's visible stems to select `q4`, “简述你希望养成的学习习惯。” (short answer with a reference), and `q8`, “观察 PractiQ 图标，描述你的印象。” (no reference answer or rubric). The first ordered item, `q0`, has a reference answer and does not test missing-reference behavior. In T3, also select the “Listening — chimes” document group and check the sample image and local audio. Let the clip finish naturally; choose Replay from start, observe that it does not start playback, then choose Play audio and pause/resume it. Repeat the image/audio checks after T6 import and T7 restoration.


| ID | Participant task | Observable completion |
| --- | --- | --- |
| T1 | Install and open the selected tested build in the isolated trial environment | Application starts; platform/build identity and obstacle recorded |
| T2 | Settings → Import and restore → Import bank ZIP | Sample bank imported; warnings visible |
| T3 | Start ordinary practice; use Advanced settings → Select manually for q0, q4, q8 and the Listening — chimes group. Skip q0, submit synthetic answers to q4/q8, check the image/audio, navigate away and back, then finish practice | Answer state and skip survive navigation; image/audio usable; q8 remains ungraded |
| T4 | Configure and finish a short mock exam | Selected duration/count retained; score review accessible |
| T5 | History → View record for the T3 ordinary practice, not the T4 mock exam. Review q4's reference and optionally choose I got it right / I got it wrong for q4; leave q8 ungraded | Answer snapshots retained; q4's chosen self-assessment recorded if requested; q8 remains ungraded |
| T6 | Export a sample bank and import into the second fresh trial environment | Available source content, nulls, warnings, associations and image/audio resources retained |
| T7 | In the first trial environment, create a synthetic study-data backup and restore after replacement confirmation | Replacement confirmation understood; saved synthetic practice and image/audio resources preserved |

Offer AI1 and AI2 separately; opting into one does not authorize the other or a retry. Before configuration or model work, explain the chosen connection, providers/models, what data leaves the device and the participant-approved cost ceiling, then obtain explicit opt-in. These instructions do not authorize live calls for the current work; absent separate authorization, mark both AI tasks not offered.

For AI1, the participant privately configures a trial-only independent service with Tencent and question-structuring provider credentials in its trusted environment, and enters that service's personal Bearer token in the Web frontend. The token stays in browser memory. There are no phone/card accounts, point rates or recharge steps. Explicit Start import authorizes normalization, Tencent parsing and model structuring without another confirmation, and may incur charges from both providers. All new supported formats use Tencent. The current service converts legacy XLS at every size and oversized Office inputs through its isolated PDF adapter before Tencent; a deployment without that converter does not offer XLS.

For AI2, record whether the participant selects **Direct model API** or **Independent AI service** in Settings → AI service. Direct grading uses an OpenAI-compatible Chat Completions endpoint/model and a participant-entered API key stored by native code in macOS Keychain. Service grading uses the separately configured service URL and personal Bearer token, also held in Keychain. Neither credential belongs in SQLite, backups, browser storage, public feedback or coordinator notes. Changing connection mode does not authorize grading or delete the other mode's credentials. Only explicit grading/retry starts grading work; missing reference evidence stays ungraded, and failed or unknown results need an explicit retry.

Use public synthetic documents with supplied answers or rubrics. File selection, read-only review and ZIP download must not submit to a model. Do not request, view or copy participants' keys, configure providers or launch paid calls on their behalf.

Before offering paid AI work, the participant must verify a hard spending safeguard for every provider used, including Tencent; one provider's limit does not cover another's charges. Require provider-enforced limits scoped to the trial keys/accounts, whose agreed amounts together fit the total ceiling, or restricted prepaid balances that reject further charges without overdraft, automatic top-ups or paid fallback. Check the provider's documented enforcement, including concurrent/in-flight calls, and record the mechanism, amount and currency without credentials. A budget alert or PractiQ's token-usage display does not enforce a monetary ceiling. If a safeguard cannot be verified, do not offer paid AI tasks; record the reason rather than promise that a written ceiling bounds charges. Recheck remaining capacity and obtain a separate opt-in before any retry.

| ID | Optional participant task | Observable completion |
| --- | --- | --- |
| AI1 | Open the independent service Web frontend, select [all-question-types.txt](../../app/fixtures/ai-import/all-question-types.txt), then Start import. Review saved questions and warnings, download the bank ZIP and import it in the practice app through Settings → Import and restore → Import bank ZIP | Reviewed result imported; complete/partial parsing status and any source mismatches recorded separately; available supplied answers, nulls and warnings retained. An attempt without a reviewable/imported result is failed or incomplete, not completed |
| AI2 | Create a separate mock exam with manual q4/q8 selection, enter synthetic answers and submit it. In the submitted exam, explicitly choose Start/resume AI grading for the eligible q4; leave q8 ungraded | q4's grading result and supplied reference evidence visible; q8 remains ungraded. Failed, unknown or ungraded q4 results are failed/incomplete observations; no automatic retry |

At completion or withdrawal from AI work, stop further grading or request a parsing pause, then wait for current requests to return and parsing tasks to become inactive. These controls do not cancel a request already in flight. Have the participant revoke every trial-only provider credential used (including Tencent, structuring and direct-grading keys), use **Clear saved API Key** or **Clear saved access token** in Settings → AI service for each configured trial endpoint/mode, and disconnect the independent Web frontend. A blank key field keeps the saved credential; changing modes alone does not clear it. Verify provider revocation, native credential removal and Web disconnection separately; record cleanup success/failure without credentials. If local clearing cannot be verified, remove only the disposable trial account or VM after revocation rather than retain its credentials; preserve any agreed synthetic study backup first. Do not reset unrelated environments or personal data. Do not reuse a trial environment with an active participant key.

For each task ask participants to describe what they expected, where they hesitated, any reproducible obstacle and whether help was needed. Collect no screen/audio recording by default. Separately obtain consent for any sanitized screenshot or quotation; remove personal filesystem paths and sensitive content before publishing. Show the exact sanitized image or quotation before requesting publication approval. Keep a private record of its stable screenshot/quote ID/version, approved image or exact text, participant approval and approval date under the same deletion deadline as other consent records. Record approved screenshot/quote IDs in the task row; a task-wide Yes is not permission for every observation. Changed crops, redactions or text require new approval, and unapproved artifacts must not be published.

## Record outcomes

Use participant codes such as P01 only after consent; these remain identifiable to the coordinator until the mapping is deleted. Copy all nine rows below for each participant and record each task separately. For each AI row, record not offered (with reason), offered/awaiting decision, declined or opted in. Blank means unrecorded, not success. Attempts that stop with an obstacle are failed or incomplete; distinguish participant withdrawal from application failure.

Store all filled-in task records, per-attempt records and raw notes, including participant codes and free text, privately under the coordinator's control; do not commit or upload them to a repository. Apply the existing raw-note deletion deadline above to all of these records. Publish only consented, sanitized aggregates or public artifacts whose exact version has been approved under the publication-consent rules above; remove participant codes and identifying details.

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

For every AI attempt, create a private record below before the model action, linked to its participant-code/task row by a unique attempt ID. Record that attempt's explicit opt-in decision/date, including separate opt-in for a retry, provider/model and verified spending safeguard with amount/currency and remaining capacity. Keep failed attempts when a later attempt succeeds. After AI work ends or the participant withdraws, record provider revocation, native API-key/token removal and Web disconnection results/dates for the attempts that used that key; never record the key. Unrecorded fields do not authorize a call or demonstrate successful cleanup. Apply the same deletion deadline as the task notes and consent records.

| Participant code | Task | Attempt ID | Initial/retry | Opt-in decision/date | Provider/model | Verified safeguard mechanism | Limit amount/currency; remaining capacity | Outcome | Reproduction/obstacle | Credential cleanup status/date: provider revocation, native API-key/token removal and Web disconnection |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Pending | AI1 or AI2 | Pending | Unrecorded | Unrecorded | Unrecorded | Unrecorded | Unrecorded | Unrecorded | Unrecorded | Unrecorded |

Report actual invited/consented/started/completed/withdrawn counts separately. For each offline task show attempted N, completed N, failed N, incomplete N and not attempted N; explain missing observations. For AI1 and AI2 separately report offered, awaiting decision, declined, opted in and not offered counts. Report attempts, completion/failure/incomplete outcomes and not attempted counts among that task's opted-in participants; show the denominator explicitly and separate retry-attempt outcomes from participant counts. Do not count declined or unoffered AI work as application failures, or combine AI outcomes with offline-task denominators. Do not infer retention, efficiency improvement, model accuracy or sustained adoption from this trial.

## Triage, retest and publish

Reproduce confirmed problems with sanitized synthetic inputs and the current build. Search existing issues, then use the applicable [issue template](../../.github/ISSUE_TEMPLATE/) with exact steps, expected/actual behavior and platform/build. Link existing issues instead of duplicating them; prioritize data integrity, unrecoverable workflows and release blockers. Record explicit deferrals and invite a retest only when contacting that participant is separately authorized.

Publish a sanitized summary that names the build/date, actual denominators, consented observations, linked issues/fixes, retest outcomes and remaining limitations. Remove participant codes and identifying details, omit quotations without separate permission and explain participation shortfalls. Close #92 only after this real evidence is reviewed. The protocol alone, maintainer demonstrations and synthetic CI are not user validation.
