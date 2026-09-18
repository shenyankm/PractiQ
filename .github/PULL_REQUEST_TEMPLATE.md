# Pull request

## Summary

<!-- Read CONTRIBUTING.md before requesting review. Keep the pull request focused and do not hard-wrap prose. Explain what changed and why. Describe behavior, not a list of files. -->

## Linked issue

<!-- Use "Fixes #123" when this pull request should close an issue. -->

## Affected areas

- [ ] Python AI service (`server/`)
- [ ] Documentation or tooling

## Validation

<!-- List the commands or manual flows you ran and their results. -->

| Check | Result |
| --- | --- |
| `make test` | Not run |
| `make verify` | Not run |

## Risk and rollout

- **Main risk or tradeoff**:
- **Database or migration impact**:
- **Configuration or secret changes**:
- **Not validated or out of scope**:

## Checklist

- [ ] This pull request addresses one concern
- [ ] The diff contains no unrelated or generated files
- [ ] New behavior has focused test coverage
- [ ] Required checks pass, or failures are explained above
- [ ] API, schema, environment, and user-facing changes are documented
- [ ] Logs, fixtures, screenshots, and commits contain no secrets or personal data
- [ ] The AI service remains private and focused on document import
- [ ] Production traffic still uses HTTPS
