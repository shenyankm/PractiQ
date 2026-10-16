# Stability controls and acceptance — October 16, 2026

This batch implements findings 1, 3, 5 and 6 from the full-chain stability assessment: storage readiness/admission, monitoring, load-driver authentication, and Web network deadlines. It does not close the separate temporary-resource sizing, disaster recovery, live-model quality or final-installer workstreams.

Source baseline: `fad0bd78416f025915768248e5f899b17b9271db`. Validation was recorded on `sheny/fix-production-stability` before commit/push. This record claims no deployment or hosted CI result. The final parser/runtime code hash is recorded in the [machine summary](../../evidence/2026-10-16-stability/summary.json).

## Resulting behavior

| Finding | Change | Regression evidence |
| --- | --- | --- |
| 1: storage readiness | Startup, `/ready`, uploads and new run admission verify local storage through the existing bounded I/O pool. Checks coalesce and cache for five seconds, with a two-second probe limit; failed I/O invalidates the cache. Missing/replaced roots, exhausted bytes/inodes, permission failures and failed round-trip/fsync stop admission with 503. | Storage failure injection, concurrent/stuck probes, startup lock cleanup, receipt replay/read preservation, queued pause/resume and failure before the first checkpoint. Stopped work requires explicit resume after recovery. |
| 3: monitoring | Private metrics read durable pending/unknown import calls and their age from PostgreSQL; installed payment schema 3 adds paid-but-uncredited and retained refund-evidence metrics. Rules cover missing/down scrapes, public readiness, storage, durable accounting and container OOM/restarts. | Real database restart/settlement tests, payment evidence/credit tests, official Prometheus firing/recovery tests, config syntax validation. No account, token, order or call IDs in metrics. |
| 5: load authentication | Upload/create/poll use a provisioned test account and phone; a separate service-token client scrapes private metrics. Missing account configuration fails before work begins. | A real ASGI-route integration completes upload → authenticated 202 → queued fake-model work → saved result → checksum-valid ZIP. Mocked transport tests separately assert both credential boundaries. |
| 6: Web requests | Deadlines cover headers and body: ordinary GET/public products 30s, payments 20s, mutations/uploads/artifact reads 125s, ZIP 600s. Aborts release readers/timers. Poll failures use bounded jittered backoff. | Stalled headers/body, explicit disconnect, payment/export deadlines, polling recovery/backoff, and timed-out mutation ID retention without automatic replay. Existing browser flows remain covered. |

Storage sampling cannot atomically reserve future disk space. Existing files remain checksum verified, and subsequent I/O can still fail after a healthy sample. A lost mount is not silently recreated by later probes; verify the original mount/configuration before restarting. Reads remain available only while their own database/file dependencies remain readable.

The refund metric counts retained evidence, not a new review-resolution state. Preserve evidence and handle operator acknowledgement through monitoring; neither scraping nor an alert starts a model, queries a payment gateway or credits points.

## Validation

- Final `make verify`: **2677 passed**, 11 warnings, 503.49 seconds; lock consistency, Ruff, Pyright, evaluation fixtures, the coverage gate, recovery probes, wheel/sdist build and package integrity all passed. Line coverage **6713/7079 (94.83%)**; branch coverage **2385/2648 (90.07%)**. Existing recovery/stop/routing/unknown-usage probe metrics are all 100%; these are deterministic fake-service probes, not live-model quality. All **39** runtime source files match the built packages.

Run from the repository root with `PYTHONPATH="$PWD/server/src" make verify AI_PYTHON=/absolute/path/to/python3.14`; use an existing Python 3.14+ interpreter, without a project `.venv`.

- Web `make web-check`: types, lint and coverage passed; **93 unit/component tests**, **27 browser checks**. Line coverage **97.46%**, branch coverage **87.41%**. `make web-build` passed.
- `make alerts-check`: passed all seven scenario groups, including service/exporter absence, storage bytes/inodes, durable unknown/pending calls after counter reset, payment state, OOM/restarts and recovery. The example Prometheus config passed syntax validation. The identical new fixtures fail against the original baseline rules, confirming that the tests detect the missing alerts.
- Final image build: `docker build -f Dockerfile.server -t practiq-ai:stability-20261016 .` passed. The isolated Linux arm64 smoke ran as UID/GID 10001 with a read-only root, 2 CPUs, 2 GiB RAM, 128-process ceiling and no network. It passed real PDFium extraction, temporary cleanup, MIT notice checks and verified artifact storage. Removing storage write permission produced a failed health probe and 503 admission while saved bytes remained readable; restoring permission recovered health. Image and source hashes are in the summary.
- Focused final queue/admission tests: **6 passed**. They include a task stopped by storage failure before its first checkpoint: original identity retained, explicit resume offered, no automatic model work, and one successful fake-model call after explicit recovery.
- `git diff --check` and final source review: recorded after full validation. No schema, dependency lock, shared payload contract or offline App change.

The first full service run was deliberately interrupted after review found the pre-checkpoint recovery boundary. Its partial coverage/probe reports are superseded and do not count as acceptance. The final full run is the one reported above.

Raw logs, coverage XML and probe outputs are retained under the locally ignored `server/reports/checks/stability-20261016/`. They are local evidence, not publicly uploaded artifacts. The tracked summary records commands, hashes, counts and limitations.

## Deployment handoff

1. Drain old work before changing the executable. Keep the old image, complete database, matching files and configuration for rollback; execution fingerprints remain strict.
2. Follow [storage readiness and monitoring installation](../../../server/docs/operations.md#storage-readiness-and-admission). Merge the example into existing Prometheus, replace its public domain, provide private credentials and verify the loopback exporters/Compose labels.
3. Configure the actual Alertmanager receiver and confirm a synthetic firing/recovery notification. Local rule tests do not certify notification delivery or public TLS reachability.
4. Provision a separate existing load-test account with explicit budget before any real-model load run. The new driver does not bypass account serialization, storage limits or billing controls.

## Not checked

No production configuration, real notification receiver, paid model call, payment-gateway transaction, 24-hour representative load, host failover or final signed App package was exercised. Local engineering acceptance of these four fixes does not establish production SLOs or model extraction quality.
