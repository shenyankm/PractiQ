# RabbitMQ document-run delivery

The single Uvicorn process consumes document runs from RabbitMQ. PostgreSQL remains the source of truth for tasks, runs, request receipts, LangGraph checkpoints/Store and model-call accounting. There is no PostgreSQL pending-run execution scan, fallback dispatcher, separate worker or grading queue. The control coordinator polls only pause/cancel flags; the publisher polls only the outbox.

## Admission and delivery

Every API-created run, outbox row and original request receipt commit in one PostgreSQL transaction. A 202 `accepted` receipt means durable admission, even during a broker outage; it does not mean publication or completion. Repeating the same request ID returns its receipt without another run/outbox row. A failed or unknown HTTP response must be reconciled using that request ID; clients must not automatically replay uncertain mutations.

Admission, execution completion and shutdown notify the control coordinator and outbox publisher through independent events. Each loop clears only its own event before reading PostgreSQL, preserving notifications that arrive during a query or publication. A one-second poll still recovers committed work if notification is lost. The publisher reads at most 100 rows at a time and immediately fetches another page after a full batch; it waits only after a partial or empty batch. Broker backoff, publisher confirms and durable run receipts remain authoritative.

The body is exactly a canonical 36-byte ASCII run UUID, with integer `practiq-version: 1` in AMQP headers and `text/plain` content type. No document, path, URL or credential travels in the message. `message_id` is diagnostic only. Mandatory persistent publication uses publisher confirms with a five-second timeout and raises on returned/unroutable messages. Only a positive ACK marks `document_outbox.published_at`. Ambiguous confirms retain the row and can produce duplicates.

The durable quorum queue `practiq.document.v1` has finite prefetch equal to `N_JOBS_PER_WORKER`, delivery limit 20, `reject-publish` overflow and at-least-once dead lettering through `practiq.document.v1.dlx` to the durable quorum queue `practiq.document.v1.dead`. The DLQ has no automatic consumer, TTL or delivery expiry. Protocol errors are rejected to the DLQ; business errors persist a stable run state and are ACKed. Publisher and consumer have separate TCP connections and independently supervised 1–30 second reconnect backoffs. Publisher failure never closes the consumer connection or waits for active executions. Failed redeliveries additionally use broker delayed retry (1–30 seconds); no immediate nack/requeue loop exists. At the delivery limit a message is retained as a dead letter, not automatically rerun. Alert on dead-letter depth and inspect the run alongside the message.

Consumption validates the protocol and database record before work. A transaction and the process's active-run map share duplicate deliveries with the existing execution; the database's unique active-run-per-thread constraint and exclusive process ownership remain authoritative. Missing/deleted, terminal or cancelled runs do not execute. Checkpoint completion/interrupts are reconciled before graph invocation. ACK follows stable state persistence or a committed return to the transactional outbox. Shutdown cancellation leaves a pending run unacknowledged for redelivery.

On consumer connection loss, executions continue under PostgreSQL ownership. Broker consumer cancellation (including RabbitMQ 4.3 timeouts without channel closure) also triggers supervised recovery. The consumer supervisor closes its old connection and waits for both its handlers and active executions before subscribing again, including when a handler was cancelled. Execution itself owns a process semaphore for `N_JOBS_PER_WORKER`; cancelling a delivery callback cannot free a running job's capacity. A task cancelled before its first step is removed from the active map and redelivered. Admission rechecks shutdown after its database transaction and starts no new execution once stopping. Run IDs, deadlines, request receipts, budgets and checkpoints survive redelivery. Losing database ownership exits the process; no writer continues without that lock.

Queued pause/cancel intent is coordinated under the same admission lock and saved as a stable stopped state even when the broker is unavailable. An accepted pause reports `PAUSED` after coordination and needs explicit resume; it does not wait for a delivery to execute graph nodes. Active pauses remain cooperative. Conditional updates prevent stale control scans from overwriting completed runs.

Model attempts check unit budget availability before waiting for provider capacity, without spending it. After concurrency admission and each RPM wait they recheck execution validity and pause intent before consuming an RPM slot, then reserve the budget afresh before recording dispatch. Runtime guards consult the committed run pause flag as well as its Store projection, so they do not depend on the control loop winning a wake-up race. The database handle is passed only in ephemeral graph context, never in persisted run inputs or checkpoints. A pause at that boundary prevents provider dispatch; explicit resume retains the existing recovery path. A pause cannot retract a request already sent to the provider.

