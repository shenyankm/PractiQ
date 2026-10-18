# PractiQ PR bot

The private `practiq-pr-bot` App labels newly opened PRs with AI and submits
an `APPROVE` review after clean current-head Codex connector evidence and CI.
It does not merge PRs or enable auto-merge. GitHub enforces one valid approving
review, required CI and resolved conversations before a PR targeting `main`
can merge. Repository auto-merge is disabled; a maintainer merges manually.

## Approval conditions

All three final GitHub Actions gates (`Service CI`, `Desktop CI`, `Android CI`)
and every applicable check and commit status must succeed. Skipped intermediate
jobs are inapplicable; a skipped final gate never qualifies. The PR must be open,
non-draft, conflict-free and target `main`. Being blocked by missing approvals
is expected and does not block the bot's review. A branch may be behind main;
all checks and review evidence must still match its exact current head.

PRs touching `server/scripts/`, including either side of a rename, can receive
bot approval only after all current-head CI passes and the trusted connector's
structured summary explicitly confirms completed Code Review and Security
Review with no findings on that same head. A code approval without an explicit
security summary is insufficient. Review evidence is checked again immediately
before approval.

Changes to `.github/workflows/` or `.github/scripts/` still require manual
inspection and approval, even with clean automated reviews. This keeps
privileged workflows and the bot's own approval policy outside its approval
authority. The updated policy must reach protected `main` through normal
review before it can approve pending script PRs; dispatching the
old workflow does not activate unmerged policy changes. External contributors
can receive a bot approval under the same evidence checks.
Manual dispatch requires current `admin`, `maintain` or `write` access and
`dry_run` defaults to true; explicitly set false to submit or dismiss reviews.

Evidence comes only from `chatgpt-codex-connector[bot]`. Submitted reviews must
match the exact current head; abbreviated summary SHAs resolve uniquely through
GitHub. Current-head `CHANGES_REQUESTED` or `PENDING` reviews block approval;
dismissed reviews are ignored. Stale/incomplete summaries and inline findings
also block approval even when another report passes.

A summary must include a valid `codex-review-state:v1` record with the full head
SHA, `completed` status and both finding flags explicitly false for Code Review
and any Security Review. A pass requires either the latest current-head review
to be `APPROVED`, or a completed clean Code Review summary with a fresh connector
thumbs-up after all current-head reviews finish. A completed Security Review
alone is insufficient. `COMMENTED` prose such as “no findings” cannot authorize
approval on its own; ambiguous cases wait for a maintainer. Labels never enter
this decision and the approval job makes no model calls.

Before submitting, the bot refetches the PR, review evidence, checks, statuses
and manual dispatch authorization. The review explicitly binds `commit_id` to
the evaluated head. A post-submit head check withdraws the new approval if a
push raced with submission or the head cannot be confirmed. Repeated scans do
not duplicate its current-head approval. If clean evidence or CI stops passing,
the next scan dismisses only this bot's own current-head approvals; GitHub also
dismisses stale approvals on push. API errors skip that PR and allow later PRs
to proceed, without replaying uncertain writes.
Closing, converting to draft, reopening, marking ready or editing/retargeting a
PR triggers trusted-main revalidation. The bot attempts to withdraw its own
approval when the PR is ineligible; merged PRs retain their historical reviews.

