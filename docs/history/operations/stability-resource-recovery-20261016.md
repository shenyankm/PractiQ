# Temporary resources and service recovery — October 16, 2026

This batch implements stability assessment findings 2 and 4, following [findings 1, 3, 5 and 6](stability-controls-20261016.md). Baseline: `846829ed38fa78bc211ec721a1af2d588df2af5b`. Work is on `sheny/fix-resource-and-backup-recovery`. Validation uses disposable databases, generated media and fake models. No production deployment, paid call, gateway transaction, commit or push is claimed by this acceptance record.

## Changes

- Preprocessing and ZIP export share a 384 MiB scratch reservation budget. One preparation slot covers isolated extraction and Office conversion. ZIPs reserve 302 MiB until the response/file closes; preparation reserves its source/output ceiling, with bounded waits and explicit resumable interruption on `TEMPORARY_BUSY`. Office also samples complete workspace usage, including profiles/intermediates, and stops above 300 MiB. Compose active tasks drop from eight to two under the unchanged 2 GiB/512 MiB tmpfs profile. No source limits, payload contracts, billing rules or execution-fingerprint checks are weakened.
- Offline backup holds both existing AI and checkout ownership locks and saves the full custom-format database dump, matching immutable file tree, private service/optional checkout configuration and actual docker-save image archive. Every file is hashed; image identity validation supports classic Docker and OCI IDs and checks every layer. Restore verifies the complete bundle before mutation and requires a new file destination plus a dedicated database without tables, routines, types or custom schemas. Failed work remains available for diagnosis; no original data is overwritten or deleted.
- A Linux scheduler example refuses an absent/non-network backup mount, preserves deliberately stopped services and restarts only previously running writers after success/failure. Its independent textfile metrics preserve the last verified snapshot time on failure. Alert rules cover failed/incomplete attempts, absent/stale snapshots and absent exporter scrapes. [Operator instructions](../../../server/docs/service-backups.md) cover private configuration, independent retention, fencing, clean-target recovery and explicit model/payment boundaries.

The resource reservation is an admission policy, not a universal native-memory bound. Office workspace size is sampled rather than atomically quota-limited; the tmpfs/cgroup remain the hard outer boundaries. A long-held ZIP can interrupt preparation after its bounded wait; the user must resume explicitly after resources return. The fixed budget deliberately rejects incompatible larger deployment limits. Full offline backup requires downtime and copies the complete image/data set; measure actual data size and availability cost before scheduling.

## Validation

Final counts, source hashes, commands and retained raw-log hashes are recorded in the [machine summary](../../evidence/2026-10-16-resource-recovery/summary.json).

- Final `make verify`: **2702 passed**, including all **25** new regressions. Lock consistency, Ruff, Pyright, evaluation fixtures, coverage, recovery probes and package checks passed. Line coverage: **6804/7174 (94.84%)**; branch coverage: **2400/2666 (90.02%)**. All **40** runtime source files match the wheel/sdist. Recovery/stop/routing/unknown-usage probe rates are 100% with the matching final fingerprint; these are deterministic fake-service probes.

- Three consecutive mixed-pressure batches passed in one process/event loop: **9** bounded rejections and **6** successful explicit retries. Peak `/tmp` use was **262,230,016 bytes (250.08 MiB; 48.84% of quota)**. Whole-cgroup peak memory was **1,019,019,264 bytes (971.81 MiB; 47.45% of quota)**, with **zero OOM/kill events**. These are short synthetic batches, not a 24-hour stability claim.
- The fenced clean-cluster drill preserved **22 tables and 265 rows**, the grading identity sequence, file inventory, account isolation and saved ZIP CRC/content, without additional model calls. Both source files and the source PostgreSQL service were unavailable during recovery. Timings are in the machine summary and refer only to the measured laboratory phase.
- `make alerts-check` passed **9 scenario groups**, including absent/failed/stale backup detection and recovery, plus Prometheus example-config syntax. Four scheduler cases passed, including actual dotenv environment precedence, intentionally stopped writers, failure restart and off-host mount rejection. libpq credential/TLS/address forwarding has a separate red/green regression; it is not a remote TLS handshake test.

