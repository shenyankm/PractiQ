# Pull request

## Summary

<!-- Read CONTRIBUTING.md before requesting review. Keep the pull request focused and do not hard-wrap prose. Explain what changed and why. Describe behavior, not a list of files. -->

## Linked issue

<!-- Use "Fixes #123" when this pull request should close an issue. -->

## Affected areas

- [ ] Java product API (`backend/`)
- [ ] Python AI service (`server/`)
- [ ] WeChat Mini Program (`weapp/`)
- [ ] PostgreSQL schema (`db/`)
- [ ] Documentation or tooling

## Validation

<!-- List the commands or manual flows you ran and their results. -->

| Check | Result |
| --- | --- |
| `make backend-test` | Not run |
| `make test-server` | Not run |
| `make test` | Not run |
| `make verify` | Not run |

## User-visible evidence

<!-- Add before-and-after screenshots or a recording for Mini Program changes. Write "N/A" for internal changes. -->

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
- [ ] Database changes include rollout notes for existing data
- [ ] Logs, fixtures, screenshots, and commits contain no secrets or personal data
- [ ] Product authentication, persistence, and billing remain in `backend/`
- [ ] The AI service remains private, stateless, and free of product resource IDs
- [ ] Production traffic still uses HTTPS
