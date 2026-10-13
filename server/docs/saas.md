# Phone, cards and import points

The Web client has no registration or login page. A phone number plus any nonrevoked card bound to that number authorizes its imports. Mainland mobile numbers without a country prefix normalize to `+86`; other numbers require an international `+` prefix. There is no SMS verification. A card is the access credential; keep it private. Each number may have multiple cards and one pooled balance. Cards have no expiry and no self-service transfer. Lost credentials require operator identity checks; do not bind a new card to an existing number without its existing credential.

## Deployment and migration

Back up PostgreSQL and local storage, stop the service, and run `make upgrade-db AI_PYTHON=/path/to/python3.14`. Schema 1 and 2 upgrade explicitly to schema 3; initialization only accepts an empty dedicated database. Legacy tasks remain administrator-owned. Checkpoint and execution-version validation still apply: a database upgrade does not make incompatible graph checkpoints resumable. Retain backups for the historical executable and do not modify checkpoints to bypass version checks.

Set both `AI_INPUT_POINTS_PER_1K` and `AI_OUTPUT_POINTS_PER_1K` explicitly. Values are positive points per 1,000 tokens with at most six decimal places. Products and pricing have no commercial defaults. Each task freezes both rates; changing environment settings affects newly created tasks. One point is 1,000,000 integer micropoints. A call costs `ceil((inputTokens * inputRate + outputTokens * outputRate) / 1000)` micropoints. Invalid output, correction, retries and enabled source reviews consume actual provider usage too. Reading, checkpoint replay and downloads are free.

The backend stays on loopback behind an HTTPS proxy. Use the edge request limits in `server/deploy/nginx.conf`, including the tighter card redemption limit. Never log Authorization, `X-Practiq-Phone`, card redemption bodies or model inputs. Keep PostgreSQL, RabbitMQ and plaintext card exports private; never commit them. The old service Bearer token provides administration of legacy tasks without a phone account and App grading. It cannot list, read, control, delete or download customer tasks, or create or reparse SaaS imports. Artifact reads always require an authorized task ID, including Bearer reads of legacy artifacts.

## Products and card delivery

Run these commands from `server/` using the selected Python 3.14+ interpreter. The CLI loads the repository `.env`. Replace example identifiers, point amounts and URLs with the operator's actual product configuration:

```sh
python3.14 -m practiq_ai.saas_manage product --id PRODUCT_ID --name 'Product name' --points POINTS --purchase-url https://SHOP/PRODUCT
python3.14 -m practiq_ai.saas_manage generate --product PRODUCT_ID --count 100 --output /private/path/cards.txt
python3.14 -m practiq_ai.saas_manage revoke --digest SHA256_DIGEST
```

Generated cards contain 192 random bits. Only SHA-256 digests enter PostgreSQL. The exclusive TXT export uses mode 0600 and contains one code per line; existing exports are never overwritten. Each card snapshots the product's points at issuance. Product changes and disabling a product do not change issued cards. Revocation disables access without removing purchased points or ledger history. Import the protected TXT into the matching Chain Shop product and verify its actual importer format before selling; this integration does not call a Chain Shop API. An uncertain export/commit outcome requires checking digests in the database before distribution, never blindly reissuing or distributing a failed export.

First binding creates the phone account. Additional redemption requires an already bound, nonrevoked card. Concurrent/repeated redemption credits each card once; a card cannot be transferred to another number. A depleted card still authorizes record access. Recharge first offsets any negative balance.

## Pause, download and recovery

Each phone permits one in-flight model call; different accounts can run concurrently. A positive balance permits a call without predicting its token count. That call can leave a negative balance; the next call pauses recoverably. Completed processing units and model results stay durable. Local merge can complete without another model call. Recharge never resumes work: the user explicitly clicks Continue on the task.

Paused tasks with usable completed questions can download a full snapshot of all completed content. The snapshot retains `PARTIAL`, missing fields and review flags, verifies images and checkpoint consistency, and does not modify the graph checkpoint. No usable questions means no export. Every download includes all currently completed questions; importing overlapping snapshots into the App creates independent question banks.

Model results and usage are persisted before settlement. Unique call keys make settlement idempotent. A settlement failure pauses the task; explicit continuation reuses the saved result and retries settlement without another model call. Unsettled result and call receipts do not expire with the task, and task deletion or offline cleanup retains them until accounting is resolved. Startup reconciles pending calls from durable results; dispatched calls without determinable usage block new calls for that phone. Operators can inspect and record verified usage:

```sh
python3.14 -m practiq_ai.saas_manage unknown
python3.14 -m practiq_ai.saas_manage resolve --call-key CALL_KEY --input-tokens ACTUAL_INPUT --output-tokens ACTUAL_OUTPUT --note 'Provider receipt and verification reference'
```

Record zero tokens only when verified that no usage occurred. Resolution creates no model result and does not automatically resume a task. If the provider result itself is unavailable, the existing explicit recovery mechanism may need a new billed call; do not invent output or replay uncertain calls automatically. Task deletion/expiration preserves the ledger and all call accounting records.

## HTTP contract

Public `GET /api/products` lists configured enabled products. `POST /api/cards/redeem` accepts `{phone, card, boundCard?}` and returns the account balance. Protected requests send `Authorization: Card <code>` and `X-Practiq-Phone: <number>`. `GET /api/account` and `/api/account/ledger?limit=20&before=ID` expose only that account. Credentials live in page memory and clear on disconnection/refresh; never place them in URLs or browser storage.

Existing document endpoints enforce account ownership on lists, details, parents, idempotency receipts, cursors, controls, deletion and downloads. Task details add `billing` and `canExportCompleted`. ZIP downloads accept `scope=full|completed` with `checkpoint_id`; artifact reads require the authorized `thread_id` and a reference reachable from that task. Shared hashes never authorize another account's upload: it must actually upload and pass checksum validation. Python contracts generate the Web/App types.
