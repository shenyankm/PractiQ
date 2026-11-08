# Alipay web payments

The service has an optional Alipay `alipay.trade.page.pay` integration. It records
account-owned receipts and supports query, close, administrator refund, refund
query and signed asynchronous notifications. Verified production catalog orders issue page grants exactly once; legacy orders
without a product and all sandbox orders issue none. Offline practice requires no login. The App opens this existing web checkout in the system browser; there is no native payment SDK. The fixed catalog and fulfillment/refund policy are documented in [plans](../../docs/guides/plans.md).
Complete merchant activation and real-buyer acceptance before enabling production.

Payments are disabled unless `ALIPAY_ENABLED=true`. No existing database,
credential, historical payment table or page allowance is changed by installing
the code. The new `payment_*` tables are separate from historical archives.

## Database rollout

New installations use service schema 8. For an existing schema-6/7 installation,
stop the service, retain a verified matching **database and storage backup** with
the original deployment image, then run the existing offline upgrade command:

```sh
make upgrade-db UPGRADE_BACKUP=/absolute/path/to/verified/bundle
```

The upgrade adds payment tables to schema 6, then adds the nullable order-product
snapshot plus grant/allocation tables to schema 6/7. It preserves accounts, sessions,
ownership, task receipts, historical payments and page usage; no old order grants pages.
The old default task concurrency 2 becomes Free concurrency 1; per-user overrides remain.
Schemas 1–5 keep their existing ownership/archive checks before the additive
upgrade. Startup never upgrades a database. Rollback requires the original
executable and the entire matching pre-upgrade database/storage backup. Do not
drop payment evidence or edit schema markers to downgrade. Backup/restore uses
the existing complete PostgreSQL dump and storage bundle, including payment
receipts and unknown refunds. Payment keys are protected configuration, backed
up separately using the operator's secret-management procedure.

## Sandbox

The server reads `server/.alipay-sandbox.json` directly, anchored to the server
package root rather than the current working directory. Keep the file untracked,
with the exact `/.alipay-sandbox.json` rule in `server/.gitignore`, and mode `0600`.
It maps the first application's `appId`, `pid`, `appPrivatePkcsKey` (the original
PKCS#1 value) and `alipayPublicKey` to the official Python SDK. No key is copied to
source code, the frontend, a second `.env` file or payment receipts. SDK logging
is disabled; never enable request/response debug logging around payment calls.

With an initialized/explicitly upgraded database, RabbitMQ, a bootstrapped
administrator and a logged-in account, start the existing loopback service:

```sh
ALIPAY_ENABLED=true ALIPAY_MODE=sandbox \
ALIPAY_BASE_URL=http://127.0.0.1:8090 make server-dev
```

Connect `http://127.0.0.1:8090` in App → Account, sign in, and open Orders and payments. The sandbox default amount is ¥0.01; sandbox catalog orders issue no real grants. The
subject is explicitly labeled as sandbox. Selecting “前往支付宝付款” creates one
durable order before rendering and posting the SDK form to the sandbox gateway.
The result page is exactly `http://127.0.0.1:8090/payments/return`; changing the
service port requires changing `ALIPAY_BASE_URL` to the same actual origin.

Pay either by logging into the sandbox cashier with the sandbox buyer's login
and payment passwords, or on Android by scanning the cashier QR code using the
official sandbox Alipay client logged into the sandbox buyer account. These are
alternative buyer experiences; opening the cashier alone does not prove payment.
After returning, query the original order. Only signed SDK query responses or
verified notifications can mark it paid. The page never accepts browser return
parameters as proof. No order identifier can grant another user's access.

## Production configuration

Use the same code with explicit production configuration; there is no unsigned,
mock-success or automatic transport fallback. The integration does not perform
production transactions during development or tests.

| Variable | Requirement |
| --- | --- |
| `ALIPAY_ENABLED` | Exact `true` enables payment operations and reconciliation. |
| `ALIPAY_MODE` | `sandbox` (default) or explicit `production`. |
| `ALIPAY_BASE_URL` | Exact deployed origin, no path/query/credentials. Production requires HTTPS. |
| `ALIPAY_PRODUCTION_CONFIG` | Absolute protected JSON file, mode `0600`, with the same first-application field structure; never reuse sandbox application values. |
| `ALIPAY_AMOUNT` | Legacy receipt/sandbox test amount, 0.01 through 100000000; production has no default. Production catalog orders use their immutable catalog price instead. |
| `ALIPAY_SUBJECT` | Server-owned order subject, 1–128 characters; production has no default. |
| `ALIPAY_NOTIFY_URL` | Optional exact `ALIPAY_BASE_URL` + `/payments/notify`, HTTPS only. Omit it when not deployed. |

Production app ID, seller PID, original PKCS#1 private key and Alipay public key
must belong to the same production application. Convert formats only with
Alipay's official key tool. Use a trusted HTTPS proxy to the loopback server;
never expose PostgreSQL, RabbitMQ or worker endpoints. Configure accurate trusted
proxy headers and ensure proxy/access logs exclude notification bodies, keys,
signed payment forms and sensitive parameters. Do not put configuration under a
public static directory. Reconfirm product activation and the chosen production
notification/query path before treating a deployment as ready.

