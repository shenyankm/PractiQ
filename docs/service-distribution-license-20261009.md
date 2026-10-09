# Service distribution license verification, October 9, 2026

The image at baseline `87d1c4055f13988ac22d81f12b7c12d4b8ff4105` had no installed PractiQ license notice or License-Expression. The project license remains MIT. The service now declares SPDX MIT metadata and includes an exact copy of the root notice in its wheel and source distribution. Docker preserves the source notice and the installed distribution copy. No runtime dependency, public contract or model input changes.

[Historical archive/image evidence](evidence/2026-10-09-service-license/distribution.json) records the isolated comparison from `87d1c405` to `e893570e`, with source hashes, checksums, notice paths and unchanged runtime wheel-file hashes. Those archive sizes/checksums identify that historical candidate, not this PR's later composed tree. The baseline was exported from the fixed commit; its Git ignore context differs from the working tree, so archive-size differences are not an optimization result. The source notice SHA-256 is `045e49d0a632ea4bf644d1db045d300b313c03097212268a6c3dc15235795079`.

| Boundary | Before | After |
| --- | --- | --- |
| Wheel/source distribution MIT metadata and text | Absent | Present; exact root-license bytes |
| Installed container distribution notice | Absent | Present; matches `/app/server/LICENSE` |
| Runtime wheel source and lockfile hashes | Baseline | Identical |

The table describes the isolated historical comparison. [Post-review archive evidence](evidence/2026-10-09-service-license/post-review-archives.json) was regenerated at `0212b7fbd364e4089a8d09ae6a0eadf56bc242d3`, after composing main through PR #177 and adding the actual package guard. All three fresh-output builds verify the exact source/lock/notice bytes and MIT/License-File metadata in both wheel and source archive, with matching hashes across repetitions. The source archive's member hashes identify the measured input tree; later source revisions require their own package check. No size or build-speed benefit is claimed.

`make verify` now invokes that guard on actual built archives. Eighteen focused archive cases cover valid packages, missing/changed source or lock, missing/changed notices, wrong license expression, absent notice headers and missing project license declarations. A source-copy drift test also preserves equality with the root notice. [Post-review checks](evidence/2026-10-09-service-license/post-review-checks.json) pass 1,778 tests with 93% combined coverage. Validation uses macOS 27.0.1 arm64, Python 3.14.7, uv 0.12.13 and resolved Hatchling 1.32.4. [Rebuilt actual container smoke](evidence/2026-10-09-service-license/post-review-container.txt) passes as UID 10001 with a read-only root, no network, real PDFium extraction, temporary cleanup and isolated writable storage. Third-party and LibreOffice license ownership is unchanged. The declaration follows [PyPA guidance](https://packaging.python.org/en/latest/guides/writing-pyproject-toml/#license-and-license-files).

Rollback reverts the license declaration/copy and its notice guards together and rebuilds the image, retaining the independent source/lock guards. Database, task, practice and backup formats are unaffected. This report does not claim smaller artifacts, byte-identical images, native interaction coverage or model quality.
