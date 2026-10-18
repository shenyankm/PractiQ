# PractiQ PR labels

The private `practiq-pr-bot` App labels newly opened PRs with AI. Automatic
review approval and withdrawal have been removed, along with their review-signal
and scheduled workflows. Labels do not grant merge permission. Required CI and
resolved conversations remain enforced; a maintainer checks current-head Code
Review and Security Review results and merges manually. Native approving votes
are optional, and repository auto-merge remains disabled.

## Configuration and operation

The protected `practiq-agent` environment allows only `main` and contains
`PRACTIQ_APP_CLIENT_ID` (variable) and `PRACTIQ_APP_PRIVATE_KEY` (secret).
PR labeling needs Pull requests read/write and mandatory Metadata read;
Contents write is no longer needed. If the existing App installation still has
Contents write from the former approval setup, reduce its configured permission
in the App settings. Keep its installation limited to PractiQ, protect the
private key in this environment, and grant no ruleset bypass. The workflow
requests only a repository-scoped PR-write App token, revoked at job completion.
Privileged runs check out trusted `main`, never PR code.

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
reopening and CI completion do not retry it. Maintainers can run
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
token. GitHub's Pull requests write
permission also permits other PR changes; the label script only adds allowed
labels. Approve that permission for the existing installation when enabling
this feature. Disable **PR labels** in Actions to stop automatic classification.
Missing catalog definitions can be created with the same PR-write token;
GitHub's label endpoints accept either Issues write or Pull requests write.
The workflow must reach `main` before automatic events activate it. Validate
with `node --test .github/scripts/issue-labeler.test.mjs .github/scripts/pr-labeler.test.mjs`
and actionlint; live provider and App writes are separate acceptance checks.

### Issue labels

The separate [Issue labels workflow](../../CONTRIBUTING.md#issue-labels) uses
the dedicated `PractiQ Issue` environment's `API_KEY`, `BASE_URL`, and `MODEL`
secrets to classify issues and assess missing priorities. Its separate
`practiq-issue-bot` App uses `APP_CLIENT_ID` and `APP_PRIVATE_KEY` from that
environment with Issues write access only. It does not receive the PR bot's
App private key or PR review permissions.

The [main ruleset](../../.github/main-ruleset.json) requires `Service CI`,
`Desktop CI`, `Android CI` and resolved conversations, with no bypass actors.
It requires zero approving reviews and no extra approval for unattributed
changes. Read and verify hosted settings separately; the checked-in file does
not activate them. See [repository security settings](dependency-security.md#repository-security-settings).
