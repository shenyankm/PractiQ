# Personal self-hosted use

PractiQ is an open-source personal document importer and offline practice app. There are no users, phone accounts, account tokens, products, point balances, recharge, checkout or billing APIs. You configure your own model provider and pay that provider directly. Model usage, unknown results, per-task call budgets, provider limits and explicit recovery remain available.

## Access

The macOS App opens directly into **Document import** for native selection/upload, task review, corrections and direct local-bank import. It defaults to the independent Python backend at `http://127.0.0.1:8090`; change the address under global **Settings → AI service**. There is no independent Web frontend or backend static hosting. Legacy `AI_SERVICE_TOKEN` and `AI_WEB_DIR` values are ignored; existing files and credentials are not deleted.

Keep the service on loopback. If you expose it through a private HTTPS proxy,
configure access control at that proxy. Cross-origin browser API requests are
rejected; the App import client uses same-origin requests without cookies or credentials.
Model and Tencent credentials remain on the service. Opening or reloading the
page only reads service state and never starts paid work.

Only Start import, resume, retry, parse again and explicit grading authorize model work. File selection, task reads, partial export and downloads do not call a model. Unknown results retain their call records; inspect provider usage before explicitly retrying because the provider may have charged for the earlier request.

## Fresh installation

Follow the [service guide](service-guide.md). Initialize an empty dedicated PostgreSQL database with `make init-db`; new service schema 9 contains only task, checkpoint, Store, delivery and grading state. Use a dedicated storage directory and RabbitMQ vhost. The App remains on SQLite schema 11 with v4 data and unchanged ZIP/backup formats.

## Existing deployments

No live data or private configuration is changed by the source update. Stop the old AI process and any legacy checkout, disable checkout startup, and back up the complete database, matching storage and private configuration before changing deployment versions. Preserve legacy payment evidence and ledgers for your own reconciliation; this version does not process them.

Normal startup rejects service schemas 1–5. Explicit offline `make upgrade-db` upgrades complete schemas 1–5 to 9, retaining task IDs, receipts, checkpoints, grading records, files and historical tables. Schema 1 also receives the existing transactional outbox. Legacy account/payment tables and columns are left untouched and are no longer used by the runtime. The maintenance lock still fences an old checkout binary during upgrade/backup.

If schema 3/4 contains any account-owned document tasks, upload records or pending/unknown accounting calls, upgrade refuses without mutation, including when the call's task has already been deleted. Missing historical account tables or mixed schema 1/2 account state also prevent upgrade. Archive the old database and storage together and initialize a new personal database, storage directory and RabbitMQ vhost. Export needed question-bank ZIPs using the original deployment first. Customer tasks, sources, shared content-addressed artifacts and unsettled call evidence must not be silently adopted or cleaned by a personal deployment. Do not bypass the check by changing the schema marker, clearing ownership columns or deleting accounting evidence.

Changed execution signatures prevent resuming old model checkpoints under this code. Saved results remain readable/exportable after an eligible upgrade; explicitly parse again as a new task when needed. Finish unfinished tasks with their original deployment before switching if you need checkpoint continuation. Rollback requires restoring the matching old database/storage backup and original executable; no automatic downgrade is provided.

Remove obsolete `AI_INPUT_POINTS_PER_1K`, `AI_OUTPUT_POINTS_PER_1K`, `AI_ACCOUNT_*`, `PAYMENT_*` and checkout-only secrets from active configuration. They are no longer read. The payment SDK extra, management commands, Vite proxy and `/purchase` checkout are removed. Account, administrator, product and payment APIs return 404. The personal import API does not consume account cookies or tokens.

## Switching from the retired multi-user deployment

Schemas 6–8 are not upgraded or adopted. Startup and offline upgrade refuse them without mutation. Preserve the original database, storage, configuration and executable together. Export question-bank ZIPs using that deployment, then initialize a fresh personal schema-9 database, separate storage directory and RabbitMQ vhost. Never change a schema marker or clear ownership to bypass this boundary.

The App connects directly from **Document import** to a personal service. Its origin is saved separately in `v4/import-service-v1.json`; old `account-service-v1.json`, account Keychain entries, practice databases and grading connection settings are untouched. Existing correction drafts and uncertain submission intents in the retired user namespace are not adopted. Finish/reconcile them in the original deployment before switching. No registration, administrator bootstrap, allowances, plans or payment setup is required.

The API must remain on loopback or behind a private access-controlled proxy; it is not a public multi-tenant service. App AI grading uses the same backend configured under global **Settings → AI service**. Provider keys remain in the backend environment, and only explicit grading/retry starts a call. Legacy App credentials and grading sidecars are preserved but never used for direct calls.
