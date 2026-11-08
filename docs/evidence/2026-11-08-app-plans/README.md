# App plans and transactional entitlements — 2026-11-08

Source: working-tree changes on `feat/app-plans-and-entitlements`, based on
`3a5ceb788dbe07a2c780c8534807a53279abe1c2`. This is implementation evidence,
not a production deployment or published release.

## Delivered behavior

- Server catalog: Free 50 lifetime pages, Plus CNY 39/100 pages/30 days,
  Pro CNY 99/300 pages/30 days, CNY 19.90/50-page/365-day add-on.
- App → Cloud service → 套餐与额度 shows current plan, expiry, available/free
  balances, comparison, add-on, allocation ledger and charging/refund rules.
  Orders retain explicit query/resume/close actions and recovery across remounts,
  origin/account/environment changes and lost responses. Connecting settings are
  collapsed after connection to leave room for the active customer task.
- Schema 8 stores immutable order product snapshots, verified closure fences,
  separate expiring grants and per-call allocations. Only verified production
  settlement grants once. Sandbox/legacy orders do not issue production rights.
- Earliest-expiring paid pages precede lifetime free pages; known terminal counts
  release excess original allocations; unknown calls retain reservations. Account
  task limits follow Free/Plus/Pro 1/2/3 unless explicitly overridden by an admin.
- Bounded Pro scheduling head start and worker-slot-limited outbox publication
  preserve older standard work. Existing provider budgets remain in force.
- Unused full-order refunds freeze grants before sending, retain uncertainty and
  revoke on verified success. Verified provider closure also revokes/fences rights,
  including when closure precedes a late payment notification. Product selection
  and fulfillment metadata cannot be supplied/tampered with by clients.
- Offline practice, local bank import/export, schema-11 data and native credential
  namespaces remain independent of plans. No recurring billing or annual plan.

## Validation

| Check | Environment and result |
| --- | --- |
| Focused accounts/payment/messaging/personal-deployment regression run | Python 3.14.7, disposable PostgreSQL/RabbitMQ and provider substitutes: 160 passed before the additional closure cases. |
| Payment/queue/pipeline/upgrade joint regression | Python 3.14.7, disposable PostgreSQL/RabbitMQ and substitutes: 138 passed, including single-slot dead-letter recovery and existing full-batch draining. |
| Final payment/entitlement security suite | Python 3.14.7, real SDK signing with ephemeral test keys, substituted gateway: 40 passed. |
| App `npm run check:ui` | Types/lint/coverage passed: 571 passed, 6 skipped. |
| Web `npm run check` | Types/lint/coverage passed: 322 passed, 1 skipped. |
| Full `make app-check AI_PYTHON=.../python3.14` at submission | Passed: contract/fixture checks, 571 UI tests (6 skipped), 294 host Rust tests (27 ignored), formatting and all-target Clippy. |
| Native cloud tests | Host macOS, temporary/mocked credential state: 17 passed. |
| Rust formatting and all-target Clippy | Passed, warnings denied. |
| App native cloud browser workflow | Chromium at 1440×1040 with typed native-command substitutes: passed. Explicit purchase passes the SKU, original-order query updates balance, and light/dark UI plus the ledger were inspected. No external HTTP or page errors. |
| Frontend production builds | App and administrator Web passed. |
| `make app-build` | Built native macOS Apple Silicon App and DMG; installer inspected without installation or execution. [Package report](installer-check.json) confirms no embedded AI engines. |
| Generated contract parity and diff whitespace | Passed. |
| Final full `make verify AI_PYTHON=.../python3.14` | Passed: 3,947 tests, 7 warnings, 92% combined coverage; lock parity, Ruff, Pyright, 30 evaluation fixtures, all recovery probe gates, wheel/sdist build and archive/license validation. [Probe report](probes.json). |

Initial checks caught stale free-only copy assertions and a missing native error
translation; these were fixed. An overly broad screenshot-animation wait timed
out; the final browser check waits for the existing theme-transition completion
signal instead. An earlier full service run was intentionally superseded before
completion to add verified provider-closure handling; its interrupted report is
not counted as a pass. Another completed full run had 3,942 passes and two
failures in old queue test adapters (fixed SQL-substring observation and a fake
publisher without the new capacity metadata). These adapters were updated while
retaining their no-replay/full-batch assertions. Passive queue probes are now
modeled explicitly; a real single-slot broker regression confirms retained dead
letters do not block healthy work. The subsequent 138-case joint run passed;
the final fresh full run below is the delivery gate.

## Browser evidence

The screenshots contain synthetic account, order and entitlement data from the
native IPC substitute, not a real payment or deployed native session.

- [Free, light theme](plans-free-light.png)
- [Plus after substituted settlement, dark theme](plans-plus-dark.png)
- [Paid/free ledger and rules, dark theme](plans-ledger-dark.png)

## Rollout and acceptance limits

Payments remain disabled by default. No merchant settings, existing database,
user storage, deployed service or account credentials were changed. Existing
services require a verified stopped-writer database/storage/configuration backup
and explicit schema-7-to-8 upgrade; the upgrade preserves old calls, users and
orders without inventing products or resetting free usage. The old default task
limit 2 becomes Free default 1; per-user overrides are retained. Practice schema
11 and backups are unchanged. See [plans](../../guides/plans.md).

Real buyer payment/refund, production activation, native Keychain prompts and
system dialogs, clean-machine installation, human recognition/grading quality,
and actual per-page costs were not accepted here. The built installer retains
version 0.2.2 for local validation; it was not published or notarized as a release.
