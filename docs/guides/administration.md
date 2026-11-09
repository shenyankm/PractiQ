# Administration and support

The administrator Web operates the existing service. Customers use the macOS App;
local practice remains independent. All administration APIs require a live enabled
administrator session. Mutations require CSRF; allowance and credential recovery
also require the administrator's current password. No inspection starts models,
recognition, payment, refund, backup or restore.

## Find an account and explain its balance

Use **用户** to search email, nickname or exact account ID, filter role/status/time,
or find accounts whose free and paid recognition balances are exhausted. Searches
are literal substrings, not SQL wildcards. Times are explicit UTC; the end is
exclusive. Pagination retains filters. Choose an account to inspect:

- Its effective plan, expiry, free total, free used-or-reserved and all available pages.
- Successful recognition pages, retained/unsettled pages and the unknown subset.
  A failed/unknown recognition receipt is not a refund. Historical calls without
  page metadata are preserved without inventing page counts.
- Individual paid grants, including expired, frozen and refunded grants.
- Effective daily safety limits, task concurrency and live credential counts.
- Links to that account's tasks, payments, usage and associated audit events.
  Account audit includes actions performed by/on the account and events targeting
  its tasks, orders and grading receipts; global events remain in the global view.

**调整免费总额度** sets a total including used/reserved pages. It does not erase
receipts, release unknown reservations, issue paid grants or resume tasks. The UI
previews the new free and total available balance. The request requires the old
total and a nonblank reason. A concurrent adjustment returns `ALLOWANCE_CHANGED`;
refresh and reassess before another explicit attempt. General policy edits also
check the UI's expected allowance and require a reason when changing the effective
free total. Older administrative API callers changing that total must supply
`reason`. Audit records retain before/after values; old audit rows remain readable.

## Investigate exceptions

**运行状态** links to exhausted accounts, quota/budget-blocked tasks, uncertain
calls, tasks waiting/running for over 30 minutes, and unresolved refunds/frozen
entitlements. The 30-minute view is a diagnostic age threshold, not proof of a
failed task. Active calls remain pending rather than being labelled unknown merely
because they have no answer yet. Missing task artifacts remain visible in the
blocked worklist. Opening a task retains diagnostics even if result preview fails.

Task search accepts account/email, filename/exact task ID, creation time and task
state. The checkpoint remains authoritative for state and recovery actions.
Explicit pause/resume/retry uses the existing controls and charge confirmation;
unknown provider submissions are never automatically replayed. Historical unowned
records remain administrator-inspectable and cannot be adopted or resumed by users.

**订单与退款** filters account/email, ID/name, time, state, sandbox/production and
uncertain refunds. A grant links back to its original order. Existing current-password
refund confirmation, retained request IDs, full-unused-plan restrictions and signed
provider reconciliation remain unchanged. Filtering is passive. Real merchant/buyer
acceptance and the fixed product catalog remain separate.

## Understand usage and audit

**提供商用量** filters user, provider/model, call kind, time and outcome. Totals
cover all matching records, not just the current page. Groups by the ledger's
Singapore day, user and provider/model have their own pagination. Displayed tokens
are known values; incomplete token receipts have a separate count and do not imply
zero cost. Recognition page totals include held reservations. Tencent terminal
status is read from the matching task namespace and provider task ID only; source
hash coincidence or another account's receipt cannot establish an outcome.

**审计** filters operator, action, object, account association and time. New policy
and allowance events show before/after values and reason; historical details remain
available. Read and administrative access events are retained. Never paste reset
codes, passwords, tokens, provider responses containing secrets or personal source
materials into audit reasons.

## Revoke credentials without changing policy

In a user's detail, open **管理该用户会话与令牌**. Lists show only metadata and derived
revoke identifiers, never raw tokens/session digests. Revoke a single session,
all login sessions, or a grading token with current password, reason and explicit
confirmation. Targets are bound to the selected account. Revoking login sessions
does not revoke grading tokens; revoke those separately when required. Account
policy changes retain their existing all-credential revocation behavior. A lost
response is not automatically replayed: reread the original list before deciding
whether another explicit action is needed. Revoking your own session returns you
to login on the next authenticated read.

## Read service and external monitoring state

**运行状态** shows code/schema identity, maintenance/read-only/admission state,
publisher/consumer connectivity, pending/running counts, unpublished outbox age,
capacity, storage probe, model identity and conservative cost reservations. No keys,
database/broker URLs, storage paths or provider configuration secrets are returned.
This is a diagnostic snapshot, not a signed production-readiness certificate.

Backup/alert evidence comes from an optional operator-owned absolute
`AI_OPERATIONS_STATUS_FILE`. Without it the UI says **未接入外部状态**. It never
infers successful backups or alert delivery from the service being up. The service
reads at most 16 KiB, rejects symlinks/non-regular files, invalid/extra fields,
unknown versions and invalid timestamps, and marks observations older than 15
minutes stale. Backup age is displayed separately from snapshot freshness.

Supply a strictly versioned JSON file from the actual monitoring/backup process:

```json
{
  "version": 1,
  "observedAt": "2026-11-09T03:00:00Z",
  "backupLastSuccessAt": null,
  "backupLastAttemptSuccess": null,
  "alertState": "unknown",
  "alertDeliveryVerifiedAt": null
}
```

This is a format example, not a successful observation. Set `observedAt` to the
actual collection time. Read backup time/attempt from the existing backup exporter's
`practiq_backup_last_success_timestamp_seconds` and
`practiq_backup_last_attempt_success`; never replace an old successful timestamp
with the collection time. `alertState` is `unknown`, `healthy` or `firing` from the
real monitoring system. Record `alertDeliveryVerifiedAt` only after an actual
receiver delivery drill. Missing evidence stays null/unknown. Do not embed secrets,
paths, URLs or customer content. Write a temporary regular file then atomically
rename, with operator-only write access. Mount its parent directory read-only into
the service, for example `/srv/practiq-operations:/run/practiq-operations:ro`, and set
`AI_OPERATIONS_STATUS_FILE=/run/practiq-operations/status.json`. A parent-directory
mount lets atomic replacements become visible. Do not expose a browser file path
or a user-configurable monitoring destination.

The API surface is additive: `/api/admin/users/{id}`, its `/allowance`, `/sessions`
and `/tokens` controls, `/api/admin/task-search`, `/api/admin/calls`,
`/api/admin/usage/summary` and `/api/admin/operations`. Existing administrative
list routes retain their array response shapes and accept generated
`AdministrationFilter` query fields. Responses remain generated from Python
contracts. There is no schema migration, new parser, dependency or practice data
change. Parser-source changes still require draining old unfinished checkpoints
on their matching executable; do not rewrite execution signatures.
