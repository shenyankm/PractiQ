# Matching offline backups and fenced recovery

The database, immutable source/artifact files, executable image and private configuration form one recovery set. `scripts/service_backup.py` creates and verifies that set under both existing AI and checkout ownership locks. Stop/drain both writers first; maintenance mode alone does not stop already dispatched calls. The script never starts models, queries a payment gateway, credits points, initializes a replacement database or overwrites a destination.

## Prepare the independent backup host

Use a dedicated, authenticated off-host NFS/CIFS/SSHFS mount, encrypted at rest and in transit, with restricted credentials and independent retention. The scheduled wrapper refuses an unmounted destination and local filesystem types before stopping any service. A path on the application host's own disk is useful for a laboratory drill, but is not disaster recovery. Keep monitoring/Alertmanager outside the failed host too. Never commit bundles: they contain customer data and plaintext service/merchant secrets. Bundles use a mode-0700 directory and mode-0600 files; test that the remote filesystem actually enforces these permissions.

Install PostgreSQL client tools matching the database major version into the trusted scheduler environment. Use an existing Python 3.14+ interpreter with the locked service dependencies, without a project `.venv`. URI passwords and supported TLS options are passed through libpq environment variables, never CLI arguments. Existing trusted libpq settings such as `PGHOSTADDR`, `PGSSLROOTCERT` and passfile configuration remain available, with explicit URI fields taking precedence as in the service connection. URI options without a libpq environment equivalent fail explicitly; configure/test the exact TLS connection before scheduling. Remote database connections still require `sslmode=verify-full` and the deployment's trust material.

Retain the exact runnable image, including the deployed Office engine. Prepare its archive when selecting the deployment, outside the periodic downtime window:

```sh
umask 077
docker image inspect --format '{{.Id}}' practiq-ai:release
docker image save --output /private/practiq-image.tar practiq-ai:release
```

Set `PRACTIQ_BACKUP_IMAGE_ID` to that inspected `sha256:...` image ID, not a mutable tag or an independently looked-up registry digest. The wrapper compares it to the stopped container's actual image. Verification supports classic Docker configuration IDs and modern containerd Docker OCI index/manifest IDs, checks their relationship to the archived configuration, and verifies all archived layer hashes plus every bundle file's SHA-256. Manifest tool metadata describes the backup interpreter/checkout; the retained image is authoritative for the deployed executable. Checksums do not authenticate an attacker-rewritten manifest: accept bundles only from the trusted backup channel. Keep external TLS keys, database role provisioning, RabbitMQ restricted-user/vhost definitions and encryption recovery keys in the independent infrastructure recovery inventory; they are not inferred from an application's `.env`.

## Schedule stopped-writer snapshots

Review and install the [service](../deploy/practiq-backup.service), [timer](../deploy/practiq-backup.timer) and [wrapper](../deploy/backup-offline.sh) on the Linux host. Change `/opt/practiq` to the actual checkout path. Configure `/etc/practiq/backup.env` privately (mode 0600):

```sh
PRACTIQ_PROJECT_DIR=/opt/practiq
PRACTIQ_STORAGE_DIR=/srv/practiq/files
PRACTIQ_BACKUP_ROOT=/mnt/practiq-offhost
PRACTIQ_BACKUP_IMAGE_ARCHIVE=/private/practiq-image.tar
PRACTIQ_BACKUP_IMAGE_ID=sha256:<inspected-image-id>
PRACTIQ_BACKUP_PYTHON=/absolute/path/to/python3.14
PRACTIQ_BACKUP_METRICS=/var/lib/node_exporter/textfile/practiq-backup.prom
# Set both when the independent checkout service is installed:
# PRACTIQ_PAYMENT_UNIT=practiq-checkout.service
# PRACTIQ_BACKUP_PAYMENT_CONFIG=/opt/practiq/.env.payments
```

The scheduler passes the repository-root `.env` explicitly to Compose for interpolation. Before stopping writers it compares the running AI container's full environment with the image defaults plus the saved Compose configuration, then verifies its image, PostgreSQL URL, inherited libpq settings and effective bind-mounted storage root against the backup inputs. Both checkout unit and private configuration must be set together. The selected checkout unit must use that exact required `EnvironmentFile`, use the same effective PostgreSQL URI and inherited libpq settings as the AI service, and have no unit-level `Environment`, `PassEnvironment` or `UnsetEnvironment` overrides. For a running unit, its main process must inherit the saved payment/database settings at exec time; the scheduler reads the private `/proc/<pid>/environ` in memory and rejects stale files, extra payment settings or startup mechanisms it cannot verify. An intentionally stopped unit is checked against its configured environment file and stays stopped. Do not change either private configuration during a snapshot. The check requires the documented Linux host-network profile and an explicit PostgreSQL URL; indirect `PGSERVICE` profiles and bridge-network deployments are rejected because their target cannot be established from these inputs. Correct stale deployment settings or mount paths before retrying.

The service `.env` remains separate from `.env.payments`. `--extra-config` can include additional private configuration snapshots and certificate files; preserve their ordered mapping in the infrastructure inventory. The scheduler must have access to both the correct Compose configuration and the actual persistent host file root. Do not point the host backup at the container-only `/var/lib/practiq` path.