The container pressure check uses Linux arm64, UID/GID 10001, two CPUs, 2 GiB RAM, 128 processes, a read-only root, a 512 MiB `/tmp` tmpfs, dropped capabilities, no privilege escalation and no network. The deployed LibreOffice engine is `LibreOffice 7.4.7.2 40(Build:2)`. Each generated workload includes a 19,045,863-byte PDF producing 48,546,605 bytes of page images, a 25,247,576-byte valid OOXML source containing near-limit binary padding, and a 262,229,636-byte CRC-checked ZIP containing 250 MiB of valid WAV resources. Padding stresses source/copy budgets; it is not a representative Office document-complexity benchmark.

The slow-reader condition retains the actual archive file beyond the preparation wait. Two preparation attempts and another export must return `TEMPORARY_BUSY`; closing the archive permits two explicit preparation retries through real PDFium and LibreOffice. Existing HTTP response regressions separately verify download completion/disconnect cleanup. This is synthetic component overlap inside the real container, not a network throughput or live-model benchmark. The script records whole-cgroup memory peaks/OOM counters and temporary-filesystem peaks, including child processes and tmpfs.

The database drill first compares every public table row and the grading identity sequence, then restores into an empty target, verifies the same rows/files, starts the service read-only and exercises authenticated task/account reads and saved ZIP CRC validation. It includes completed and paused tasks/checkpoints/Store, account tokens/balances/ledger, a durable unknown call, grading receipt/call data, and optional paid/refund evidence. No model or payment replay occurs. A separate retained drill substitutes the actual image archive, stops the disposable source PostgreSQL container before restore and uses a new PostgreSQL instance. Both instances still run on the same Docker host. Its restore/readiness/export phase timing excludes infrastructure provisioning, incident detection and image transfer, and is not a production RTO.

Earlier fixture/CLI setup failures and the earlier full verification are retained separately. Only the final full gate, final pressure series and final fenced drill count as acceptance; incomplete runs do not establish success. Raw logs and the frozen drill hook live under locally ignored `server/reports/checks/resource-recovery-20261016/`; no customer data, real credentials, database dumps or image archives are tracked.

## Reproduce the bounded checks

Run the normal full gate with an existing Python 3.14+ interpreter:

```sh
PYTHONPATH="$PWD/server/src" make verify AI_PYTHON=/absolute/path/to/python3.14
make alerts-check
docker build -f Dockerfile.server -t practiq-ai:resource-recovery-20261016 .
```

For `server/scripts/check_temporary.py`, mount `app/fixtures` read-only at `/fixtures` and the scripts at `/checks`; use the quotas above, a new writable UID-10001 local storage volume at `/var/lib/practiq`, and a UID-10001 64 MiB `/home/practiq` tmpfs. Set `AI_READ_ONLY=1`, a synthetic `AI_SERVICE_TOKEN`, `N_JOBS_PER_WORKER=2`, and the explicitly inspected `AI_OFFICE_EXECUTABLE`/exact `AI_OFFICE_VERSION`. Invoke the script with the image's Python. A series calls its async `main()` three times within the same `asyncio.run()` event loop. The asserted synthetic gates are OOM=0, tmpfs peak at most 80%, whole-cgroup memory peak at most 80%, bounded rejection, explicit retry success and no leftover preparation directories.

Focused regressions are `test_temporary.py`, the archive-budget case in `test_bank_export.py`, the resource-stop case in `test_stability.py`, `test_service_backup.py` and `test_backup_scheduler.py`. Run from the repository root with `PYTHONPATH="$PWD/server/src"`. The disposable-database fixture alone starts PostgreSQL/RabbitMQ; pure budget/archive/manifest/scheduler tests do not start infrastructure.

## Deployment boundary

Drain old work and retain its original image, database, files and configuration before upgrading; strict execution signatures still apply. Review the ten-minute backup example against actual downtime and backup volume. Configure the trusted off-host mount, infrastructure recovery inventory and an independent receiver/monitor, then verify permissions, a scheduled successful copy, an injected failure/stale alert and notification recovery at that receiver.

Not exercised: physical host loss or a truly separate machine/site, production off-host mount/encryption/retention, installed systemd scheduling, real notification delivery, public TLS cutover, 24-hour representative mixed traffic, real-model quality, live payment settlement and final signed App packages. A ten-minute timer and a small local restore do not certify the proposed 15-minute RPO, 30-minute RTO or monthly availability SLO. Those remain deployment acceptance gates.
