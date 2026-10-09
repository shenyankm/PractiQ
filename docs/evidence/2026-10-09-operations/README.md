# Isolated deployment evidence

See [the dated report](../../operations-single-machine-20261009.md) for source/image identities, scope and limitations.

- `baseline-supervision.json` and `startup.json`: fixed baseline/candidate configuration, source hashes, quotas and readiness.
- `load-1.json`–`load-3.json`: consecutive warm overload samples from the existing `server/scripts/load_test.py`; additional `load-4.json`/`load-5.json` are separate checks.
- `faults.json`, `startup-rejections.json` and `maintenance.json`: synthetic process/database recovery, verified artifact errors and refusal boundaries.
- `https.json`: certificate-verified loopback laboratory edge.
- `health-proxy.json` and `probes-health-proxy.json`: proxy-disabled readiness regression, actual container probe and final recovery checks after review.
- `backup-restore.json`: database-row/file digests, nonempty grading records, sequence restoration and rollback.
- `resources.json`: cgroup observations after the fifth overload batch; not host RSS.
- `checks.json`, `probes.json` and `image-check.json`: local verification, dependency audit, toolchain and final local image smoke.

The load commands use `--total 40 --submit-concurrency 40 --max-running 4 --graph-concurrency 2 --allow-rejections --environment container` and text `Synthetic recovery question`. The existing recovery provider delays responses by two seconds. The runtime image has no Git executable: the driver's provenance query is supplied the independently verified source SHA. Clients run on Linux-VM loopback outside the service's resource cgroup.

Backup verification stops the only writer, dumps the entire dedicated PostgreSQL database, copies matching files, restores into a newly created database/directory, compares all table-row digests and file hashes, verifies reads/receipt replay/export, and starts the original set for rollback. All identities/content are synthetic. Dumps, local database files, credentials, certificates and keys are excluded from Git. Reports never establish real-model quality or production tail latency.