The ten-minute timer attempts complete stopped-writer snapshots; it does not implement continuous archiving or promise a 15-minute RPO. Measure successful snapshot gaps, snapshot age and copy duration at the actual data size. The service stays stopped during the complete dump/copy/hash check, so frequent full copies can consume substantial availability and network/storage capacity. Retain earlier snapshots and incomplete failure directories; investigate and manage retention separately. If this cannot meet the desired availability/RPO, use an explicitly designed database WAL and matching immutable-file replication plan rather than treating `pg_dump` as point-in-time recovery.

The wrapper records a failed/incomplete attempt before mount preflight, stops only writers that were running, and restores their original running state on success/catchable failure. An intentionally stopped service remains stopped. Host loss, SIGKILL and an unresponsive manager require operator recovery. Both ownership locks are held for the complete copy; a live checkout not covered by the selected systemd unit prevents backup rather than allowing an inconsistent snapshot. Verify `/ready` after maintenance and alert on failed restarts. A single systemd oneshot prevents overlapping timer invocations; do not launch concurrent manual wrappers.

Configure the node_exporter textfile collector on loopback and retain the `practiq-backups` job from [Prometheus configuration](../deploy/prometheus.example.yml). For off-host monitoring, adapt its host-local targets through an authenticated private tunnel rather than exposing the backend/exporter publicly. A failed writer restart marks the attempt failed even when the matching snapshot itself was created successfully; its timestamp can still describe a valid retained snapshot. The wrapper atomically publishes `practiq_backup_last_attempt_success` and `practiq_backup_last_success_timestamp_seconds`. Success time is the snapshot start, not copy completion; failures preserve the previous successful time with full Unix-second precision. Missing/stale snapshots (15 minutes), failed attempts and missing exporter scrapes have separate tested rules. A synthetic alert/recovery must reach the real independent receiver before production acceptance. Local rule tests alone do not establish delivery.

## Verify and restore on a clean target

1. Fence the old AI and checkout writers at the host/network/database boundary. Changing DNS or observing an unhealthy container is insufficient. Two separate restored databases do not share advisory locks; keep the old host fenced until rollback or cutover is complete.
2. Select a verified matching snapshot and record the incident time, snapshot start, latest acknowledged changes and recovery start. Copy the complete bundle through the trusted channel; do not mix files from different snapshots. Use the original version/image/configuration for unfinished tasks. Do not bypass execution fingerprints.
3. Run `python -m scripts.service_backup verify --bundle /mnt/practiq-offhost/<snapshot>` from `server/`. Verify image availability before touching the target. Load `image.tar` through the operator's image process and compare the loaded image ID to the manifest. Do not run arbitrary untrusted backup SQL or image archives.
4. Create an empty dedicated PostgreSQL database with the intended owner through administration. Provision a fresh restricted RabbitMQ user/vhost/queues per the [RabbitMQ guide](rabbitmq.md). Keep the checkout service stopped. The restore tool refuses existing database objects, existing file destinations, checksum mismatches, symlinks and mismatched image metadata. Restore failures retain staging files for diagnosis; they do not erase either the source or target.
5. Put the new database URI and target deployment settings in a separate private environment file. Run:

```sh
cd /opt/practiq/server
export AI_MAINTENANCE_MODE=true AI_READ_ONLY=1
/absolute/path/to/python3.14 -m dotenv -f /private/target.env run --no-override -- \
  /absolute/path/to/python3.14 -m scripts.service_backup restore \
  --bundle /mnt/practiq-offhost/<snapshot> --output /srv/practiq-restored
```

6. The new file root is `/srv/practiq-restored/files`. The saved `config.env` and numbered extra configurations remain private snapshots, not active configuration. Review all paths, TLS material, hostnames and credentials for the clean host; never blindly start the old `.env` against the source database. `pg_restore` runs in one transaction with `--exit-on-error --no-owner --no-acl`; the target role owns restored objects. Reapply only the intended restricted database grants.
For the Docker profile, hand off ownership of **only the newly restored files subtree** before starting the service. The default Compose service runs as UID/GID `10001:10001`; confirm the intended deployment identity before using these values. When restore ran as root, run:

```sh
chown -R --no-dereference 10001:10001 /srv/practiq-restored/files
```

Keep `/srv/practiq-restored`, `config.env` and extra configuration snapshots private to the recovery operator. Retain mode 0700 on data directories and 0600 on data files. Set the new `PRACTIQ_STORAGE_DIR` to `/srv/practiq-restored/files` and bind **that subtree directly** to `/var/lib/practiq`; do not mount the parent containing private configuration. Verify an artifact read under the actual service UID before startup. Never apply this handoff to the source storage or backup bundle.

7. First start the original image in read-only mode. Verify `/ready`, all task/run/receipt identities, checkpoints/Store, file hashes, grading records/sequences, account balances/ledger/calls, optional payment evidence, account isolation and saved ZIP CRC/content. Pending/running work becomes explicitly interrupted in read-only startup. Paused/review/unknown work stays stopped. Preserve unknown call/payment evidence and never replay model or payment mutations as a restore check.
8. Record time to verified ready/read/export, failed gates and actual snapshot data loss. Only after fencing and these checks may the operator enable writes or explicitly recover work. Reconcile checkout evidence separately. A restored fresh broker does not contain the old dead-letter history; retain that infrastructure archive when required, and use PostgreSQL run identities plus explicit recovery rather than inventing new task IDs.

RTO ends at verified usable recovery, not the end of `pg_restore`. RPO depends on the actual successful off-host snapshot gap and acknowledged changes lost after that snapshot. Same-host container experiments cannot certify loss of the entire host, off-host accessibility, notification delivery or the production 15-minute/30-minute targets.
