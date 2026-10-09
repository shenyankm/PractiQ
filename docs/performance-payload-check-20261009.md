# Shared payload validation measurements (2026-10-09)

Baseline: `7920df81f7dbf0096eff45c5ab5d61fd5952e8b4`. `ObjectStore.get_verified` and `convert_office` independently compare the supplied bytes with the same strict reference size and SHA-256, using identical 409 error codes/messages. Storage already runs the hash outside the event loop, while the asynchronous Office entry point computes it synchronously. Reuse the existing storage payload-check implementation in both callers, retaining each boundary's checks.

Keep storage path/key, head-size, bounded read and source-size validation in their original order. Keep Office format/mode/timeout and configured-size rejection before payload verification, and engine access/worker creation after it. Each boundary still validates bytes; this change does not trust the prior caller, cache a validation result or skip the second checksum. Model prompts, API, ZIP, checkpoint, database and backup contracts are unchanged. Roll back by reverting this isolated refactor; no migration is needed.

## Method and result

macOS 27.0.1 arm64, Python 3.14.7, same service lockfile and 25 MiB immutable synthetic payload. One warmup precedes three measured repetitions per phase. A 1 ms asyncio heartbeat records scheduling gaps while the real Office source-check entry point runs; the probe stops immediately at its existing engine boundary. No database, Office engine, conversion worker, disk throughput or model call is part of this microbenchmark. An independent real-model evaluation runs in the primary checkout during both paired phases; no local builds/tests overlap the accepted paired measurements.

The [before/after reports and assertion-based driver](evidence/2026-10-09-payload-check/README.md) retain every heartbeat interval, duration, payload/configuration hash and source SHA. Candidate source hashes identify the uncommitted change. An earlier exploratory baseline is retained separately and excluded from this paired comparison.

| Metric, three repetitions | Before | After | Conclusion |
| --- | ---: | ---: | --- |
| Check elapsed median (range), ms | 9.398 (9.381–9.535) | 9.425 (9.422–9.630) | No checksum speed improvement established |
| Maximum heartbeat gap per repetition, median (range), ms | 9.987 (9.844–10.056) | 1.238 (1.178–1.261) | Hash work no longer blocks this event loop |
| Size and checksum checks at each boundary | Both | Both | Preserved; mismatches remain rejected |

Adopt for shared validation and event-loop responsiveness, without claiming higher end-to-end throughput, production tail latency or faster Office conversion. Hashing still consumes CPU and a worker-thread slot; cancellation cannot stop an already executing SHA calculation, but the cancelled request cannot advance to engine/file/worker access.

## Validation

Two new focused regressions first failed on the original synchronous implementation, then passed after reuse: hashing runs on a different thread, and cancellation during hashing does not reach the engine/write boundary. All 79 storage/Office service tests passed, including valid conversions, size/checksum/format/limit rejection, malformed output, timeout, worker cleanup and storage restart/checksum paths. `make verify` passed 1,755 tests with 93% combined coverage, lock consistency, Ruff, Pyright, evaluation fixtures, recovery probes and the package build. Current-head hosted gates and Codex review remain required before merge.

This is a same-service reuse of equivalent logic. Synchronous grading and asynchronous queue connection setup, frontend/native image limits and cross-platform UI code have different semantics and are not merged merely to reduce lines.

Reproduce from the selected source with an existing Python 3.14+ interpreter and a new report path:

```sh
python3.14 docs/evidence/2026-10-09-payload-check/measure_verified_payload.py /absolute/new-payload-report.json
```

Run once at the baseline and once with the isolated candidate, with the same toolchain/configuration and background workload. The driver asserts that all checks finish and stop at the intended engine boundary. The synthetic bytes are deliberately not a real Office file, so this evidence establishes the checksum scheduling effect, not document fidelity or deployed-engine acceptance.
