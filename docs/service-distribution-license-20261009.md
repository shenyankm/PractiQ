# Service distribution license verification, October 9, 2026

The image at baseline `87d1c4055f13988ac22d81f12b7c12d4b8ff4105` had no installed PractiQ license notice or License-Expression. The project license remains MIT. The service now declares SPDX MIT metadata and includes an exact copy of the root notice in its wheel and source distribution. Docker preserves the source notice and the installed distribution copy. No runtime dependency, public contract or model input changes.

[Raw archive/image evidence](evidence/2026-10-09-service-license/distribution.json) records source hashes, archive checksums, all notice paths, unchanged runtime wheel-file hashes and local verification. The archive baseline was exported from the fixed commit; its Git ignore context differs from the working tree, so archive-size differences are not an optimization result. The source notice SHA-256 is `045e49d0a632ea4bf644d1db045d300b313c03097212268a6c3dc15235795079`.

| Boundary | Before | After |
| --- | --- | --- |
| Wheel/source distribution MIT metadata and text | Absent | Present; exact root-license bytes |
| Installed container distribution notice | Absent | Present; matches `/app/server/LICENSE` |
| Runtime wheel source and lockfile hashes | Baseline | Identical |

Validation used macOS 27.0.1 arm64, Python 3.14.7, uv 0.12.13 and resolved Hatchling 1.32.4. `make verify` passed all service tests with 93% combined coverage, including the distribution-copy drift regression. [Actual container smoke](evidence/2026-10-09-service-license/container-smoke.txt) passed as UID 10001 with a read-only root, no network, real PDFium extraction, temporary cleanup and isolated writable storage. Third-party and LibreOffice license ownership is unchanged. The packaging declaration follows [PyPA guidance](https://packaging.python.org/en/latest/guides/writing-pyproject-toml/#license-and-license-files).

Rollback reverts this packaging change and rebuilds the image; database, task, practice and backup formats are unaffected. This report does not claim smaller artifacts, byte-identical images, native interaction coverage or model quality.
