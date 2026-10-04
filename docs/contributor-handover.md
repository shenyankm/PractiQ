# Contributor entry point and maintenance handover

Tracks [#93](https://github.com/shenyankm/PractiQ/issues/93). On 2026-10-04 a maintainer rehearsed the complete focused setup in one fresh managed checkout of `8cdc570e17657250a6a4e82f1049e359e3104e80`, the [#133 Android candidate](https://github.com/shenyankm/PractiQ/pull/133). That candidate was still open when status was checked at 09:43 UTC; observed main was `dbf8679ac11b2cf6c1462e6f9b64e284fa91b72c`, containing the merged CSV contribution [#134](https://github.com/shenyankm/PractiQ/pull/134). Existing macOS arm64 runtimes were reused: Python 3.14.7, Node 22.23.2, npm 10.9.8 and uv 0.12.13. The maintainer execution verifies that the documented setup commands work in an isolated checkout with reused runtimes; it records no clean-machine test or another person's participation.

The rehearsed candidate targets macOS, Windows and Android and removes Linux app packaging; Linux remains a service/CI host. Follow the [Android guide](../app/docs/android.md) for SDK, APK and emulator checks. This rehearsal exercised no Rust/native package, Android SDK/device, Windows native or Linux service-host checks.

## Review bounded fixture contributions

The three initial tasks addressed actual gaps for wholly answerless CSV, PDF and standalone PNG sources; answerless TXT sources already existed. They use original synthetic content and offline scorer tests and require neither paid model access nor release credentials. Each issue contains affected files, exact validation commands and independently source-checked null-answer acceptance criteria. The table records the GitHub status observed at 09:43 UTC on 2026-10-04; recheck its issue and PR before choosing work.

| Contribution issue | Input / scope | Validation | Observed status |
| --- | --- | --- | --- |
| [#112: answerless CSV](https://github.com/shenyankm/PractiQ/issues/112) | One original two-question CSV + gold manifest + scorer regression | Validate manifest; focused evaluation tests; full service verify | Completed: [#134](https://github.com/shenyankm/PractiQ/pull/134) merged; issue closed |
| [#113: answerless PDF](https://github.com/shenyankm/PractiQ/issues/113) | One original two-question PDF + reproducible source + gold/scorer regression | Same offline checks; visually inspect printed questions and absence of answers | [#135](https://github.com/shenyankm/PractiQ/pull/135) open; issue open |
| [#114: answerless PNG](https://github.com/shenyankm/PractiQ/issues/114) | One original two-question image + original-source provenance/generation note + gold/scorer regression | Same offline checks; inspect rendered source and explicit nulls | [#136](https://github.com/shenyankm/PractiQ/pull/136) open; issue open |

The initial listings used `good first issue` / `help wanted` for these bounded tasks. A label is an invitation, not an assignment or evidence of a completed contribution. Completed rows are examples, and an open issue with an active PR needs coordination before duplicating its work; do not recreate listings solely to maintain a count. Broad release, live-model quality and user recruitment work is not beginner work.

Cid-oe publicly offered a PNG fixture in [the #114 source comment](https://github.com/shenyankm/PractiQ/issues/114#issuecomment-5976045114). [The original fork commit](https://github.com/Cid-oe/PractiQ/commit/7f2974618279e3fd0b27301f126a1a19206c4aac) records Siddharth U as its author; upstream #136 preserves that attribution. This is evidence of an offered external contribution, while upstream acceptance and completed review outcomes remain pending. It does not establish that its author followed this onboarding guide or accepted a maintainer role.

## Reproduce focused setup

Follow [README prerequisites](../README.md) and [CONTRIBUTING](../CONTRIBUTING.md); do not create a project virtual environment. Choose an existing Python 3.14+ interpreter explicitly. From a fresh fork/checkout:

```sh
AI_PYTHON=/absolute/path/to/python3.14
make install-locked AI_PYTHON="$AI_PYTHON"
make app-install
make web-install
"$AI_PYTHON" app/scripts/export-contracts.py --check
"$AI_PYTHON" app/scripts/check-fixtures.py
(cd server && PYTHONPATH=src "$AI_PYTHON" scripts/evaluate.py --validate-only)
(cd server && PYTHONPATH=src "$AI_PYTHON" -m pytest tests/test_evaluation.py)
(cd web && ./node_modules/.bin/playwright install chromium --only-shell)
make web-check
```

For app UI changes run the existing UI/browser gates and Android checks when applicable; for fixture/service changes run `make verify AI_PYTHON="$AI_PYTHON"` before requesting review. Setting the selected interpreter avoids accidentally using a shell's older `python`. Evaluation tests use paths relative to `server/`, so run them there; running them from root fails to locate `evals/cases.json`. Neither setup nor focused checks need a model key, a provider configuration or a running AI service. Web browser tests start their own loopback Vite frontend and substitute the task APIs. Use independently installed locked dependencies, including the local Playwright executable above, rather than another checkout's `node_modules`.

All commands above passed on their first attempt in the same isolated checkout: full `make install-locked`, independent app/Web `npm ci`, generated-contract parity, shared fixtures, 30 evaluation cases, 83 focused pytest checks, Web TypeScript/lint, 41 Web unit tests and 9 browser tests. No setup failure required a repair or rerun. The 86 applicable locked Python dependency versions already matched; the install command still ran and temporarily rebound the existing editable service package. Its original source pointer was restored afterward, all global distribution versions stayed unchanged, all tracked source bytes stayed unchanged and no project `.venv` was created. No model environment file contents or provider key were read, no AI service was started and no real model was called.

These results apply to the identified 30-case candidate; they do not claim the separately merged CSV fixture was tested in that rehearsal. Full service verification and native package/platform checks remain separate engineering evidence under their own issues. Report a concrete command/platform/error if these steps fail on a new machine; never include keys or personal paths in public logs.

## Responsibilities and current ownership

Use [CONTRIBUTING](../CONTRIBUTING.md), [SECURITY.md](../SECURITY.md) and the [release policy](releases.md) for the responsibilities below. `shenyankm` is the repository owner. This PR creates no new repository role or access grant. Contributor, reviewer, signing/release operator and backup maintainer assignments remain opt-in and require explicit agreement; no backup maintainer is recorded here. Do not infer a person has accepted a role from a task listing or commit identity.

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
- [x] Reproduce focused setup on an isolated checkout; the documented commands passed in the maintainer rehearsal above with reused runtimes.
- [ ] Review service recovery, local storage, native file authorization, credential isolation and explicit model-action boundaries in AGENTS.md.
- [ ] Walk through one actual issue triage and PR review, retaining links and outcomes.
- [ ] Walk through the release policy and signing evidence without sharing credentials; publication remains separately authorized.
- [ ] Verify permission changes and credential handover through approved stores, then record only nonsecret access status.
- [ ] Link an accepted external contribution and completed upstream review outcome; distinguish the offered PNG fixture from acceptance.

The first five #93 outcomes are recorded above: three bounded contribution listings with suitable labels, executable isolated-checkout setup, responsibility/access guidance, and a handover checklist with honest ownership. Checklist items remain available for a future agreed handover; no backup maintainer is assigned. The sixth outcome still needs the accepted upstream PNG contribution and linked review outcome after #136 actually merges. Keep #93 open for that record. The existing public review state is COMMENTED, not APPROVED; preserve its actual state and the final check/review evidence when recording acceptance. Do not claim community growth or another person's setup experience from these listings or this maintainer rehearsal.
