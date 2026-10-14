# Vibe Pay basic checkout

The optional checkout is a separate FastAPI process. An authenticated existing account buys an import product; verified payment credits its point balance directly. There are no cards, redemption or private receipt downloads. Operator-issued account tokens authenticate existing users but never contain recharge value. Checkout never registers accounts, starts models or resumes tasks. The offline practice App contains no payment SDK.

## Deployment and migration

Use a separate Python 3.14+ checkout interpreter and `make payments-install-locked AI_PYTHON=/absolute/path/to/checkout-python3.14`. The SDK is a `payments` extra; the default production AI image does not install it. Full development installs include both `dev` and `payments` so the complete test suite runs.

Create the private checkout configuration separately:

```sh
umask 077
cp -n .env.payments.example .env.payments
```

Configure the same dedicated `DATABASE_URI`, optional `AI_WEB_DIR` and `PAYMENT_*` values there. Keep AI/LLM/RabbitMQ credentials in the AI service `.env`; do not export merchant secrets into its parent shell or add them to that file. If upgrading an existing shared configuration, move its payment values into `.env.payments` before restarting either service. Checkout startup and payment CLI commands load only `.env.payments`; the AI Compose service continues to load only `.env`. Run checkout under a separate service identity or container and never mount its private environment file into the AI container. Choose `sandbox` or `production` explicitly; gateways are fixed. Set `TZ=Asia/Shanghai` for SDK timestamps (the Make target does this). Optionally configure `PAYMENT_SELLER_EMAIL` with the verified seller login account when notifications identify the seller without `seller_id`. A present seller ID must match the configured ID; an email cannot override a conflicting ID. Both RSA keys must have at least 2048 bits: PKCS1 application private key and SubjectPublicKeyInfo Alipay public key, as PEM or base64 bodies. Disable SDK request/response logging.

Use the same dedicated PostgreSQL database as the AI service. Stop both services and back up the entire database, storage and secrets. Upgrade service schemas 1/2/3 explicitly to 4 before initializing optional payment schema 3:

```sh
make upgrade-db AI_PYTHON=/absolute/path/to/python3.14
make payments-init-db AI_PYTHON=/absolute/path/to/python3.14
```

Existing optional schema 2 upgrades explicitly to 3, adding durable refund evidence while retaining orders and ledger. Normal startup rejects older payment schemas; rerun explicit initialization after an interrupted upgrade.

For a fresh installation, initialize the empty dedicated service database with `make init-db` first. Service startup never migrates tables. Offline maintenance requires both AI ownership slot 1 and checkout slot 3; it refuses while either process runs. Schema 4 keeps existing account balances, ledger, task ownership and historical card rows; operators issue new account tokens only after verifying existing owners. See [account access](saas.md).

If optional payment schema 1 was previously deployed, retain its original `PAYMENT_CARD_KEY` while running `payments-init-db`. It verifies the original merchant/environment fingerprint before the atomic upgrade to 2 followed by the atomic refund-evidence upgrade to 3. Afterwards the old key is unnecessary for active checkout. Historical order access digests, card digests and delivery timestamps remain archival; old receipt credentials have no current API. Anonymous legacy orders receive no automatic account allocation or credit. Already delivered card orders remain archived as `fulfilled` and cannot be allocated or credited again. Preserve the old database/key backup for historical incident review.

A verified operator can allocate only a legacy order that has no account and has not delivered a card, while both services are stopped:

```sh
cd server
python3.14 -m practiq_ai.payments_manage bind-legacy --order-id ORDER_ID --phone VERIFIED_EXISTING_PHONE --note 'Verified provider receipt and existing owner'
```

This records the allocation note but does not credit a balance. Explicit reconciliation still verifies payment and performs the normal idempotent credit. Never guess ownership from an unverified phone or convert already delivered cards into new points.

Configure products and integer RMB cents without default prices:

```sh
cd server
python3.14 -m practiq_ai.saas_manage product --id pack --name 'Import points' --points 100 --purchase-url 'https://checkout.example/purchase?product=pack'
python3.14 -m practiq_ai.payments_manage product --product pack --price-cents 900
```

`900` means RMB 9.00; points retain six-decimal integer micropoints. Product edits affect new orders only. Created orders freeze name, price and points. Build Web with `make web-build`, set `AI_WEB_DIR` to that build, then start `make payments-dev`: one worker, `127.0.0.1:8091`, 32 concurrent requests, no access logs. The Vite proxy directs `/api/payments` to 8091 and other `/api` routes to the independent AI service at 8090. Production requires a separate HTTPS checkout host that proxies these routes. The notification URL must end in `/api/payments/notify`, and the return URL in `/purchase`. No model credentials or RabbitMQ connection are required by checkout.

## Account purchase and recovery

Open the product link, connect with the existing phone and account token, choose a pack and explicitly create a recharge order. Protected requests use `Authorization: Account <token>` and `X-Practiq-Phone`; the account ID comes from server authentication, never the request body. Credentials stay only in page memory, never in URLs, cookies, browser storage or logs. A separate checkout origin requires reconnecting there. Service Bearer tokens and old card credentials cannot access customer balances or orders.