Resuming a run paused before its first step preserves that queued input or review command, including the originally selected retry units. It creates the existing explicit new run/receipt without expanding a selected retry or losing a review decision. The earlier request receipt remains replayable.

## Paid-call boundary

The existing Store call ledger records `started` before sending and `completed` only after the durable LangGraph task result is replayable, including the run ID and `durableResult` certificate. An atomic Store result receipt keyed by run/task identity covers the gap before asynchronous LangGraph task writes flush; replay reads that receipt before reserving or paying for another call. Legacy completed call records without that certificate on unfinished runs also require explicit recovery; the ledger alone cannot prove the result was checkpointed. Completed LangGraph task results/checkpoints are reused. An unfinished run with a non-completed/non-rejected call record stops in `INTERRUPTED` (or `PAUSED` for a pending pause) with `MODEL_RESULT_UNKNOWN` before another model invocation. The same recovery state applies when its deadline cancels a call whose result remains unknown; saved completed units remain eligible for passive partial export. A deadline without an unknown call remains `FAILED` with `RUN_DEADLINE_EXCEEDED`. Billing may have occurred even when no response was saved. Inspect usage and provider billing before using the existing explicit resume/retry API; that explicit action creates a new run and can incur another charge. Grading retains its existing synchronous explicit-call protection.

This is at-least-once message delivery with paid-call protection, not exactly-once provider execution. The ledger cannot distinguish a crash just before sending from a crash after the provider accepted; both stop conservatively. Known stored results can still be recovered without a new charge.

## Broker version and configuration

