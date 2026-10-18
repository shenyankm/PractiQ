# Personal self-hosted use

PractiQ is an open-source personal document importer and offline practice app. There are no users, phone accounts, account tokens, products, point balances, recharge, checkout or billing APIs. You configure your own model provider and pay that provider directly. Model usage, unknown results, per-task call budgets, provider limits and explicit recovery remain available.

## Access

`AI_SERVICE_TOKEN` must use visible ASCII characters without spaces. Configuration rejects Unicode, internal whitespace and control characters before startup; surrounding whitespace is trimmed.

Set `AI_SERVICE_TOKEN` in the service environment. The Web importer and optional App grading use `Authorization: Bearer <token>`. The token authorizes all personal imports and grading on this deployment; do not share it as a customer credential. Keep the service on loopback, or behind your private authenticated TLS access path. Model keys stay on the service. Web keeps the service token only in page memory and clears it on reload. The App keeps it in platform credential storage, outside backups.

Only Start import, resume, retry, parse again and explicit grading authorize model work. File selection, task reads, partial export and downloads do not call a model. Unknown results retain their call records; inspect provider usage before explicitly retrying because the provider may have charged for the earlier request.

## Fresh installation

Follow the [service guide](service-guide.md). Initialize an empty dedicated PostgreSQL database with `make init-db`; new service schema 5 contains only task, checkpoint, Store, delivery and grading state. Use a dedicated storage directory and RabbitMQ vhost. The App remains on SQLite schema 11 with v4 data and unchanged ZIP/backup formats.

## Existing deployments

No live data or private configuration is changed by the source update. Stop the old AI process and any legacy checkout, disable checkout startup, and back up the complete database, matching storage and private configuration before changing deployment versions. Preserve legacy payment evidence and ledgers for your own reconciliation; this version does not process them.

Normal startup rejects service schemas 1–4. Explicit offline `make upgrade-db` upgrades complete schemas 1–4 to 5, retaining task IDs, receipts, checkpoints, grading records, files and historical tables. Schema 1 also receives the existing transactional outbox. Legacy account/payment tables and columns are left untouched and are no longer used by the runtime. The maintenance lock still fences an old checkout binary during upgrade/backup.

If schema 3/4 contains any account-owned document tasks, upload records or pending/unknown accounting calls, upgrade refuses without mutation, including when the call's task has already been deleted. Missing historical account tables or mixed schema 1/2 account state also prevent upgrade. Archive the old database and storage together and initialize a new personal database, storage directory and RabbitMQ vhost. Export needed question-bank ZIPs using the original deployment first. Customer tasks, sources, shared content-addressed artifacts and unsettled call evidence must not be silently adopted or cleaned by a personal deployment. Do not bypass the check by changing the schema marker, clearing ownership columns or deleting accounting evidence.

Changed execution signatures prevent resuming old model checkpoints under this code. Saved results remain readable/exportable after an eligible upgrade; explicitly parse again as a new task when needed. Finish unfinished tasks with their original deployment before switching if you need checkpoint continuation. Rollback requires restoring the matching old database/storage backup and original executable; no automatic downgrade is provided.

Remove obsolete `AI_INPUT_POINTS_PER_1K`, `AI_OUTPUT_POINTS_PER_1K`, `AI_ACCOUNT_*`, `PAYMENT_*` and checkout-only secrets from active configuration. They are no longer read. The payment SDK extra, management commands, Vite proxy and `/purchase` checkout are removed. Account, product and payment APIs return 404; old `Authorization: Account` requests return 401 on protected task APIs.
