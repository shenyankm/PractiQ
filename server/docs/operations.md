# Operate the open-source LangGraph service

The runtime uses a single FastAPI/Uvicorn process, open-source LangGraph, and local SQLite. It requires neither Agent Server, Redis, nor a LangSmith runtime license. Parsing, subjective grading, and infrastructure costs are separate. This guide covers startup, backup, recovery, and maintenance for the independent service; see the [project overview](../../README.md) for desktop data management.

## Initialize and start

Use an existing Python 3.14+ interpreter without a project `.venv`. Startup commands load the root `.env`; process environment variables take precedence. `AI_DATABASE_DIR` identifies a dedicated local-disk directory, defaulting to `server/.local/database` in source checkouts. Deployments must use an absolute persistent path. Old `DATABASE_URI` settings prevent startup. Existing PostgreSQL data and volumes remain unchanged, and historical tasks are not automatically migrated. Unknown nonempty SQLite databases cannot be initialized.

Install uv, complete the [configuration steps](service-guide.md#run-locally), then run from the repository root:

```sh
make install-locked AI_PYTHON=/path/to/python3.14
make init-db AI_PYTHON=/path/to/python3.14
make server-dev AI_PYTHON=/path/to/python3.14
```

`make server-dev` starts one Uvicorn process on `127.0.0.1:8090` with persistent local SQLite files. Missing or incompatible databases prevent startup; there is no in-memory fallback. Python registers graphs directly, without `langgraph.json` or the LangGraph CLI server.

`Dockerfile.server` builds the production image with Python 3.14, PDFium, and Chinese fonts. Linux ECS deployments use host networking. The container listens on `127.0.0.1:8000` by default, behind a host HTTPS reverse proxy. Do not expose database or application backend ports. `deploy/nginx.conf` is a host-loopback HTTP proxy example; a trusted upstream entry point provides TLS.

Size resources using representative documents, model latency, and concurrency tests. Historical capacity reports do not guarantee current deployment capacity. Do not use multiple Uvicorn workers, scale-to-zero function instances, or overlapping rolling replicas.

## Data and migration

Keep matching database, file, and configuration backups:

- `tasks.sqlite` stores tasks, runs, and idempotency receipts. Official SQLite persistence components manage `checkpoints.sqlite` and `store.sqlite`. Connections enable WAL, FULL synchronization, foreign keys, and a five-second busy timeout. Network filesystems and multiple service processes are unsupported.
- `subjective-grades.sqlite` stores grading request IDs, digests, and responses. It is created on the first grading request. Independent-service backups must preserve it to retain replay records. It is outside the document queue and is not cleaned by document-task cleanup.
- New service instances use a local file root. The historical default name `.local/ai-oss` remains; production must use an absolute persistent mount. Old tasks, checkpoints, and files stay in their original environment. Old state stores are neither automatically migrated, deleted, nor reused.
- Local uploads and asset reads retain authentication, size, and SHA-256 checks.
- Finish old tasks on their original version before changing storage, code, models, or semantic configuration. Do not bypass execution fingerprints. Database credentials do not belong in graph state or logs.
- Stop both service and maintenance processes before backing up the entire SQLite directory and matching file storage, including any WAL files. Restore matching data on the same version. Copying only a running database's main file is unsafe. A single instance does not promise host-level high availability.

### Upgrade after OSS removal

Storage now uses local files only. The OSS SDK, credential configuration, and cloud cleanup logic have been removed. Old `AI_STORAGE_BACKEND=oss` settings fail explicitly. An unset variable or the value `local` selects local storage. The historical `.local/ai-oss` directory name prevents existing local files from becoming inaccessible. The desktop's old `oss_url` column remains for backup compatibility but is not read or written as connection configuration.

On old OSS deployments, finish unfinished tasks with the original version, stop the service, and back up. Manually copy source and derived files to a persistent local directory using their original objectKeys. Verify sizes and SHA-256, set an absolute `AI_STORAGE_DIR`, remove `AI_STORAGE_BACKEND` and `AI_OSS_*`, and create new tasks with the new version. Do not resume old tasks after execution fingerprints change. Keep the old deployment, bucket, database, and configuration for rollback. Upgraded code does not access or delete cloud files.

## Queue, pause, and recovery

`N_JOBS_PER_WORKER=8` limits active tasks within the process. `AI_GRAPH_MAX_CONCURRENCY=2` limits parallel units per task. `AI_DEPLOYMENT_WORKERS` must be 1. Requests return 202 after task/queue transaction commit. A database uniqueness constraint permits only one pending/running run per thread. Duplicate requests return the original receipt. New requests exceeding `AI_MAX_BUSY_THREADS=300` return 503.

The process holds a standard-library `flock` lock; a second instance cannot start. Do not delete or replace the lock file. The kernel releases the lock on a crash; replacement of the lock file stops the process. A supervisor handles restart. Database failures do not permit continued admission or a hidden in-memory queue fallback.

Unexpected restarts resume unfinished runs with their original IDs, deadlines, budgets, and unknown usage. A completed checkpoint only needs terminal-state repair. Manually paused, explicitly interrupted, and `WAITING_REVIEW` tasks do not resume automatically. Shutdown stops admission and waits at most 60 seconds, leaving unfinished tasks recoverable. Service managers must allow at least 65 seconds for termination.

Each run defaults to 1,800 seconds. Explicit resume creates a new run; crash recovery does not reset its deadline. A task may reserve at most 400 model calls by default. Unused reservations, failed calls, and unknown calls are not refunded. Each unit permits at most four model attempts and two manual retry rounds, using the existing error classifications.

Successful checkpointed units are reused. A provider request that completed before its result was persisted may be repeated; unknown usage remains recorded. Exactly-once provider calls are not guaranteed. Pause does not forcibly cancel accepted remote requests, and canceling a local wait does not terminate an underlying synchronous thread.

## Configuration and observability

See the [configuration template](../../.env.example) for all variables. Limits include 25 MiB source files, 100 pages, vision/text budgets, strict inputs, extraction timeouts, PDFium mutual exclusion, provider concurrency, and requests per minute (RPM). Monitoring boundaries:

- `GET /ok`: public liveness check returning only `{"ok":true}`.
- `GET /ready`: returns 200 when the database, exclusive-lock monitor, and scheduler are available, otherwise 503, without sensitive details.
- `GET /api/metrics`: Bearer-authenticated stage, call, and result metrics, including `practiq_pending_runs`, `practiq_running_runs`, `practiq_workers_max`, and `practiq_workers_available`. The native `/metrics` endpoint is unavailable.
- `GET /api/maintenance`: reads maintenance configuration. `AI_MAINTENANCE_MODE=true` rejects uploads and new runs while retaining reads and pause/cancel controls; queued work continues draining.
- `provider_concurrency_wait`, `provider_rate_wait`, and `provider_request` distinguish local waits from SDK request duration. SDK duration is not pure model inference time.
- Logs and metrics exclude document text, images, credentials, and raw error details. Unknown usage does not mean zero cost. Reconcile provider billing with persistent call records separately.

`deploy/alerts.rules.yml` covers partial results, unknown usage, budgets, checksums, queues, and latency. `SUCCEEDED` does not establish semantic quality; clients must still inspect `processing.quality`.

## Grading recovery boundaries

`POST /api/subjective-grades` handles one question synchronously, outside the document queue. Maintenance mode rejects grading, but already dispatched model calls may finish. Grading reuses shared model limits, retries, and usage accounting. Document-task retention of 180 days, the 400-call task budget, and run deadlines do not govern grading.

Process interruption may leave a registered grading request without a result. Replaying its ID returns `unknown`; the service does not call the model again automatically. Only explicit regrading with a new ID starts another request. Preserve unknown usage and reconcile it against provider billing. The service does not automatically clean grading caches; plan their retention separately.

Desktop ZIP backups include exams and saved scores, but exclude the service cache and API keys. Full service backups and desktop bank backups serve different purposes and cannot replace each other.

## Retention and cleanup

Document tasks remain valid for 180 days. Startup does not automatically delete expired state. Drain and stop the service, set `AI_MAINTENANCE_MODE=true`, and run with the same configuration:

```sh
cd server
python -m practiq_ai.manage cleanup-state
```

The command obtains the same exclusive lock and deletes only expired tasks without active runs. It clears checkpoints and Store through their official APIs, then deletes business records. It can resume after interruption. During maintenance, no other program may write the same database/storage.

The file script connects directly to SQLite and defaults to read-only inventory:

```sh
python scripts/storage_gc.py --output /absolute/new-inventory.json
```

Load configuration into the shell first. Inventory covers retained tasks, complete checkpoint history, and Store. Any read failure stops the operation. Retention defaults to at least 187 days. `--quarantine` requires maintenance mode after draining and stopping the service. The exclusive lock prevents concurrent startup. The script persists a recovery manifest before moving files into `.quarantine/<runId>/` within the same root; it does not delete original file contents.

## Verify recovery and capacity

`make verify` uses temporary SQLite files and model fakes, without external model calls, PostgreSQL, or Docker databases. Independent-process tests cover forced termination, unknown calls, and human-review recovery.

Start the service, then run this load test from the repository root:

```sh
cd server
python -m dotenv -f ../.env run -- python scripts/load_test.py \
  --base-url http://127.0.0.1:8090 \
  --text '1. What is 2 + 2? A. 3 B. 4 Answer: B' \
  --total 20 --submit-concurrency 5 --output reports/new-load.json
```

The load driver supports only the document business API. Load tests/evaluations connected to real models incur costs and require separate planning. Historical Agent Server, Redis, licensing, and capacity reports remain historical evidence, not acceptance of the current runtime.

## Recovery and resource-boundary fixes on 2026-09-19

This record preserves the behavior and upgrade requirements of that repair:

- Control transactions queue before acquiring a connection. Recovery file prechecks run outside the global lock, with run/checkpoint state checked again before enqueueing. Execution prechecks share the graph's persistent run deadline.
- Pause and human review use separate checkpoint nodes. Failure review and result-quality review both resume a pause before applying a review decision. Upgrades invalidate old execution signatures; use the original deployment to recover old tasks or create new tasks.
- Extraction runs in an isolated process group. Timeout/cancellation terminates and reaps it, including converter children. The parent cleans temporary directories. Storage uses a separate bounded thread pool. Wait timeout does not release an active I/O slot; a full pool waits within bounds, then returns `OBJECT_STORE_UNAVAILABLE`. Capacity returns when underlying work ends.
- `AI_UPLOAD_TIMEOUT_SECONDS` limits total binary-body reception to 120 seconds by default, including continuous but excessively slow transfers. Timeout returns 408 / `UPLOAD_TIMEOUT` and releases the upload slot. Adjust for actual network/file conditions.
- Startup configures INFO logging and a JSON handler for `practiq.events`, restricted to existing allowlisted fields. Queue alerts compare pending + running against `practiq_queue_capacity` on the same instance, using actual `AI_MAX_BUSY_THREADS`.
- Initialization first marks an empty database as belonging to this service. Known partially initialized databases can retry. Unknown nonempty and fully initialized databases remain rejected. Business DDL and marker removal commit atomically. Historical partial databases without the marker are not automatically adopted.
- GC completion uses a same-directory temporary file, fsync, and atomic replacement. A failed final update preserves the original recovery manifest. `completed=false` does not prove files are unmoved; reconcile the manifest with quarantine contents.

### Upgrade local storage paths

In source checkouts, relative `AI_STORAGE_DIR` always resolves from `server/`, independent of the working directory. Wheel installations require absolute paths; the Docker default is `/var/lib/practiq`. Older versions incorrectly resolved relative paths from the repository root. If that old directory contains data, the new version fails explicitly rather than silently switching roots.

Record the original absolute directory before upgrading. Set `AI_STORAGE_DIR` to it to retain the location. To migrate, stop and back up first, manually copy files to the new persistent directory, verify objects/checksums, then change the absolute path. Keep the old files/configuration for rollback. The service does not move, delete, or automatically change permissions on existing files.

### Unprivileged container deployment

The image uses UID/GID `10001:10001`. `server/deploy/service.compose.yml` supplies Linux host constraints: 2 CPUs, 2 GiB memory, 128 processes, a read-only root, all capabilities dropped, privilege escalation disabled, and init-based child reaping. Only `/var/lib/practiq`, bounded `/tmp` tmpfs, and `/home/practiq` are writable. Extraction temporary files use these locations.

Set `PRACTIQ_STORAGE_DIR` to a verified absolute host directory and ensure UID 10001 can read/write it. Do not recursively change existing mount permissions automatically. Use an existing dedicated group/ACL or manually copy to a new dedicated directory while preserving rollback data. SQLite lives at `/var/lib/practiq/database` within the persistent mount. Remove old `DATABASE_URI` from `.env`. Host networking exposes the service only on `127.0.0.1:8000`. Validate with `docker compose -f server/deploy/service.compose.yml config --quiet`, then start in an authorized deployment environment. These resource quotas are starting values; validate against representative documents and concurrency.

Desktop mode leaves unfinished tasks interrupted after restart and makes new model calls only after an explicit Resume action. The independent server resumes the original run automatically. Desktop ZIP backups exclude the AI task directory.
