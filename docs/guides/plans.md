# Plans and page allowances

The App's **Account → 套餐与额度** page displays the server-owned catalog,
current plan, expiry, free balance, purchased grants and usage. **订单与付款**
keeps payment/refund receipts and explicit recovery actions. Web remains admin-only.

| Product | CNY price | Recognition pages | Validity | Active tasks |
| --- | ---: | ---: | --- | ---: |
| Free | 0 | 50 once at registration | Lifetime unused balance | 1 |
| Plus | 39 | 100 | 30 days | 2 |
| Pro | 99 | 300 | 30 days | 3 |
| 50-page add-on | 19.90 | 50 | 365 days | Current plan unchanged |

There is no automatic renewal, annual plan, points system or lifetime paid tier.
Buying a plan is explicit; a still-active plan cannot be bought again or switched
mid-term in this first version. Use add-ons for extra pages, then choose another
plan after expiry. Each confirmed purchase grants one period beginning at the
first verified server settlement. Add-ons do not extend plans or upgrade priority.
Per-user administrator concurrency overrides take precedence; the deployment's
worker and provider concurrency bounds still apply.

All tiers retain offline practice, local banks/ZIP import/export, exams, mistakes,
statistics, backups and direct grading with the user's own API key. Cloud formats,
recognition models, review and ZIP export do not differ by plan. Page allowances
cover recognition and structuring of questions and supplied answers/analysis.
The catalog does not promise hosted grading or unlimited generated answers.
Existing optional generation stays explicit and constrained by model budgets;
provider costs and independent quality acceptance remain separate.

## Charging and recovery

The authoritative catalog is `billing.PRODUCTS`, exposed by authenticated
`GET /api/me/plans` and generated into client contracts. A purchase submits only a
UUID and `productId` (`plus`, `pro`, `pages50`). Price, pages, term and subject are
server-owned; each order retains an immutable version-1 product snapshot. Changing
a request's SKU conflicts. The native checkout passes this SKU, retains the
account/origin/environment-scoped recovery request and opens the existing Alipay
web cashier. An unknown creation blocks another SKU until the original is resolved.

Payment remains off by default. Catalog and history can be read while checkout is
disabled. Sandbox uses the configured test amount and never grants production pages.
Only verified production queries or signed notifications can atomically mark an
order paid and insert its unique grant. Repeated notices, queries and restarts do
not grant twice or move expiry. Browser returns are never evidence of payment.
Legacy orders without product snapshots are preserved and never adopted as plans.
Verified `TRADE_CLOSED` query/notification results persist a closure fence and revoke
any existing grant. Late payment notifications cannot recreate or reactivate it,
including when closure arrived before the first payment confirmation. Historical
paid receipts remain preserved; the App separately displays provider closure.
This follows [Alipay's documented trade states](https://developer.alibaba.com/docs/doc.htm?articleId=106448&docType=1&treeId=204);
only validated provider responses can set the fence, never a browser return.

Paid grants are consumed by earliest expiry, followed by lifetime free pages.
A grant's outstanding consumption is linked to original durable call receipts.
Unknown calls retain reservations; a known lower page count releases unused
reservations back to the original grants (expired grants stay expired). Positive
proof of non-submission releases the reservation. Saved receipt replay, passive
view/review/export and login spend no pages and start no model work. New explicit
recognition attempts consume pages. Deleting tasks does not erase accounting.
PDF pages and submitted images/tiles count as recognition pages. Unknown-pagination
sources use the existing bounded Tencent page limit; UI result selection does not
reduce recognition submissions. Daily model/provider safety budgets still apply.

Pro receives a bounded two-minute scheduling head start for unpublished work.
The publisher uses live broker-ready counts and active executions to fill available
worker slots instead of flooding the broker. Retained dead-letter receipts do not
consume dispatch capacity or trigger automatic replay.
Older standard work therefore eventually outranks new Pro work; already running
or delivered work is not preempted. This promises no completion deadline and does
not increase Tencent or model provider capacity.

## Expiry and refund

Purchased balances do not roll over. Free allowance is neither reset nor re-granted.
Expiry affects future admissions only; already reserved calls retain accounting.
Existing cloud results retain their original 180-day expiry on every tier; downloaded
banks and local practice data remain available independently of account/plan status.

For these first catalog products, administrator refunds are full-order only and
require zero consumed/reserved grant pages. Full order means the verified buyer-paid
amount, which can differ from the order total when provider discounts apply.
Partial/used-plan refunds are rejected before refund submission. A durable refund intent
freezes that grant in the same transaction before the request; an uncertain refund
stays frozen and cannot be replayed. A verified refund result revokes it. Existing
legacy receipt refunds keep their previous amount/reservation rules. No refund
operation deletes local banks or practice records. Provider fees, statutory rights
and production refund wording need operator review before collecting real money.
Platform faults can be compensated through existing audited administrator allowance
adjustments after inspecting the original receipts.

## Deployment and rollback

Service schema **8** adds `payment_orders.product`, `payment_orders.provider_closed`, `page_grants` and
`page_allocations`. Stop writers; take and verify a matching complete database,
storage, private configuration and executable backup; then use the existing offline
`make upgrade-db ... UPGRADE_BACKUP=...`. Startup rejects older schemas and never
migrates them. No database is upgraded by changing source code. Schema 7 orders,
accounts, ownership and call receipts stay intact; historical calls continue to
count against the original free allowance. No data is assigned to another user.
The old global default active-task limit 2 becomes Free default 1; explicit
per-user overrides and other custom defaults are preserved. Restore/rollback uses
the complete matching backup and previous executable, never table deletion or a
manual schema-marker change. Practice SQLite schema 11 and backups are unchanged.

Keep `ALIPAY_ENABLED` disabled until the operator finishes production configuration,
real buyer payment/refund acceptance, accounting and customer-facing terms. Existing
`ALIPAY_AMOUNT`/`ALIPAY_SUBJECT` remain for legacy receipts and sandbox testing;
production catalog prices come exclusively from immutable product snapshots.
