# Service build evidence

See the [dated report](../../performance-build-once-20261009.md) for scope, acceptance, environment and limitations.

- `build-work.json`: all twelve accepted timing samples, source/configuration hashes, complete Web asset hashes, image sizes and platform/configuration digests.
- `measure_build_work.py`: assertion-based reproduction driver; run from the repository root with a new absolute output path. Docker and locked Web dependencies must already be installed.
- `first-driver-samples.json`: twelve excluded first-driver observations and the reason for exclusion. The original driver compared timestamped OCI indexes. Its per-command log names were reused by the corrected repetition; the excluded timings are preserved here, rather than claiming those overwritten logs remain available.

Samples distinguish clean frontend cache from incremental cache. Both retain warm dependencies, OS cache and Docker layers. These are local subprocess measurements, not three hosted CI runs or a cold service image measurement. No secrets, model output or user data are included.
