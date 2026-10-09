# Service build-tool selection (2026-10-09)

Baseline build configuration: `3bf252dd4f9e79bd44c08aa8c30d97bb26762b38`. Runtime/development requirements were already locked, but isolated package builds requested `hatchling>=1.27` with unbounded backend dependencies. Pin the existing measured backend and its unconditional Python-3.14 dependencies; [issue #178](https://github.com/shenyankm/PractiQ/issues/178) records the dependency decision before implementation. No runtime dependency, API, schema, model input/output, platform or package resource is removed.

| Build dependency | Selected version |
| --- | --- |
| Hatchling | 1.32.4 |
| packaging | 26.3 |
| pathspec | 1.1.1 |
| pluggy | 1.6.0 |
| tomlkit | 0.15.1 |
| trove-classifiers | 2026.9.21.13 |

`build-system.requires` pins Hatchling. Existing [uv build constraints](https://docs.astral.sh/uv/reference/settings/#build-constraint-dependencies) restrict the other packages without introducing runtime dependencies. The constraints are recorded in `uv.lock`. Conditional `tomli` for Python below 3.11 is outside the supported Python 3.14+ graph; no optional backend extras are requested. Future backend dependency changes require deliberate constraint updates and ordinary checks. Other build frontends are not validated to apply uv-specific constraints. `make server-install` now runs from `server/`, like locked installs, Docker and package builds. An impossible `pathspec==999999` diagnostic is refused for both build and install from that directory; invoking install from the repository root had ignored project uv constraints, which motivates the caller fix.

Measured composed source: `2878ecad830b213010c4ca9d08853e01258a5a38`, including the merged package-source and license guards. Environment: macOS 27.0.1 arm64, Python 3.14.7, uv 0.12.13. Three builds use fresh output directories and populated dependency/build and OS caches: 2.938/0.619/0.505 seconds. No build-speed improvement is claimed. Each wheel/source archive contains all 32 Python modules, the exact lock and MIT notice, with SPDX metadata checked by `check_package.py`. All three wheel hashes equal `e08e2f5e49dcdd22eb62a38d722a814938177872d9f43dda03d8c1d8f5cb5b33`; all three source archive hashes equal `a1b2dc180a5caf5006b71b9330971cb5298d7cf20c87c2f085c1f2e00d71a75e`. Each source-archive member hash is retained. Subsequent documentation changes are outside `server/`, so these archive inputs stay unchanged.

[Evidence](evidence/2026-10-09-build-tools/README.md) also includes an isolated PEP 517 diagnostic that observes all six selected distribution versions with the exact service build requirements/constraints. It substitutes only an observing backend entrypoint; actual production archives above use Hatchling. Runtime/dev requirements and their hashes are identical before/after, excluding the generated export-command comment's different output path.

`make audit` retains the original complete hashed runtime/dev scan and adds a separate strict no-dependency scan of the six already-required exact build pins. A failed scan stops the target. Separate scans preserve the existing hash-bearing requirement file: appending unhashed build requirements to it failed and was corrected before delivery. Five audit command cases verify success, either Python scan's failure, and existing Cargo failure propagation; two existing install cases now also assert the service working directory. The build graph uses version constraints rather than downloaded-archive hashes; the runtime/dev export retains its hashes.

`make verify` passes 1,779 tests and 93% combined coverage, including locks, Ruff, Pyright, fixtures, recovery probes and package build. `make audit` reports no known vulnerabilities for both sets at capture. `make image-check` also builds the actual Docker image; its separate hardened smoke runs without network access as UID 10001 with a read-only root, writable temporary directories and a dedicated artifact mount. It verifies actual PDFium rendering, isolated extraction/cleanup and storage reads. Earlier smoke setup omitted required model configuration and failed closed. The final-image first invocation omitted the external check script mount; the corrected read-only script mount passed. Both setup failures remain local; no product workaround was introduced.

The execution fingerprint hashes complete `uv.lock` bytes. Adding build-constraint metadata therefore changes the fingerprint even though runtime package versions are unchanged. Drain before upgrading; retain the original image, database, artifact files and configuration for unfinished-task recovery. Resume rejects mismatched fingerprints rather than silently migrating state; [operations](../server/docs/operations.md) documents this boundary.

Roll back by reverting the backend pin, uv constraints/lock metadata and additional audit scan together. Keep runtime hashes, all existing checks and package-content verification. This freezes one supported build dependency graph; it does not make Debian packages, OCI attestations or native installer metadata byte-reproducible, and it is not a service deployment or release acceptance claim.