The notification endpoint accepts bounded URL-encoded form parameters and
rejects duplicate fields. It verifies the original values using the installed
SDK, then checks application, configured seller, order, amount and trade identity.
Event insertion and paid-state update commit together. Refund/close events cannot
deliver a purchase. Successful processing returns plain `success`; malformed,
invalid or transient failures return plain `fail` for provider retry.

If `notify_url` is omitted, it is omitted from the SDK request entirely. The
service's reconciliation worker continues authenticated, signed transaction
queries after the browser closes and after service restart. It retains unknown
and waiting orders, backs off to hourly queries, and does not replay payment or
refund writes. Do not mark a network timeout as paid/failed, or ask a buyer to pay
a new order while the old result remains unresolved. The UI offers explicit
query and reuse of the original order, and blocks creating another unresolved
order in the same environment.

Saved order responses include the original `requestId`. The App keeps that
UUID in account-and-origin-scoped recovery storage through uncertain outcomes, including a lost create response, and rotates
it only after its matching saved receipt is confirmed paid or closed. Historical
receipts remain visible across environments; only unresolved orders in the
current offer's environment block starting a payment.

## APIs and recovery

All account APIs use the existing same-origin HttpOnly session, CSRF protection
and server-resolved ownership. Disabled users, revoked sessions and grading-only
native tokens cannot use payment APIs. All money uses integer cents/decimal text.

| Route | Behavior |
| --- | --- |
| `GET /api/me/plans` | Fixed catalog, current plan, expiry and grant balances; available with checkout disabled. |
| `GET /api/me/payments/offer` | Legacy configured amount/subject/environment, no credentials. |
| `GET /api/me/payments` | Own latest 50 orders and refund receipts; passive. |
| `POST /api/me/payments` | Explicit start with UUID `requestId` and catalog `productId` for new production orders; UUID-only requests remain for sandbox/legacy replay. Replay preserves the product and original order. Client price/owner fields are rejected. |
| `GET /api/me/payments/{id}` | Own saved receipt only. |
| `POST /api/me/payments/{id}/query` | Verify current provider status. |
| `POST /api/me/payments/{id}/form` | Query first, then regenerate the original order's form; never another order number. |
| `POST /api/me/payments/{id}/close` | Query first; close only confirmed waiting trades, then query again. |
| `POST /api/admin/payments/{id}/refunds` | Administrator/current-password confirmation, UUID `requestId`, decimal `amount`, and bounded `reason`. |
| `POST /api/admin/payments/{id}/refunds/{refund_id}/query` | Query the saved refund; no refund mutation. |

Legacy non-product orders allow partial refunds, each with a new UUID. Catalog
products require unused/unreserved grants and a full buyer-paid-amount refund;
the grant is frozen before submission and revoked only after verified success. Repeating the same refund UUID returns its
stored receipt and cannot resend it; changing its order/amount/reason conflicts.
Unknown and successful refunds both reserve their amount against the original
paid total, including concurrent requests. Uncertain submission is deliberately
not released by a timeout or a rejected/ambiguous response. Query the original
refund ID; only `fund_change=Y` with matched fields or a matched
`REFUND_SUCCESS` query confirms success. Unresolved refunds are queried by the
worker beginning at least 10 seconds after submission. If a provider definitively
rejects a refund, reconcile it out of band before changing retained evidence;
there is no unsafe automatic release/retry command.

Changing application or environment does not adopt existing receipts: actions
require their original application/seller/environment binding. Restore the
correct configuration to reconcile old unknown results. Administrative reads
and refund actions use the existing audit trail. No payment action starts an LLM,
document parser or answer-generation job.

## Dependencies and evidence

The official [Alipay Python SDK](https://github.com/alipay/alipay-sdk-python-all)
is pinned in `pyproject.toml` and `uv.lock`; retained notices are under
`licenses/alipay/`. It uses `page_execute(..., 'POST')` for page-pay and ordinary
signature-verifying `execute` for query/refund/close. SDK `execute` already returns
the unwrapped business payload; it must not be unwrapped a second time.

`tests/test_payments.py` uses a substitute gateway plus real SDK RSA signature
checks and disposable PostgreSQL. It covers ownership, CSRF, immutable server
prices, unknown receipts, refund replay and amount reservations, notifications,
background recovery, config protection and the schema-6 upgrade. These tests do
not prove real buyer payment or production readiness.

`app/src/CloudPayments.test.tsx` exercises the migrated customer order view with
substitute native/HTTP responses, including lost-response request reuse across
remounts, matching terminal receipts, environment isolation and disabled offers.
Native tests verify restricted Alipay form reconstruction. The customer `/payments`
page and assets were removed; only `/payments/return` remains to direct buyers
back to the App for an authenticated query. Tests submit no money and do not
validate merchant activation.
