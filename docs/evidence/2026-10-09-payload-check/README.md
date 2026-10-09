# Payload-check evidence

See the [dated report](../../performance-payload-check-20261009.md) for scope, acceptance, rollback and limits.

- `before.json` / `after.json`: three accepted warm-buffer repetitions per phase, every heartbeat interval, source/lock hashes and timing summaries.
- `measure_verified_payload.py`: real entry-point probe with an explicit stop before engine/worker access; uses no model, database or deployed Office engine.
- `exploratory-before.json`: earlier unpaired discovery measurement, preserved but excluded from the paired result table.

This microbenchmark does not represent a cold file read, Office conversion throughput or production capacity. Configuration uses an unused synthetic credential solely to construct the existing settings object; no credential or request is sent anywhere.
