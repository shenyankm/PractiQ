# PractiQ agent-bot

The private `practiq-agent-bot` App only squash-merges eligible PRs targeting
`main`. It consumes existing GPT review evidence through deterministic checks;
it does not interpret review prose, call a model, create approvals or publish releases.

## Merge conditions

All three final GitHub Actions gates (`Service CI`, `Desktop CI`, `Android CI`)
and every applicable check and commit status must succeed. Skipped intermediate
jobs are inapplicable; a skipped final gate never qualifies. GitHub must report
an open, non-draft PR without conflicts or protection blockers. A branch may
be behind main; it does not need to include the latest main commit. All checks
and review evidence must still match its exact current head.

PRs touching `.github/workflows/`, `.github/scripts/` or `server/scripts/`,
including either side of a rename, require manual inspection and manual merge.
This prevents PR-defined CI from spoofing required check names.

Automatic runs require the PR author to have current `admin`, `maintain` or
`write` access. External contributions require an explicit maintainer dispatch;
the dispatch actor must have one of those permissions. `dry_run` defaults to
true; only an explicit false permits that dispatch to merge.

Evidence comes only from `chatgpt-codex-connector[bot]`. Submitted reviews must
match the exact current head; abbreviated summary SHAs resolve uniquely through
GitHub. Current-head `CHANGES_REQUESTED` or `PENDING` reviews block evaluation;
dismissed reviews are ignored. A summary with stale or incomplete Code/Security
Review status also blocks earlier approvals. Current-head inline findings block
merging even when another report passes.

A summary must include a valid `codex-review-state:v1` record with the full head
SHA, `completed` status and both finding flags explicitly false for Code Review
and any Security Review. Missing, malformed or conflicting state blocks merging.
A pass requires either the latest current-head review to be `APPROVED`, or a
completed current-head Code Review summary with a GPT thumbs-up created after
all current-head reviews finish. A completed Security Review alone is insufficient.
A reused reaction cannot approve a later head or review. `COMMENTED` prose such
as “no findings” cannot authorize a merge on its own; ambiguous cases stay open
for a maintainer. No model verdict or interpretation cache is needed.

Immediately before merging, the bot refetches the PR, reviews, reactions, checks
and statuses, then rechecks the author or dispatch actor's write permission.
Changed evidence, head or authorization aborts the merge. The merge endpoint
receives the exact head SHA and enforces GitHub protections, including resolved
conversations. API errors skip that PR and permit later PRs to proceed; failed
merge requests are not retried within the run.

## Configuration and operation

The protected `practiq-agent` environment allows only `main` and contains
`PRACTIQ_APP_CLIENT_ID` (variable) and `PRACTIQ_APP_PRIVATE_KEY` (secret).
The App needs Contents read/write and mandatory Metadata read; read-only
queries use the workflow token. Only the App token calls the merge endpoint.
Privileged runs check out trusted `main`, never the PR or `workflow_run` head.

After this change reaches `main`, remove the unused `PRACTIQ_AGENT_API_KEY`
secret and `PRACTIQ_AGENT_BASE_URL` / `PRACTIQ_AGENT_MODEL` variables from that
environment. This branch removes their use without altering hosted credentials.

The [workflow](../../.github/workflows/maintainer.yml) runs after **AI service**
or **Practice App** completes. Direct current-head connector approvals trigger
the unprivileged [PR review signal](../../.github/workflows/review-signal.yml).
That workflow has no token permissions, secrets or checkout; its successful
completion wakes the protected `main` workflow, which refetches all evidence
and permissions. It targets the associated PR when GitHub supplies its number;
otherwise it scans open PRs under the same access restrictions. The signal
itself never authorizes merging or runs privileged PR code.
A GPT review-summary comment creation/edit checks
that PR only. Other public comments do not start the privileged job. A daily
03:23 UTC scan catches later reactions and missed events; GitHub may delay it.
Scheduled opportunities decrease from 96 to one per day. There are no paid
model calls. Reaction-only updates may wait for the daily scan or manual dispatch.

Choose **PractiQ agent-bot → Run workflow** on `main` for an immediate check,
optionally selecting a PR number. Automatic runs merge eligible trusted-author
PRs; disable the workflow in Actions to stop the bot. The checked-in main ruleset
permits squash only once applied to GitHub; see [repository security settings](dependency-security.md#repository-security-settings).

Run `node --test .github/scripts/maintainer.test.mjs` and actionlint for changes.
Local mocks establish gate behavior, not a live merge or review accuracy. Do not
merge or publish a PR/release merely to test setup.