Creation uses a UUID request ID, scoped to the account. Concurrent/repeated requests return one order; changing the product for that same request is rejected. An uncertain mutation is never automatically replayed. A manual creation retry in the same connected page keeps its request ID. After refresh, closure or a mobile payment return, reconnect and query **我的订单** before creating another order. Order history and individual queries expose only the authenticated account's records.

Checkout supplies a signed `alipay.trade.page.pay` URL via the official SDK's `page_execute(GET)` for desktop and mobile Web; the user explicitly opens it in a new tab. Provider HTML is never injected. The payment window expires after 30 minutes. Link generation stops once the wire timestamp would leave less than one minute, and previously prepared browser links are blocked at that cutoff. Uncertain/closed orders remain queryable. Click **查询支付与到账** after paying. The return URL, frontend status and payment screenshots never authorize credit. A confirmed order shows its credited points and refreshed account balance. Recharge offsets negative balances and never automatically resumes parsing; return to the task and explicitly Continue.

## Confirmation and exactly-once credit

Notifications have bounded UTF-8 form bodies; duplicate names are rejected. The official SDK verifies RSA2 signatures. The server checks app ID, a matching seller ID or explicitly configured seller login alias, merchant order, frozen amount and trade number. Only `TRADE_SUCCESS` or `TRADE_FINISHED` authorizes payment. Signed queries use a fixed TLS gateway, timeouts, no redirects, at most 64 KiB and signature verification over the original JSON bytes. Signed not-found results preserve pending orders; uncertain transport, signature or business results grant no points.

Payment evidence commits as `paid` first. A second transaction locks the order and uses the existing integer ledger to credit its immutable account with kind `purchase` and reference equal to the order ID, then marks it `credited` atomically. A unique ledger reference and row locking prevent duplicate credit from concurrent notifications, queries or retries. An overflow or database failure rolls back both the balance/ledger and the credited state, leaving paid evidence available for recovery after restart. Stale waiting events never downgrade a paid or credited order. A closed event after verified payment requires refund review without deleting the prior paid or credited evidence. Token revocation blocks access but does not prevent an already paid, account-bound order from being credited.

Refund indicators in signed notifications or query results are retained in the order before any credit. Positive refund amounts, refund business IDs/timestamps, refund details or closure after verified payment put the order on durable operator review. Later successful-payment replays cannot clear that hold; automatic credit and new payment links remain blocked. Already credited points and ledger are not automatically reversed. The customer can query the held order, and operators must reconcile the provider record and actual point usage manually. Automated reconciliation skips held orders. Explicit zero refund amounts alone do not block an otherwise verified payment.

## Operations and limits

```sh
make payments-reconcile AI_PYTHON=/absolute/path/to/python3.14
```

This explicitly queries unresolved/closed orders and retries paid credits without printing credentials or starting models. Unknown results stop reconciliation and remain durable. Unallocated legacy paid orders require verified operator allocation first. Retain payment evidence and ledger independently of task cleanup. Automated refunds, subscriptions, new registrations, SMS and Alipay identity authorization are outside this change. Refunds require operator review of actual usage and the provider record; never delete ledger entries or silently reverse consumed points.

Rate-limit creation and private queries at the trusted HTTPS reverse proxy. The database serializes creation and caps new orders at 10,000 in a rolling day. Active queries admit four concurrent calls and one query per order every three seconds. Browser payment requests timeout after 20 seconds and bound JSON to 2 MiB. API responses use `Cache-Control: no-store` and existing security headers. Never log Authorization, phone headers, request bodies or notification bodies. Merchant/environment changes fail startup until an explicit reviewed migration.

Before production, complete merchant eligibility/contracting and verify actual sandbox browser payment, notification, lost-notification query and direct balance credit with real HTTPS configuration. Local checks use real RSA signatures, disposable PostgreSQL and provider substitutes; they do not prove merchant activation, a real sandbox payment, fees or settlement. Tests initiate no real transaction.

## Official references

- [Vibe Pay basic capabilities](https://aipay.alipay.com/products/vibe-pay)
- [Page payment](https://aipay.alipay.com/docs/vibe-pay/ai-web-app-payment-qianyi/api-list/alipay-trade-page-pay.html)
- [Trade query](https://aipay.alipay.com/docs/vibe-pay/ai-web-app-payment-qianyi/api-list/alipay-trade-query.html)
- [Notification verification](https://aipay.alipay.com/docs/vibe-pay/ai-web-app-payment-qianyi/api-list/async-notify-verify.html)
- [Official Python SDK](https://github.com/alipay/alipay-sdk-python-all), pinned to 3.7.1411; [official AI Pay integration reference package](https://www.npmjs.com/package/@alipay/alipay-aipay), inspected at 1.7.6 without installing or executing its skill/CLI.

At implementation time the site's general Web integration-guide URL returned unrelated glasses documentation. The specific API pages and official package Web interface contract were used instead.
