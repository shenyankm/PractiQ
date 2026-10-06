# Contributor entry point and maintenance handover

Tracks [#93](https://github.com/shenyankm/PractiQ/issues/93). The CSV, PDF and PNG starter tasks below are complete; #93 remains open for actual new-contributor setup verification. See the [dated roadmap status](roadmap-evidence.md) for outstanding workstreams.

On 2026-10-04 a maintainer rehearsed focused setup in an isolated checkout of `8cdc570e17657250a6a4e82f1049e359e3104e80`, the subsequently merged [#133 Android candidate](https://github.com/shenyankm/PractiQ/pull/133). Existing macOS arm64 runtimes were reused: Python 3.14.7, Node 22.23.2, npm 10.9.8 and uv 0.12.13. This verifies that candidate's documented commands with reused runtimes, not a clean-machine test or another person's participation.

The rehearsed candidate targets macOS, Windows and Android and removes Linux app packaging; Linux remains a service/CI host. Follow the [Android guide](../app/docs/android.md) for SDK, APK and emulator checks. This rehearsal exercised no Rust/native package, Android SDK/device, Windows native or Linux service-host checks.

## Review bounded fixture contributions

The three initial tasks addressed actual gaps for wholly answerless CSV, PDF and standalone PNG sources; answerless TXT sources already existed. They use original synthetic content and offline scorer tests and require neither paid model access nor release credentials. Each issue contains affected files, exact validation commands and independently source-checked null-answer acceptance criteria. The table includes the later October 4 merge/closure observation; completed tasks are examples, not available assignments.

| Contribution issue | Input / scope | Validation | Observed status |
| --- | --- | --- | --- |
| [#112: answerless CSV](https://github.com/shenyankm/PractiQ/issues/112) | One original two-question CSV + gold manifest + scorer regression | Validate manifest; focused evaluation tests; full service verify | Completed: [#134](https://github.com/shenyankm/PractiQ/pull/134) merged; issue closed |
| [#113: answerless PDF](https://github.com/shenyankm/PractiQ/issues/113) | One original two-question PDF + reproducible source + gold/scorer regression | Same offline checks; visually inspect printed questions and absence of answers | Completed: [#135](https://github.com/shenyankm/PractiQ/pull/135) merged; issue closed |
| [#114: answerless PNG](https://github.com/shenyankm/PractiQ/issues/114) | One original two-question image + original-source provenance/generation note + gold/scorer regression | Same offline checks; inspect rendered source and explicit nulls | Completed: [#136](https://github.com/shenyankm/PractiQ/pull/136) merged; issue closed |

The initial listings used `good first issue` / `help wanted` for these bounded tasks. A label is an invitation, not an assignment or evidence of a completed contribution. Completed rows are examples, and an open issue with an active PR needs coordination before duplicating its work; do not recreate listings solely to maintain a count. Broad release, live-model quality and user recruitment work is not beginner work.

Cid-oe publicly offered a PNG fixture in [the #114 source comment](https://github.com/shenyankm/PractiQ/issues/114#issuecomment-5976045114). [The original fork commit](https://github.com/Cid-oe/PractiQ/commit/7f2974618279e3fd0b27301f126a1a19206c4aac) records Siddharth U as its author; upstream [#136](https://github.com/shenyankm/PractiQ/pull/136) preserves that attribution. This records an actual offered external contribution and its upstream review, with its later upstream acceptance recorded below, without claiming another person's onboarding experience or an agreed maintainer role.

The [first public P2 review finding](https://github.com/shenyankm/PractiQ/pull/136#discussion_r4176918805) identified unchecked absent grading evidence. [Repair `129bd83`](https://github.com/shenyankm/PractiQ/commit/129bd83feb6819338be9a3dcb9ea6266c4d86de5) records all four evidence fields as null for both image questions and tests hallucinated evidence as a critical failure. The [second public P2 finding](https://github.com/shenyankm/PractiQ/pull/136#discussion_r4177014721) required source-byte binding; [repair `e27c67a`](https://github.com/shenyankm/PractiQ/commit/e27c67a4695e57639880a04a5f69742cd7a69112) pins the PNG checksum and 600×400 dimensions. Both review threads were resolved at the 10:21 UTC observation.

At the earlier 10:21 UTC observation, #136 was still awaiting package/emulator jobs and CodeRabbit; the public Codex reviews were COMMENTED, not APPROVED. Later on 2026-10-04, [#138](https://github.com/shenyankm/PractiQ/pull/138) merged at 10:27:41 UTC, [#136](https://github.com/shenyankm/PractiQ/pull/136) merged at 10:32:59 UTC, and [#114](https://github.com/shenyankm/PractiQ/issues/114) closed at 10:33:01 UTC. The original head/check observations are historical; the merge records upstream acceptance, not contributor setup or user-trial evidence.

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

Use [CONTRIBUTING](../CONTRIBUTING.md), [SECURITY.md](../SECURITY.md) and the [release policy](releases.md) for the responsibilities below. `shenyankm` is the repository owner. This guide creates no repository role or access grant. Contributor, reviewer, signing/release operator and backup maintainer assignments remain opt-in and require explicit agreement; no backup maintainer is recorded here. Do not infer a person has accepted a role from a task listing or commit identity.

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
- [x] Record actual issue triage and PR review; #114/#136 links, findings, repairs and observed outcomes are retained above.
- [ ] Walk through the release policy and signing evidence without sharing credentials; publication remains separately authorized.
- [ ] Verify permission changes and credential handover through approved stores, then record only nonsecret access status.
- [x] Track the actual offered external contribution and public review outcomes with links; the historical 10:21 status and later #136 merge / #114 closure are recorded above.

Five of the six #93 outcomes are recorded: (1) three bounded contribution issues with input/scope/acceptance/check guidance; (2) suitable initial good first issue/help wanted labels; (4) triage/review/release responsibilities and access boundaries; (5) a handover checklist with opt-in ownership and the backup maintainer role explicitly vacant; and (6) linked external contribution/review findings, repairs and observed outcomes. Criterion 3 remains pending an actual consenting new contributor following the existing setup and focused checks from an isolated checkout, with concrete blockers and fixes recorded. The maintainer rehearsal and its checked checklist item document only that execution; they do not verify a new contributor's experience. Keep #93 open until this original criterion is verified; the rehearsal does not close it. The sixth requirement is tracking actual outcomes, without adding a merge or APPROVED-review requirement. Future role appointments, release/signing walkthroughs and credential handover remain unchecked until separately agreed and verified; the vacant backup role creates no additional completion condition. Do not claim community growth or another person's setup experience from the listings or maintainer rehearsal.
