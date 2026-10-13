# PractiQ agent-bot

The private `practiq-agent-bot` GitHub App is installed only on this repository.
The [workflow](../.github/workflows/maintainer.yml) classifies new/edited/reopened
human-authored issues and posts first-pass COMMENT reviews on non-draft,
human-authored pull requests. Bot-authored issues/PRs require manual dispatch.
It never approves, merges, closes issues, removes labels or publishes a release.

## Configuration

Repository Actions variables:

- `PRACTIQ_APP_CLIENT_ID`: the App client ID.
- `PRACTIQ_AGENT_BASE_URL`: `https://amr-link.open-design.ai/v1`.
- `PRACTIQ_AGENT_MODEL`: `deepseek-v4.1-flash`.

Repository Actions secrets:

- `PRACTIQ_APP_PRIVATE_KEY`: the entire App private-key PEM.
- `PRACTIQ_AGENT_API_KEY`: the model gateway API key.

The App requires Issues, Pull requests, Contents and Actions read/write access,
plus mandatory Metadata read access. Each workflow job requests a narrower
installation token. No OAuth user authorization, webhook endpoint or server
is required. Keep App keys out of source and rotate through GitHub settings.

Issue titles/bodies and PR titles/bodies, patches and bounded changed-file
contents are sent to the configured provider with `AGENTS.md`. Calls may incur
provider charges. The script does not send App credentials to the model, use
model tools, execute PR code, or print model request/response bodies to logs.
Analysis has read-only GitHub access; validated results pass to a separate
publication job without model credentials. Result artifacts expire after one day.

## Operation

In Actions, choose **PractiQ agent-bot → Run workflow**:

- `triage`: supply an open issue number. Labels are limited to existing `bug`,
  `enhancement`, `documentation`, `question` and `accessibility`; at most three
  are added and existing labels remain untouched.
- `review`: supply an open, non-draft PR number. The review is bound to its head
  commit; an already-reviewed commit is not reviewed twice by the App.
- For either task, `dry_run` defaults to true. Inspect the `maintainer-result`
  artifact before dispatching with `dry_run` false. Automatic events publish
  validated results without a manual confirmation.
- `release-draft`: supply an existing candidate tag. This explicitly dispatches
  the existing [Release draft](../.github/workflows/release.yml) workflow on
  `main`. `dry_run` applies only to triage/review. Dispatch success is not build
  success: follow the separate Release draft run. Follow [release policy](releases.md)
  for final signing, evidence review and separately authorized publication.

PR-target events always check out trusted base code. The script reads contributor
files only through GitHub's API. Reviews cover at most 40 changed files and
200,000 characters of context, with whole-file contents limited to 30,000 bytes
each. Large/binary files and unchanged callers may be missing; this is a first
pass, not a substitute for human review or CI. Exceeding total limits, model/API
errors, truncated output or invalid JSON blocks publication. No automatic model
retries are made. Responses stream with a five-minute deadline to avoid gateway
idle timeouts; reasoning is discarded and only a normally completed JSON answer
can be published. Changed issue text or PR head also blocks stale publication.

## Validation

Run `node --test .github/scripts/maintainer.test.mjs`. Validate workflow syntax
with actionlint. After merging, perform a dry run and a manually authorized
publication on a selected existing issue/PR; do not equate local tests with
verified Actions execution. No release is built as part of agent setup.
