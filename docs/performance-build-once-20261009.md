# Service Web build measurements (2026-10-09)

Service CI built Web in its frontend check step and again through `make image-check`, whose existing `web-build` prerequisite supplies the Docker `COPY`. Remove the first build invocation. Keep Web type, lint, coverage and browser checks, full service verification, the dependency audit, and the final Web/image build. No platform, runtime resource, license or validation step is removed.

Baseline: `5b9210ee5b53b048987d5fe4b87aee50450f0480`. Measurements preceded the workflow edit and compare the exact existing command subsequence `make web-build` followed by `make image-check` with `make image-check` alone. The delivery branch includes production supervision merge `7920df81f7dbf0096eff45c5ab5d61fd5952e8b4`; its Compose/docs/test changes do not change these commands, locks, image source or Web assets. The [raw report](evidence/2026-10-09-build-once/build-work.json) pins those input hashes.

Acceptance: one Web build rather than two, identical complete static assets and platform image content/configuration, repeated improvement exceeding local sample variation, and all applicable CI checks. Risk: a future image target could stop building Web. Keep the Makefile dependency and Docker asset copy together when changing that target. Roll back by reverting this workflow change; no data or configuration migration is needed.

## Method and results

macOS 27.0.1 arm64, 16 GiB host memory, 10 logical CPUs; Node 22.23.2, npm 10.9.8, Vite 8.3.0 and Docker 29.8.2. Locked dependencies and Docker layers were warmed before measurement. A separate real-model evaluation ran in the primary checkout; no other local builds or tests ran during these samples.

Three paired repetitions alternate before/after order in each state. Clean frontend samples remove `web/dist`, Vite cache and Web TypeScript build state. Incremental samples retain them. Dependency, OS and Docker caches remain warm; this does not measure a cold service image or fresh-machine setup. Every command completed successfully.

| Metric | Before | After | Conclusion |
| --- | ---: | ---: | --- |
| Web build invocations per image sequence | 2 | 1 | One redundant build removed |
| Clean frontend median (range), seconds | 1.333 (1.328–1.336) | 0.815 (0.799–0.821) | 0.518 seconds / 38.8% lower locally |
| Incremental median (range), seconds | 1.347 (1.336–1.401) | 0.800 (0.795–0.834) | 0.547 seconds / 40.6% lower locally |
| Complete Web static resources | 1,240,096 B | 1,240,096 B | Every asset hash unchanged |
| Uncompressed Docker image size | 1,233,552,210 B | 1,233,552,210 B | Unchanged in these warm image builds |

All samples have platform manifest `sha256:b58d9b48dc009130153c26b246d78af039f985cc59a22b833c040408198c04ad` and image config `sha256:a0074bd3747cdd3a7624923c0aeede74ac1bd706cecc9807fec5ef2eae9e49e4`. OCI index IDs differ because build attestations contain timestamps. Attestations remain enabled. The first driver incorrectly asserted identical index IDs after 12 successful command sequences; its [excluded raw samples](evidence/2026-10-09-build-once/first-driver-samples.json) are retained, and the complete experiment was repeated with platform-manifest/configuration and static-hash assertions. Do not interpret differing proof metadata as an application-content change or disable proofs to obtain equality.

Reproduce from the selected baseline with Docker and locked Web dependencies installed, using a new output path:

```sh
python3.14 docs/evidence/2026-10-09-build-once/measure_build_work.py /absolute/new-build-work.json
```

The script contains assertions for command success, invocation counts, all static hashes and stable platform image/configuration. Its only change from the measured driver is accepting an output-path argument. It executes both sequences itself, so checking out a baseline and applying a second command variant is unnecessary.

## Validation and limits

The existing CI-scope, package-check and workflow regressions passed locally: 459 tests. `make verify` passed 1,753 tests with 93% combined coverage, lock consistency, Ruff, Pyright, evaluation fixtures, recovery probes and the Python package build. `make web-check` passed types, lint, 55 unit tests and 19 Chromium browser tests using a fake API. `make audit` found no known vulnerabilities in the 91 locked Python dependencies. The twelve paired command sequences include twelve real Docker image builds and eighteen real Web builds. Native macOS/Windows package checks and Android build/instrumentation remain required by the changed workflow and repository gates; their current-head results must be checked before merge.

This record measures a local build fragment. Hosted runner cache state, queueing, service tests and native compiler work dominate overall CI duration and are not represented by these timings. No overall CI speed, initial-load, native-installation, model-quality or production-capacity gain is claimed.