Pin `rabbitmq:4.3.6-management@sha256:8dd6e3570ddaa2ef82a6c3a8950e79c1f73893adfbdddbc374fc1f1ac8a0f5dd` and `aio-pika==10.1.1` (Python 3.14 supported by upstream and tested here). The client is asyncio-native; plain connections are deliberately supervised so reconnect cannot silently restore a consumer while old work is active. Runtime/dev/build audits include the new locked dependencies. [AMQP license notices](../licenses/README.md) retain exact installed upstream texts; RabbitMQ retains its upstream [MPL 2.0 license and source](https://github.com/rabbitmq/rabbitmq-server/tree/v4.3.6).

RabbitMQ 4.3 quorum queues support consumer timeouts and delayed retry. Only failures (including session/channel loss and `basic.reject`) count toward delivery-limit; `basic.nack` alone can loop indefinitely and is not used. Main-queue `x-consumer-timeout` is the greater of five minutes or the run timeout plus five minutes, including shutdown/ACK allowance. Configuration changes require matching queue arguments: an incompatible existing declaration fails readiness and retains outbox rows; do not silently purge/recreate it. Drain and plan a queue configuration change with matching backups. Operator policies must not shorten the declared timeout or disable at-least-once dead lettering. See upstream [quorum guarantees, poison handling and timeout rules](https://www.rabbitmq.com/docs/quorum-queues), [consumer rules](https://www.rabbitmq.com/docs/consumers), and [aio-pika confirms](https://docs.aio-pika.com/rabbitmq-tutorial/7-publisher-confirms.html).

`RABBITMQ_URI` comes only from the trusted service environment. Set an explicit dedicated virtual host and URL-encode its name/password; query parameters/fragments are rejected. Plain AMQP is accepted only for `localhost` or a loopback IP address. Any other host requires AMQPS with certificate verification; remote plaintext connections are rejected at startup. Do not pass URLs on command lines or print resolved Compose configuration containing secrets. Third-party AMQP logs are suppressed below CRITICAL; application events include only sanitized error codes and finite `role`, `stage`, and `reason` classifications, plus a validated run ID when known. TLS, authentication, permission, topology conflict, missing entity, publish rejection, timeout and connection loss remain distinguishable without logging exception text. `practiq_broker_failures_total` uses the same bounded classifications.

The provided Compose broker has a stable hostname, persistent named volume, health check, and loopback-only AMQP/management ports. A single node is suitable for development and this single-machine service; **it provides no high availability**. Disk failure still requires a consistent backup. This change does not support multi-machine workers.

Before starting the AI service, create a separate service user with no administrator tags, restricted to the dedicated `practiq` vhost. The Compose administrator variables are bootstrap-only; changing them does not rotate an existing volume's credentials. Create/rotate users explicitly through the loopback management UI or `rabbitmqctl` in an authorized environment. Grant configure/read only `^practiq[.]document[.]v1([.]dead|[.]dlx)?$` for topology and dead lettering. Grant write `^practiq[.]document[.]v1([.]dead|[.]dlx)?$|^amq[.]default$`: publication through the default exchange requires explicit write permission to `amq.default`. Keep this vhost dedicated to the service. Keep the administrator credential out of `RABBITMQ_URI`. Test permissions and topology before admission. Never expose port 5672/15672 publicly, delete the broker volume or purge its queues to fix readiness.

`/ok` stays a public liveness check. Normal and maintenance `/ready` require PostgreSQL, ownership/control tasks, a live consumer subscription and a connected publisher. A blocked/timed-out publisher makes readiness fail while existing consumer work can still finish and ACK. Broker unavailability returns 503 readiness while authenticated reads, control requests and durable admission remain available subject to existing bounds. Maintenance rejects new admission/grading and drains existing messages when the broker is available. Read-only mode needs neither broker connection nor model configuration; it interrupts unfinished runs and serves saved results without publication/consumption/model work. Explicit re-enabling still requires an API resume. There is no automatic scheduling fallback.

Observe authenticated `practiq_broker_connected`, `practiq_broker_publisher_connected`, `practiq_broker_consumer_connected`, `practiq_outbox_pending`, `practiq_outbox_oldest_seconds`, `practiq_pending_oldest_seconds`, `practiq_delivery_events_total`, run backlog and provider unknown-usage metrics. `practiq_broker_required=0` suppresses service-connectivity/consumer alerts for read-only instances. Direct broker monitoring still detects dead letters that never emit an application poison event. See the monitoring and resource setup below.

## Resource limits, policies and monitoring

The single-node Compose profile retains the existing `rabbitmq-data` volume and
stable hostname. It mounts [rabbitmq.conf](../deploy/rabbitmq.conf) and the enabled
plugins file, exposes Prometheus on **loopback only** (`15692`), allows two CPUs,
caps memory at 1536 MiB and processes at 512, and allows 65,536 file descriptors.
The absolute 768 MiB memory watermark leaves headroom below the container limit;
the disk watermark reserves 2 GiB. These are starting budgets for a small personal
deployment: reserve capacity for PostgreSQL, document workers and the OS too, and
size the disk using measured load. A watermark throttles publishing, not memory
allocation; it is not an OOM guarantee.

After the dedicated `practiq` vhost exists, inspect existing policies/backlog and
apply the mounted [capacity policies](../deploy/rabbitmq-policies.json) explicitly:

```sh
docker compose --env-file .env -f server/deploy/service.compose.yml exec -T rabbitmq \
  rabbitmqctl import_definitions /etc/rabbitmq/practiq-policies.json
```

The main queue budget is 1,000 ready messages or 1 MiB of message bodies; the DLQ
budget is 10,000 or 10 MiB. Policies take effect without changing declaration
arguments or recreating queues. Existing higher-priority/operator policies may
change effective limits: inspect `rabbitmqctl list_policies -p practiq` and each
queue's effective policy. Quorum queues can overshoot a length limit with
in-flight messages; these limits are backpressure, not an exact message count or
a bound on total broker disk overhead. Full queues reject publishers; an
unconfirmed outbox entry stays durable. A full DLQ retains unconfirmed dead
letters in the source queue and may stall its capacity until recovery. Do not
switch overflow to `drop-head` or dead lettering to `at-most-once`, add expiry,
purge queues or remove volumes to relieve pressure.

Import is deliberately **after bootstrap**: boot-time definitions on an empty
broker suppress default user creation. The policy file contains no credentials
and does not provision users. Review and explicitly apply it to existing brokers;
new configuration files do not by themselves update a running deployment.

The [Prometheus example](../deploy/prometheus.example.yml) scrapes node metrics
with job `practiq-rabbitmq`, and only the two document queues through
`/metrics/detailed` with job `practiq-rabbitmq-queues`. This avoids exporting every
connection/channel. Keep metrics inside the private monitoring boundary; they
are not authenticated application endpoints. The [rules](../deploy/alerts.rules.yml)
cover missing scrapes, resource watermarks/alarms, zero or missing consumers,
nonempty DLQ (including unacknowledged messages), pending runs older than 30
minutes, and repeated sanitized failures. The pending threshold and capacity
budgets must fit the actual workload. Test both firing and recovery with
`make alerts-check`, then deliver a synthetic alert to the real receiver before
production admission. The offline production preflight requires both broker
jobs, both connection roles, no resource alarm, a consumer and an empty DLQ.

For dead-letter retention, alert immediately rather than silently expiring data.
Record the run ID, headers, `x-death`, checkpoints and usage before recovery. Keep
an access-controlled infrastructure archive and an operator record of reconciled
IDs. Only ACK/remove individual dead letters after their archive and recovery
are verified; preserve unreviewed messages and archive copies. The offline
`replay-run` procedure below remains the only broker-replay path and does not
automatically consume/archive the DLQ. Monitor retained bytes and review archival
capacity regularly, including source-queue dead letters blocked behind a full DLQ.

## Optional three-node broker and endpoint failover

`RABBITMQ_FAILOVER_URIS` is an optional JSON array of at most two additional
endpoints. All endpoints must reach **the same cluster and vhost**, have the same
restricted permissions, and pass the existing TLS/loopback checks. The service
validates this list at writable startup. Each connection role advances through
the endpoints after a failed session and preserves its own reconnect backoff.
No credential/endpoint string is logged, sent to document workers or exposed to
the Web/App. Without the list, the existing `RABBITMQ_URI` behavior is preserved.
Do not point it at independent brokers: failover is not queue replication.

The separate [three-node Compose profile](../deploy/rabbitmq-cluster.compose.yml)
is an opt-in **local node-failure drill**, with three distinct volumes and stable
peer names. It does not alter the single-node deployment or migrate its data.
Use a private environment file with `RABBITMQ_ADMIN_USER`,
`RABBITMQ_ADMIN_PASSWORD`, and a random shared `RABBITMQ_CLUSTER_COOKIE`:

```sh
docker compose --env-file /private/broker-cluster.env \
  -f server/deploy/rabbitmq-cluster.compose.yml up -d --wait
docker compose --env-file /private/broker-cluster.env \
  -f server/deploy/rabbitmq-cluster.compose.yml exec -T rabbitmq-1 rabbitmqctl cluster_status
```

Wait for all three nodes before declaring queues, then provision the restricted
identity and import the capacity policies on one node. Check that **both queues**
have three members. Existing one-member quorum queues do not automatically gain
replicas merely because nodes join; expand membership using the broker's
administrative process and matching backups, and verify it before switching.
The local endpoints are loopback ports 5673/5674/5675 (management 15673–15675,
metrics 15693–15695). Configure the primary and two fallback URLs for the same
vhost. Scrape all three nodes with both Prometheus jobs; use the maximum per
queue when viewing queue metrics rather than summing duplicate series.

For host availability, place the three nodes on independent failure domains,
retain distinct persistent disks, use verified AMQPS for every remote endpoint
and authenticated/encrypted private peer connectivity, and keep management and
metrics private. The bridge-network local profile is not a multi-host security
or deployment recipe. Keep one application owner; PostgreSQL and immutable file
storage still need their own recovery/availability plan. A local leader kill
proves node failover, not host/disk disaster recovery or full-service HA.

## Service database upgrade

The current independent service schema is 8; the explicit upgrade accepts complete schemas 1 through 7. Schemas 1–5 receive the account tables, schemas 1–6 receive the payment tables, and every older schema receives the billing tables. Schema 1 additionally receives the transactional outbox. See [account deployment and upgrade](accounts.md). App SQLite schema 11, v4 data, credentials, service settings and backup formats remain unchanged. Normal startup rejects schema 1 through 7 with upgrade instructions; `init-db` remains restricted to an empty dedicated database.

1. Stop the old service and disable its supervisor restart. Stop every writer/maintenance tool and retain its image, configuration and dependencies. Never run the PostgreSQL polling service alongside the new consumer.
2. Back up the **entire** dedicated PostgreSQL database with `pg_dump -Fc` and the matching immutable storage directory. Record schema version, source revision and file checksums; verify restoring to an isolated database/storage directory. Keep these backups and existing volumes intact.
3. Provision the pinned broker, persistent volume, dedicated vhost and restricted service identity. Set `RABBITMQ_URI` in the new environment, without exposing its password. Install locked Python dependencies.
4. With the old service still stopped, run `make upgrade-db AI_PYTHON=/path/to/python3.14` (or `cd server && python -m practiq_ai.manage upgrade-db`). Use ordinary writable-mode configuration. The command takes the same runtime ownership lock, validates complete schema 1 through 7, rejects account-owned tasks, uploads and pending/unknown accounting calls without mutation for schemas 3–4, adds the outbox/index for schema 1, adds the missing identity, payment and billing tables, and advances the schema marker to 8. It never rebuilds tables or clears state.
5. Under that lock, it repairs final/interrupt checkpoints, preserves IDs/deadlines/receipts, stops cancelled, paused and unknown-call runs, resets recoverable running runs to pending and stages supported pending runs with `ON CONFLICT DO NOTHING`. Waiting, terminal, manual-interrupt and unsupported tasks remain passive. If interrupted after the schema transaction, rerun the same command; schema-8 validation plus idempotent reconciliation/staging finishes it. Startup also uses this coordinator to repair missing outbox entries after that crash, stopping unknown-call runs before staging. Existing published entries are never reset: dead letters still need explicit recovery. No graph nodes/models execute during upgrade.
6. Start only the new service. Verify `/ready`, outbox confirmation, saved historical results/receipts/files and controlled recovery. Inspect unknown-call tasks manually; do not treat their unknown usage as zero cost.

Rollback has no automatic downgrade. Older binaries reject schema 8. To roll back, stop the new service and broker consumers, back up the new state separately, then restore the pre-upgrade full database and matching storage into an isolated verified destination and switch the old service to that destination. Keep the newer database/storage and broker volume/messages for reconciliation. Work admitted after the backup is absent from the old snapshot and must be reconciled explicitly; do not replay new messages into the old dispatcher. Never change only the schema version marker or run both service versions.

## Explicit dead-letter recovery

Inspect protocol, `x-death`/delivery-count and the database/checkpoint/usage before doing anything. Correct infrastructure/configuration first. For a valid unfinished pending run with no unknown calls, stop the service and use:

```sh
cd server
python -m practiq_ai.manage replay-run --run-id CANONICAL_RUN_UUID
```

The command takes runtime ownership and atomically resets/stages that run's outbox for confirmed publication when the service restarts. It keeps the run ID/deadline and original dead letter for diagnosis. It rejects missing, terminal, cancelled, unsupported and unknown-call runs; use the existing explicit user resume/retry flow for stopped work. Repeating the command can publish duplicates, which the consumer tolerates. It never creates a run, invokes a model or purges the DLQ. After verified reconciliation, an operator may separately archive/remove the original dead letter; this is not automatic.

## Verification

Pure protocol/confirm tests use fakes and never start Docker. Integration fixtures use randomly named PostgreSQL databases and RabbitMQ vhosts; default test containers expose only random loopback ports and are removed on process exit. External test instances must be dedicated/disposable. Configure `TEST_DATABASE_URI`, `TEST_RABBITMQ_URI`, `TEST_RABBITMQ_MANAGEMENT_URL` together; `TEST_RABBITMQ_CONTAINER` identifies the isolated Docker container for restart probes (CI supplies its service ID).

`make verify` runs transaction rollback/idempotency, unroutable/ambiguous confirms, duplicate delivery, lost ACK, poison/DLQ, concurrency, broker restart/disconnect, control/delete/expiry and paid-call protection checks plus separate HTTP process kills before publication, after publication, before execution, during provider calls, after saved model results/checkpoints and after run-result persistence. Migration checks retain historical results, receipts, files and deadlines. The probe report includes actual PostgreSQL/RabbitMQ recovery tests. Fakes do not establish model quality, production capacity, physical-disk durability or multi-node HA. Check broker timeout configuration against representative long documents separately.

Broker-operation probes additionally use real disposable brokers to verify that
a memory alarm blocks the publisher while consumer ACKs continue, a full queue
rejects publication, a full DLQ retains source messages across a broker restart,
and killing the connected quorum leader in the three-node profile preserves
outbox admission and prevents duplicate model calls. Protocol/diagnostic tests
remain pure. External single-node fixtures also need
`TEST_RABBITMQ_PROMETHEUS_URL` and the isolated `TEST_RABBITMQ_CONTAINER` for these
fault probes; CI configures both and tests the pinned monitoring configuration.
