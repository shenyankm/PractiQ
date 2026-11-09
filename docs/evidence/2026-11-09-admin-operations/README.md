# Administrator support and operations acceptance — 2026-11-09

Working branch `feat/admin-operations`, based on `75c43b6d`; the final PR head
identifies the submitted source. Implements [#529](https://github.com/shenyankm/PractiQ/issues/529).
This is local engineering evidence, not a production deployment or real-payment
acceptance. Screenshots use only synthetic accounts, calls and balances.

## Delivered workflow

- Search accounts, inspect free/paid/held balances and follow account-scoped links.
- Preview a reasoned total allowance adjustment; server checks the expected old
  total and preserves provider receipts. General policy edits cannot bypass the
  reason check. New audits retain before/after values.
- Search tasks/payments/calls/audits with bounded account, time and state filters.
  Worklists include exhausted accounts, quota blocks, unknown calls, long-running
  work and unsettled refunds. Historical API-path audits remain associated with
  their account-owned task/order.
- Inspect aggregate known/unknown usage separately; per-day/user/provider groups
  and original receipts retain independent pagination and association links.
- Inspect/revoke individual sessions, all sessions or grading tokens with password,
  reason, account-scoped targets and confirmation. Metadata never returns raw
  credentials or session digests. DELETE mutation bodies use the existing bound.
- Read service/queue/storage/budget state. Optional bounded regular-file monitoring
  evidence distinguishes missing, invalid and stale observations. External backup
  age and actual alert-delivery verification are never inferred from service health.

## Verification boundaries

`test_admin_operations.py` exercises the actual FastAPI authorization/CSRF stack
and disposable PostgreSQL, including transactional allowance conflict/audit,
retained unknown pages, immediate credential invalidation, foreign-target denial,
SQL search boundaries, namespace-bound Tencent receipt status, anomaly selection,
related historical audits, passive operations and safe monitoring-file reads.
It does not invoke a model, Tencent, Alipay, a production service or native UI.

Web component tests cover explicit filter submission, allowance preview/conflict,
password clearing, cancellation before session revocation, account/task links,
usage totals, audit differences and absent monitoring evidence. Existing refund
unknown-result/reload tests remain in place. Web browser checks use substituted
HTTP responses, not the PostgreSQL backend. They exercise the real React views,
explicit allowance submission and linked account usage, plus 1440/1024/800 layouts,
light/dark themes, steady navigation colors and absence of document overflow.
The graphical evidence is separate from backend integration evidence.

- [User detail, light](user-detail-light.png)
- [Operations, light](operations-light.png)
- [Operations, dark](operations-dark.png)

The Impeccable mechanical detector returned no findings. Rendered inspection found
and repaired dark navigation contrast and reduced-motion behavior. The selected
navigation color is asserted after theme transitions, so intermediate animation
frames are not mistaken for the final theme.

No production backup/alert feed was connected. The [administration guide](../../guides/administration.md)
documents the required operator-owned status file, real timestamp provenance and
read-only container mount. No production backup, restoration, alert delivery,
provider call, merchant operation, deployment or release was performed.

Final command outcomes are retained in [checks.json](checks.json). Initial lint/type
and outdated frontend-fixture failures were corrected. A full service run was
interrupted after the final historical-audit association repair; that interrupted
run is not counted as passing. The final complete service run is recorded separately.
