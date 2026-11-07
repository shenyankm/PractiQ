# Native customer portal acceptance — November 7, 2026

The macOS App now owns customer registration/login/reset, account security,
cloud upload/task/result/correction workflows, saved bank downloads, usage and
existing payment receipts. Recognition, normalization/splitting, parsing, models,
accounting and authoritative results remain on the existing cloud service.
The production Web entry is administration-only. The payment return callback
remains a minimal backend response, without treating return parameters as proof.

No service or practice database migration, provider/payment configuration change,
new dependency or legacy credential reinterpretation is part of this change.
Offline practice, local ZIP import and direct model grading remain independent.
New accounts keep their existing lifetime 50-page recognition allowance.

## Local verification

| Check | Result |
| --- | --- |
| `make verify` with Python 3.14.7 | 3,923 tests passed; 92% service coverage; Ruff, Pyright, evaluation fixtures, recovery probes and wheel/sdist checks passed. |
| `VITEST_MAX_WORKERS=2 npm --prefix app run check:ui` | Types and hooks lint passed; 563 tests passed, 6 skipped. Coverage: 89.09% statements, 92.92% lines. |
| `npm --prefix web run check` | Types and hooks lint passed; 321 tests passed, 1 skipped. Coverage includes migrated shared code: 82.17% statements, 88.40% lines. |
| Native Rust tests on macOS, two test threads | 291 passed, 27 existing opt-in/stress/subprocess cases ignored by default. |
| Rust formatting and Clippy for all targets | Passed with warnings denied. |
| Generated shared contracts and service/App fixtures | Passed. Payment wire types use the existing Python exporter; question-bank contract versions are unchanged. |
| App and Web production frontend builds | Passed. Web emits administration and shared result-inspection chunks, without customer workspace/registration/payment entry chunks. |
| Administrator Web browser suite | 3 passed using synthetic account/API responses. |
| App cloud/native IPC, migrated workspace and learning browser recheck | 80 passed. Includes explicit upload admission, task recovery, result review, corrections, desktop layout, native IPC substitutes and learning regressions. |
| Browser checks after native confirmation correction | 3 passed: App account/upload/result/usage/logout flow and correction-switch/unknown-save recovery. |
| Production desktop navigation | All three app languages passed with mocked native commands. |

The initial 230-case App browser run reported 227 passes and three failures:
skip-link focus and two navigation interruptions while iterating with Vite.
The skip-link focus handoff was restored, and all three failing paths were
included in the subsequent clean 80-case recheck. The remaining 150 scenarios
passed in the initial run. This is combined coverage across runs, not a claim of
a new uninterrupted 230/230 run after the last change. An earlier concurrent App
check was interrupted with exit 137; its complete isolated rerun passed.

## Security and data boundaries exercised

Native tests cover canonical HTTPS/loopback origins, origin-scoped credentials,
anonymous CSRF credentials kept in memory, session secrets excluded from public
responses, stale reply/session generation fencing, cookie/CSRF transport without
redirect or POST replay, unsafe native paths, unsupported CSV inputs, source
modification after selection, upload URL/reference checks, bounded ZIP validation,
restricted payment form reconstruction and account configuration excluded from
practice backups. Existing backend ownership, role, session and CSRF tests passed.

Tauri's dialog plugin replaces `window.confirm` with an asynchronous function.
The native correction editor now requires explicit Save/Discard before leaving;
it does not interpret a Promise as consent. Recovered draft deletion awaits a
bounded, session-fenced native confirmation. Regression tests preserve the draft
on Cancel and remove it only after an explicit positive result.

## Limits

No real Tencent/model request, buyer payment or merchant activation was performed.
Native credentials used mock Keychain entries in tests. Browser native commands
were IPC substitutes; real macOS Keychain prompts, file pickers, save/confirmation
dialogs and the complete native-to-deployed-service flow still need human/native
acceptance. No new signed/notarized installer or remote CI/PR result is claimed.
Email remains an unverified login identifier with administrator-issued reset
codes. Payment remains disabled until separately configured and does not refill
page allowances. See the [cloud workflow](../../guides/cloud-service.md) for rollout
and recovery, including preservation of old browser-local drafts.