For a closed, unmerged PR, GitHub can return HTTP 200 from the review-dismissal
endpoint while leaving the review `APPROVED`. This was observed on 2026-10-18
with both PR-only and Contents-write tokens in [acceptance PR #287](https://github.com/shenyankm/PractiQ/pull/287).
A successful workflow or HTTP response therefore does not prove withdrawal;
check the native review state. A closed PR cannot merge. On reopening, the
workflow rechecks current Codex evidence and CI and withdraws an invalid approval
while the PR is open. Wait for that revalidation before manually merging a
reopened PR. Draft and other open, ineligible PRs use the normal dismissal path.

## Configuration and operation

The protected `practiq-agent` environment allows only `main` and contains
`PRACTIQ_APP_CLIENT_ID` (variable) and `PRACTIQ_APP_PRIVATE_KEY` (secret).
The App installation needs Pull requests read/write, Contents read/write and
mandatory Metadata read. GitHub counts required approvals only from reviewers
with repository write access. A PR-write-only installation can submit an
`APPROVED` review without satisfying the required-approval rule; rollout
acceptance must also verify the PR's native `reviewDecision` becomes `APPROVED`.
See [GitHub's required-review rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-a-pull-request-before-merging).

Contents write makes the App capable of minting tokens that modify repository
files. Limit its installation to PractiQ, protect the private key in this
environment, and grant no ruleset bypass. The workflows still request only
repository-scoped PR-write App tokens, revoked at job completion; they do not
request Contents write. Read-only queries use the workflow token.
Privileged runs check out trusted `main`, never the PR or `workflow_run` head.
The API helper permits only review creation and review dismissal mutations.

### AI pull request labels

The separate [PR labels workflow](../../.github/workflows/pr-labels.yml) uses
the same App and `practiq-agent` environment. Set `PRACTIQ_AGENT_API_KEY` as a
secret and `PRACTIQ_AGENT_BASE_URL` / `PRACTIQ_AGENT_MODEL` as variables. The
base URL must be HTTPS and OpenAI-compatible; `/chat/completions` is appended.
The existing DeepSeek Flash configuration uses `thinking: {type: disabled}`;
Qwen models use `enable_thinking: false`. The shared classifier validates
responses against the [same catalog and ownership rules](../../CONTRIBUTING.md#issue-labels)
as Issue labels: missing Type, Area, P0–P3 and at most two topics. Maintenance
changes may have no matching Type. Existing labels always take precedence;
status and community labels remain manual.

Only `pull_request_target: opened` targeting `main` automatically authorizes
one model request when a core classification is missing. Edits, new commits,
reopening, CI completion and approval scans do not retry it. Maintainers can run
**PR labels → Run workflow** on `main` with a PR number for one explicit retry.
Closed PRs and other target branches are skipped. Changing or removing a label
alone does not start a model call. No historical PRs are scanned automatically.

The model receives up to 256 title and 12,000 body characters, classification
labels, and up to 100 changed file paths (256 characters each, including prior
paths for renames). Patches, source files, links and PR code are never loaded
or executed. The input reports the total file count and truncation. Public
contributors' new PRs can incur provider charges; avoid private data in PRs.
Requests have a 60-second timeout, 750 output tokens, no tools and no retries.
Invalid or failed answers leave labels unassigned. Before adding labels the
script refetches the PR and rejects changed title, body, head, base or open
state, while preserving concurrent maintainer labels.

PR tests receive no environment or credentials. The privileged job runs only
trusted `main` code and requests a repository-scoped Pull-requests-write App
token. The approval job remains separate and does not receive model credentials. GitHub's Pull requests write
permission also permits other PR changes; the label script only adds allowed
labels. Approve that permission for the existing installation when enabling
this feature. Disable **PR labels** in Actions to stop automatic classification.
Missing catalog definitions can be created with the same PR-write token;
GitHub's label endpoints accept either Issues write or Pull requests write.
The workflow must reach `main` before automatic events activate it. Validate
with `node --test .github/scripts/issue-labeler.test.mjs .github/scripts/pr-labeler.test.mjs`
and actionlint; live provider and App writes are separate acceptance checks.

### Issue labels and approval monitoring

The separate [Issue labels workflow](../../CONTRIBUTING.md#issue-labels) uses
the dedicated `PractiQ Issue` environment's `API_KEY`, `BASE_URL`, and `MODEL`
secrets to classify issues and assess missing priorities. Its separate
`practiq-issue-bot` App uses `APP_CLIENT_ID` and `APP_PRIVATE_KEY` from that
environment with Issues write access only. It does not receive the PR bot's
App private key or PR review permissions.

The [workflow](../../.github/workflows/maintainer.yml) runs after **AI service**
or **Practice App** completes. Current-head connector review submissions, edits
and dismissals trigger
the unprivileged [PR review signal](../../.github/workflows/review-signal.yml).
That workflow has no token permissions, secrets or checkout; its successful
completion wakes the protected `main` workflow, which refetches all evidence
and permissions. It targets the associated PR when GitHub supplies its number;
otherwise it scans open PRs under the same access restrictions. The signal
itself never authorizes an approval or runs privileged PR code.
A GPT review-summary comment creation/edit checks
that PR only. Other public comments do not start the privileged job. A daily
03:23 UTC scan catches later reactions and missed events; GitHub may delay it.
Scheduled opportunities decrease from 96 to one per day. Approval scans make
no paid model calls. Reaction-only updates may wait for the daily scan or manual dispatch.

Choose **PractiQ PR bot → Run workflow** on `main` for an immediate check,
optionally selecting a PR number. Disable this workflow to stop bot approvals
and withdrawals; **PR labels** can be controlled independently.

The active [main ruleset](../../.github/main-ruleset.json) requires one valid
approving review, dismisses stale approvals on push, retains required CI and
resolved conversations, and has no bypass actors. A clean current-head Codex
summary plus a fresh connector thumbs-up can authorize the PR bot's formal
`APPROVE`; `COMMENTED` or a thumbs-up alone does not count as a native approval.
The PR author's own review cannot supply that vote. Repository auto-merge is
disabled; a maintainer manually merges after the review and CI gates pass.
The bot never enables or executes merging. See
[repository security settings](dependency-security.md#repository-security-settings).

Run `node --test .github/scripts/maintainer.test.mjs` and actionlint for changes.
Local mocks establish gate behavior, not a live App approval or review accuracy.
Do not approve, merge or publish a PR/release merely to test setup.
