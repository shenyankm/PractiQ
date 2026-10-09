# Single-machine PostgreSQL deployment checks — October 9, 2026

The Compose deployment lacked a supervisor and a health check even though the runtime exits on lost database ownership. This change adds `restart: unless-stopped` and a loopback `/ready` probe. Explicit stops still support maintenance and consistent backups. Docker reports unhealthy status but does not restart a merely unhealthy container; investigate repeated failures rather than bypassing ownership.

## Fixed environment and scope

The baseline is `5b9210ee5b53b048987d5fe4b87aee50450f0480`, after the PostgreSQL migration and Web font packaging PRs. The existing image is `sha256:99fdeb72d9c85ce7170e29971c53a2cfc15117dc7740872eb43120839108ed3e`. Every Python source hash matches this baseline. Its bundled Web assets predate the separate font optimization; this report establishes service supervision, not Web packaging acceptance. Baseline and candidate use the same image, database, synthetic source, tools and quotas. [Raw evidence](evidence/2026-10-09-operations/) records configuration hashes and results.

The lab runs Linux containers inside Docker Desktop on an arm64 macOS host. The service has **2 CPUs, 2 GiB RAM and 128 processes**, UID/GID 10001, a read-only root, bounded tmpfs, dropped capabilities and no privilege escalation. PostgreSQL 16 has a separate persistent local volume and a database-owner role with no superuser, create-role or create-database permission. Artifacts use a new absolute host directory. Existing databases, mounts and credentials are untouched.

The tested profile is `N_JOBS_PER_WORKER=4`, `AI_GRAPH_MAX_CONCURRENCY=2`, `AI_PROVIDER_CONCURRENCY=8`, `AI_MAX_BUSY_THREADS=8`, one deployment worker, and synthetic provider RPM 100000. The provider is the existing `server/scripts/recovery_provider.py` with a two-second response delay. This RPM setting avoids measuring a real provider's rate limit; it is not a recommended production limit. All content and credentials are synthetic. No external model calls occur in these deployment checks.

Docker Desktop host networking here exposes Linux-VM loopback, not macOS loopback. HTTP clients run in separate Linux containers. The existing load driver is reused; its Git provenance lookup is supplied the verified baseline SHA because the runtime image contains no Git checkout or executable. Business requests, polling, metrics and pass criteria remain unchanged. The source and configuration hashes identify this limited override.

## Observations

| Scenario | Result |
| --- | --- |
| Baseline process killed | Exited, restart count zero and no health check during a three-second observation; restart policy is `no` |
| Candidate process killed during a dispatched synthetic call | Supervisor restarts; original run ID completes; one dispatched unknown call remains alongside known usage |
| PostgreSQL stopped and restarted | Service fails closed and restarts; completed result and usage remain identical, with no new provider calls |
| Missing / corrupt stored unit artifact | Verified binary read rejects with 404 `OBJECT_NOT_FOUND` / 409 `DOCUMENT_CHECKSUM_MISMATCH`; no new model work |
| Graceful stop | Shutdown completion logged, no OOM; Docker SIGTERM may report exit 143 |
| Invalid worker count / missing token / second instance | Startup fails before accepting requests; the second process cannot take ownership |
| Maintenance | Reads and readiness remain available; upload and new-task creation reject with 503; no new provider calls |
| HTTPS entry | Laboratory Nginx edge verifies a locally issued certificate, forwards authenticated requests, and retains unauthenticated API rejection; backend remains on loopback |
| Health probe with outbound HTTP proxies | Explicitly bypasses environment proxies; a ready service passes while 503 or unavailable loopback fails |
| Consistent backup and restore | Service stopped; full custom-format PostgreSQL dump and matching files restored into a new database/directory; every table-row digest and file hash matches |
| Restored task / rollback | Same run, result, known usage and unknown calls; ZIP export and all four file reads verified; rollback to original database/files starts without model calls |

The backup restores checkpoint, Store, task, receipt and grading tables together, including a nonempty grading receipt/call record and its sequence counter. It uses `pg_dump -Fc --no-owner --no-acl` followed by `pg_restore --exit-on-error --single-transaction` into a freshly created database owned by the service role. Original data and files remain available for rollback. Actual dumps, local databases, certificates, keys and configuration containing credentials are excluded from Git; the evidence retains counts and digests.

Three consecutive warm overload batches each submit 40 small text tasks. Each batch completes eight tasks and explicitly rejects the remaining 32 with 429/503. Pending and running peaks are four each, sampled provider concurrency is four, and all accepted tasks complete. Batch durations are **5.813, 5.777 and 5.724 seconds**. The observed `/ok` sample P95 values are 6.6, 6.1 and 7.3 ms. These are descriptive samples of a synthetic overload drill, not production throughput, capacity for representative documents, or stable tail latency. Cold process startup is excluded. The driver's RSS field is zero because no host PID is provided; it is not a memory measurement. Cgroup observations are recorded separately.

Two additional overload batches retain their own reports and are excluded from this three-sample timing summary. After the fifth batch on the restored service, cgroup `memory.peak` is 244,027,392 bytes (about 233 MiB), with zero OOM events, the 2 GiB ceiling and the documented CPU/process quotas. This measures that synthetic scenario only.

## Limits and first failures

- An eight-second PostgreSQL process pause did not establish immediate service exit. Recovery occurred after unpause; driver cancellation can delay ownership-loss handling when the database cannot respond. The verified stop/restart drill exercises socket loss. Do not interpret the monitor's polling interval as an end-to-end failure-detection guarantee.
- Completed previews can retain a checkpointed result when a unit file is unavailable. Binary integrity rejection is checked through the verified artifact route; paused-unit resume rejection is covered by the existing isolated PostgreSQL regression tests.
- Initial lab setup probes failed on client script location/stdin, startup readiness races, restore URL construction and overly strict exit/preview expectations. They are retained locally and excluded from successful load samples. No real model calls or existing data were involved. The corrected checks verify role, file readability, result integrity and expected error codes.
- Quotas and synthetic queue rejection do not establish Office fidelity, live-model quality or the default 300-task queue's capacity. Run representative documents and the independently budgeted evaluation before sizing an actual deployment. No online deployment, multi-instance availability, clean-machine app acceptance or release is claimed.

## Validation and rollback

`make verify` passed lockfile consistency, Ruff, Pyright, fixture validation, **1,753 tests** after the health-proxy review fix, the 90% coverage gate, recovery probes and package build. The initial run contained 1,751 tests; both results are retained. Combined coverage is approximately **93%**. `make audit` found no known vulnerabilities in the locked Python runtime/development dependencies. These checks use model substitutes. See the [operations guide](../server/docs/operations.md) for startup, alerts, permissions, backup and rollback commands.

`make image-check` also rebuilt the current Web assets/image. The existing `check_container.py` passed inside that final local image under the documented quotas: real PDFium rendering, isolated extractor cleanup, nonprivileged filesystem access and verified persistent artifact storage. Its image identity is recorded separately from the fixed supervision comparison; no build-speed or image-size improvement is inferred from this one build.

Revert the Compose changes to remove supervision/probing; no database migration, contract or storage change is required. An explicit stop must precede switching the database/files/configuration set. Never start overlapping writers or initialize an unknown nonempty database to make readiness pass.
