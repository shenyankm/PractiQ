# Contributor entry point and maintenance handover

Tracks [#93](https://github.com/shenyankm/PractiQ/issues/93). Prepared on 2026-10-04 against main `2e9215f59920a7e2f7d9bf9b64ff61b6d1f6ccd7`. Setup was exercised in an isolated managed checkout, not a clean machine. Existing Python/Node/Rust installations and installed service dependencies were reused; Windows/Linux onboarding and independent contributor participation remain unverified.

## Choose one bounded fixture task

The current evaluation manifest contains wholly answerless TXT sources, but no wholly answerless CSV, PDF or standalone PNG source. These small coverage additions use original synthetic content and offline scorer tests; they do not require paid model access or release credentials. Each issue contains affected files, exact validation commands and independently source-checked null-answer acceptance criteria.

| Contribution issue | Input / scope | Validation |
| --- | --- | --- |
| [#112: answerless CSV](https://github.com/shenyankm/PractiQ/issues/112) | One original two-question CSV + gold manifest + scorer regression | Validate manifest; focused evaluation tests; full service verify |
| [#113: answerless PDF](https://github.com/shenyankm/PractiQ/issues/113) | One original two-question PDF + reproducible source + gold/scorer regression | Same offline checks; visually inspect printed questions and absence of answers |
| [#114: answerless PNG](https://github.com/shenyankm/PractiQ/issues/114) | One original two-question image + reproducible source + gold/scorer regression | Same offline checks; inspect rendered source and explicit nulls |

These are unassigned `good first issue` / `help wanted` tasks. A label is an invitation, not an assignment or a record of a contribution. Broad release, live-model quality and user recruitment work is not labeled as beginner work.

## Reproduce focused setup

Follow [README prerequisites](../README.md) and [CONTRIBUTING](../CONTRIBUTING.md); do not create a project virtual environment. Choose an existing Python 3.14+ interpreter explicitly. From a fresh fork/checkout:

```sh
AI_PYTHON=/absolute/path/to/python3.14
make install-locked AI_PYTHON="$AI_PYTHON"
make app-install
"$AI_PYTHON" app/scripts/export-contracts.py --check
"$AI_PYTHON" app/scripts/check-fixtures.py
(cd server && PYTHONPATH=src "$AI_PYTHON" -m pytest tests/test_evaluation.py)
```

For UI changes run the existing UI/browser gates; for fixture/service changes run `make verify AI_PYTHON="$AI_PYTHON"` before requesting review. Setting the selected interpreter avoids accidentally using a shell's older `python`. Evaluation tests use paths relative to `server/`, so run them there; running them from root fails to locate `evals/cases.json`. Neither setup nor focused tests need a model key. For browser dependencies use the locked setup from README, not a symlink to another checkout's `node_modules`.

The isolated-checkout exercise for this PR ran locked `make app-install`, generated-contract check, shared fixture check and frontend lint successfully. Focused evaluation tests were run in the separate #90 preparation checkout from the same main source. Locked Python dependency installation was not repeated, and no clean-machine, bundled package or Windows/Linux onboarding is claimed. Report a concrete command/platform/error if these steps fail on a new machine; never include keys or personal paths in public logs.

## Responsibilities and current ownership

`shenyankm` is the repository owner. This PR creates no new repository role or access grant. Contributor, reviewer, signing/release operator and backup maintainer assignments remain opt-in and require explicit agreement; no backup maintainer is recorded here. Do not infer a person has accepted a role from a task listing or commit identity.

| Responsibility | Required evidence / access boundary |
| --- | --- |
| Triage | Reproduce with sanitized data; search duplicates; preserve issue template; prioritize integrity and release blockers |
| Review | One concern, focused regression evidence, generated-contract parity and architecture/model-trigger boundaries; no secret access needed |
| Merge | Repository write access and all required checks/review conversations; a PR author does not automatically become a merger |
| Release | Explicit selected main/tag, final-package/live/manual/signing evidence and release rights; credentials stay in approved secret stores |
| Security | Follow private reporting in SECURITY.md; do not copy exploit details or secrets into public issues |
| Backup maintainer | Explicit consent, verified access and a supervised review/release dry run before recording the role as filled |

## Handover checklist

- [ ] Record named opt-in owners, accepted scope, required access and backup maintainer status.
- [ ] Inventory active PRs/issues, required checks, current source/schema/backup boundaries and known release blockers.
- [ ] Reproduce focused setup on an isolated checkout; distinguish reused runtimes from a fresh-machine test.
- [ ] Review service recovery, local storage, native file authorization, credential isolation and explicit model-action boundaries in AGENTS.md.
- [ ] Walk through one actual issue triage and PR review, retaining links and outcomes.
- [ ] Walk through the release policy and signing evidence without sharing credentials; publication remains separately authorized.
- [ ] Verify permission changes and credential handover through approved stores, then record only nonsecret access status.
- [ ] Link an actual external contribution/review outcome; leave this item open until someone participates.

No external contribution or review outcome is recorded by this preparation PR. Keep #93 open for independent onboarding, actual contributions and any agreed backup maintainer. Do not claim community growth from creating these three listings.
