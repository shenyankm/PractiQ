## Summary

<!-- Read CONTRIBUTING.md before requesting review. Keep the pull request focused and do not hard-wrap prose. Explain the problem and resulting behavior, not a list of files. If AI assistance was used, describe its role and your manual verification. -->

## Linked issue

<!-- Use "Fixes #123" when this pull request should close an issue. Use N/A when no issue is required under CONTRIBUTING.md. -->

## Affected areas

- [ ] Python AI service (`server/`)
- [ ] Desktop application (`app/`)
- [ ] Documentation or tooling

## Validation

Choose checks from the [contribution guide](https://github.com/shenyankm/PractiQ/blob/main/CONTRIBUTING.md#validate-the-change) for the affected areas.

<!-- Add commands and manual flows with their platform/environment and results. Distinguish local checks from CI and mocked checks from native or live-model validation. Use Passed, Failed — reason, Not run — reason, or N/A — reason. Report untested platforms and flows below. -->

| Check or manual flow | Platform / environment | Result |
| --- | --- | --- |
| | | |

## Risk and rollout

<!-- Use N/A with a reason for unrelated items. Where affected, consider backup compatibility, practice and score snapshots, image/audio integrity, credential storage, and explicit model-call triggers. For independent-service deployment changes, verify loopback binding and HTTPS at the external entry point. -->

- **Main risk or tradeoff**:
- **Database or migration impact**:
- **Configuration or secret changes**:
- **Not validated or out of scope**:

## Checklist

<!-- Only check verified items. Explain non-applicable items rather than marking them complete. -->

- [ ] This pull request addresses one concern
- [ ] The diff contains no unrelated or generated files
- [ ] Behavior changes have focused regression coverage
- [ ] Required checks pass, or failures are explained above
- [ ] API, schema, environment, and user-facing changes are documented
- [ ] Logs, fixtures, screenshots, and commits contain no secrets or personal data
- [ ] Affected flows preserve the architecture and explicit model-call boundaries in AGENTS.md
