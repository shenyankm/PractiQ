# PractiQ agent-bot

The private `practiq-agent-bot` App is installed only on PractiQ, with the default
GitHub App avatar. It only squash-merges eligible PRs targeting `main`. It does
not classify issues, review source code or publish releases. The configured AI
interprets existing GPT review results; it does not create a GitHub approval.

## Merge conditions

Before any model call, all three final GitHub Actions gates (`Service CI`,
`Desktop CI`, `Android CI`) must succeed, along with every applicable check and
commit status. Skipped intermediate jobs are inapplicable; a skipped final gate
never qualifies. GitHub must report an open, non-draft PR with a clean merge,
current base, no conflicts and no branch-protection blocker.

PRs that add, modify, delete or rename workflow files, `.github/scripts/`
(including the privileged agent and its tests), or `server/scripts/`
(including CI scope code and modules that could shadow its imports)
are excluded from the bot,
even on manual dispatch; maintainers must inspect their CI definitions and merge
them manually. This prevents PR-defined jobs from spoofing the required CI names.

Automatic paid interpretation is limited to PR authors with current repository
`admin`, `maintain` or `write` access. An external contribution requires a
maintainer to manually dispatch the workflow; that actor's permission is checked
before inference. Public issue/PR edits cannot trigger arbitrary paid analysis.

Evidence is fetched only from `chatgpt-codex-connector[bot]`: submitted reviews
on the exact current head, their inline findings, the bot's Code Review Summary
and its thumbs-up timestamps. A summary must explicitly identify a completed
Code Review on the current head; a completed Security Review alone is insufficient.
Abbreviated SHAs are resolved uniquely through GitHub to the full current head.
Explicit passing feedback is required: a current-head approval/clean report, or
a GPT thumbs-up created after all current-head reviews complete. Completion alone
is insufficient. Old/reused global reactions cannot approve a new head; if the
connector retains an old reaction and emits no clean report, the PR stays open. All current-head reviews and findings are retained. Any active current-head
CHANGES_REQUESTED or PENDING review blocks inference; dismissed reviews are ignored.
A same-head Code or Security re-review still running also blocks earlier approvals.

AI must return completed/passed, the exact head SHA and an existing supporting
report ID. It is instructed to reject unresolved blockers, pending security
review, ambiguous results and generic help text. COMMENTED can contain a clean
report or findings; its state alone is not treated as a pass. Missing/stale
reports, malformed output, truncated answers, model/network errors or an
uncertain verdict cause no merge. No model tools or source-code review run.

The merge request includes the analyzed head SHA. GitHub rejects a changed head
and enforces the repository's existing rules, including resolved conversations
and checks against the current base. Protection failures are not bypassed or
retried within a run. Squash attribution and source-branch cleanup follow the
repository's existing settings.

## Configuration and operation

App permissions: Contents read/write and mandatory Metadata read. Pull requests
write is not needed: the merge endpoint only requires Contents write.
Contents write is needed by the merge API; Issues and Actions permissions are not
needed. Read-only CI/review/reaction queries use the workflow token (including Issues read); a narrowly scoped
App token performs the merge. The model request never includes GitHub tokens or
App keys and does not give the model tool access.

Environment variables in `practiq-agent`:

- `PRACTIQ_APP_CLIENT_ID`
- `PRACTIQ_AGENT_BASE_URL`: `https://amr-link.open-design.ai/v1`
- `PRACTIQ_AGENT_MODEL`: `deepseek-v4.1-flash`

Environment secrets in `practiq-agent`: `PRACTIQ_APP_PRIVATE_KEY` and
`PRACTIQ_AGENT_API_KEY`. This environment permits deployments only from the
`main` branch, with no tag policy or per-run approval. The credentials and provider variables no longer remain at
repository scope, so a branch-controlled workflow cannot read them. Privileged
runs also require `refs/heads/main`, and always check out `main`.
Only bounded GPT report/reaction evidence (at most 30,000 characters) is sent to
the provider, with a 750-token answer cap and two-minute timeout. Calls may incur
provider charges. Unsuccessful verdicts can be re-evaluated every 15 minutes;
A per-PR API, model, revalidation or merge error skips that PR and allows later
PRs to proceed. Automatic scans have a 30-minute job budget.
AI interpretation can be wrong, so CI and GitHub protections remain mandatory.

The [workflow](../.github/workflows/maintainer.yml) checks open PRs when **AI
service** or **Practice App** completes and every 15 minutes to catch a later GPT
review. Scheduled runs can be delayed by GitHub. Only trusted `main` code is
checked out, including when processing an external fork's CI completion.

For a manual check, choose **PractiQ agent-bot → Run workflow** on `main`, with an
optional PR number. `dry_run` defaults to true; it may interpret an eligible GPT
report but never merges. Automatic runs merge eligible PRs. Disable the workflow
in Actions to stop the bot. Existing release policy and workflow are unchanged.

Run `node --test .github/scripts/maintainer.test.mjs` and actionlint for gate changes.
Local mock tests and synthetic model smoke tests do not establish a live merge or
real review accuracy. No PR/release is merged/published merely to test setup.
