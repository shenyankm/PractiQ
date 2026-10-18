# AI issue labeling

The [AI issue labels workflow](../../.github/workflows/issue-labeler.yml) uses Alibaba Cloud Bailian `decision-model-preview` to classify issue titles and bodies. It adds an issue type and primary project area from a fixed allow-list. It never changes priorities, closes issues, removes labels, comments, or runs issue text as code. Existing type and area labels take precedence over model suggestions.

## Configuration and activation

Under repository **Settings → Secrets and variables → Actions**, configure:

| Setting | Kind | Value |
| --- | --- | --- |
| `ISSUE_LABELER_API_KEY` | Secret | Raw Bailian API key for the endpoint's business workspace; do not include `Bearer ` |
| `ISSUE_LABELER_ENDPOINT` | Variable | Full HTTPS System One endpoint from the Bailian console, ending in `/compatible-mode/v1/systemone` |
| `ISSUE_LABELER_ENABLED` | Variable | Set to `true` after verification to enable automatic classification; otherwise leave `false` |

The script accepts Beijing and Singapore workspace endpoints. It uses the [System One API](https://www.alibabacloud.com/help/en/model-studio/decision-model-api), not Chat Completions. The model and allowed questions are fixed in the script. No SDK, Copilot subscription, or additional GitHub token is needed. GitHub grants only `contents: read` and `issues: write` to the labeling job.

Before activation, create the area labels once (the type labels already exist):

```bash
gh label create 'area:desktop' --repo shenyankm/PractiQ --color 1D76DB --description 'Practice app on macOS or Windows'
gh label create 'area:android' --repo shenyankm/PractiQ --color 3DDC84 --description 'Android practice app and native integration'
gh label create 'area:web' --repo shenyankm/PractiQ --color 0E8A16 --description 'Browser frontend for document import'
gh label create 'area:server' --repo shenyankm/PractiQ --color 5319E7 --description 'AI service, document processing, and grading'
gh label create 'area:tooling' --repo shenyankm/PractiQ --color 6F42C1 --description 'Build, CI, packaging, and releases'
```

Merge the workflow through normal PR review and CI. In **Actions → AI issue labels → Run workflow**, select `main`, provide an open issue number, and leave `dry_run` enabled. This calls the model and logs proposed labels without applying them. Inspect representative bug, feature, support, and ambiguous issues; rerun with `dry_run` disabled to verify label writes. Then set `ISSUE_LABELER_ENABLED=true`.

## Classification and recovery

New, reopened, and title/body-edited issues trigger one model request each when enabled. Manual runs work even while automatic classification is disabled. Manual runs are restricted to `main`; PR runs test with fixtures and never receive the model key. Issues created by another workflow with `GITHUB_TOKEN` generally do not trigger workflows; classify those manually if needed.

The model selects one type (`bug`, `enhancement`, `question`, `documentation`, or no selection) and one primary area (`area:desktop`, `area:android`, `area:web`, `area:server`, `area:tooling`, `documentation`, or no selection). Multiple equally affected areas and unclear reports should produce no area selection. Only choices with confidence at least `0.85` are applied. This is an initial cutoff, not a measured accuracy guarantee; calibrate it against maintainer-reviewed real issues.

The workflow rereads the issue after classification, preserves existing labels, and skips stale results if the title/body changed or the issue closed. Malformed or unknown decisions fail without any label mutation. HTTP/JSON errors fail visibly without logging issue bodies, provider response bodies, or keys. There are no automatic model retries. Check the Actions run and rerun manually after fixing the cause.

The title and first 16,000 body characters are sent to the configured Bailian workspace. No attachments are downloaded, and no repository code or GitHub credentials are sent to the model. Long reports are truncated and may need manual classification. Each automatic issue edit can cause another request; configure provider-side spending limits before enabling. The [model page](https://help.aliyun.com/en/model-studio/decision-model-preview) currently lists a limited-time free offer, which is not a permanent pricing guarantee.

To stop automatic calls, set `ISSUE_LABELER_ENABLED=false`. Remove an incorrect label manually; a later run will preserve existing type/area labels, but may add a missing one. No historical issues are bulk relabeled automatically.

Local validation:

```bash
node --test .github/scripts/issue-labeler.test.mjs
```

Fixture tests establish request formatting, allowed-label validation, failure handling, and non-destructive writes. They do not establish live provider access or classification accuracy.
