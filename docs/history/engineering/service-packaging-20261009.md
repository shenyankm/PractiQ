# Service packaging and licensing verification (2026-10-09)

This record combines the related distribution-license and source-archive checks. Their original run data and hashes remain in the linked evidence files.

## Distribution license verification

The image at baseline `87d1c4055f13988ac22d81f12b7c12d4b8ff4105` had no installed PractiQ license notice or License-Expression. The project license remains MIT. The service now declares SPDX MIT metadata and includes an exact copy of the root notice in its wheel and source distribution. Docker preserves the source notice and the installed distribution copy. No runtime dependency, public contract or model input changes.

[Historical archive/image evidence](../../evidence/2026-10-09-service-license/distribution.json) records the isolated comparison from `87d1c405` to `e893570e`, with source hashes, checksums, notice paths and unchanged runtime wheel-file hashes. Those archive sizes/checksums identify that historical candidate, not this PR's later composed tree. The baseline was exported from the fixed commit; its Git ignore context differs from the working tree, so archive-size differences are not an optimization result. The source notice SHA-256 is `045e49d0a632ea4bf644d1db045d300b313c03097212268a6c3dc15235795079`.

| Boundary | Before | After |
| --- | --- | --- |
| Wheel/source distribution MIT metadata and text | Absent | Present; exact root-license bytes |
| Installed container distribution notice | Absent | Present; matches `/app/server/LICENSE` |
| Runtime wheel source and lockfile hashes | Baseline | Identical |

The table describes the isolated historical comparison. [Post-review archive evidence](../../evidence/2026-10-09-service-license/post-review-archives.json) was regenerated at `0212b7fbd364e4089a8d09ae6a0eadf56bc242d3`, after composing main through PR #177 and adding the actual package guard. All three fresh-output builds verify the exact source/lock/notice bytes and MIT/License-File metadata in both wheel and source archive, with matching hashes across repetitions. The source archive's member hashes identify the measured input tree; later source revisions require their own package check. No size or build-speed benefit is claimed.

`make verify` now invokes that guard on actual built archives. Eighteen focused archive cases cover valid packages, missing/changed source or lock, missing/changed notices, wrong license expression, absent notice headers and missing project license declarations. A source-copy drift test also preserves equality with the root notice. [Post-review checks](../../evidence/2026-10-09-service-license/post-review-checks.json) pass 1,778 tests with 93% combined coverage. Validation uses macOS 27.0.1 arm64, Python 3.14.7, uv 0.12.13 and resolved Hatchling 1.32.4. [Rebuilt actual container smoke](../../evidence/2026-10-09-service-license/post-review-container.txt) passes as UID 10001 with a read-only root, no network, real PDFium extraction, temporary cleanup and isolated writable storage. Third-party and LibreOffice license ownership is unchanged. The declaration follows [PyPA guidance](https://packaging.python.org/en/latest/guides/writing-pyproject-toml/#license-and-license-files).

Rollback reverts the license declaration/copy and its notice guards together and rebuilds the image, retaining the independent source/lock guards. Database, task, practice and backup formats are unaffected. This report does not claim smaller artifacts, byte-identical images, native interaction coverage or model quality.

## Source archive verification
At baseline `f3b1ecd81ebf0d972858dafa8359f33b3bf10a9b`, `uv build` succeeded in a checkout retaining an ignored historical report symlink to the source directory. The source archive omitted all service modules; its wheel contained only `practiq_ai/uv.lock` and three metadata entries. Hatchling 1.32.4 traversed the linked directory first, and its inode deduplication then skipped the canonical source path. A clean checkout did not reproduce the omission. This is a packaging correctness defect, not a runtime parsing failure. See [Issue #176](https://github.com/shenyankm/PractiQ/issues/176).

Select the existing source, tests, scripts, evaluation fixtures, documentation and deployment directories directly for the source distribution. Retain historical reports and local data in their original directories; they are not package inputs. The source archive supplies the wheel. `make verify` now checks every Python module and the lockfile against both actual archives, plus source project metadata, after the build. Missing or modified content fails verification. The separate service-notice change preserves license inclusion.

[Three raw post-build samples](../../evidence/2026-10-09-service-package/builds.json) used the same primary checkout with the historical symlink preserved, Python 3.14.7, uv 0.12.13 and resolved Hatchling 1.32.4. Every archive contained all 32 current modules and the exact locked dependencies; wheel and source-archive hashes were each identical across all three builds. Output directories were fresh while dependency/OS caches were warm. These observations establish repeated package content on this toolchain, without a size or build-speed claim; the build backend's open version bound remains a reproducibility limit.

The new guard rejects the retained empty baseline wheel. Eight focused archive regressions cover valid archives, missing modules, changed modules and missing locks in wheel/source formats. [Full local checks](../../evidence/2026-10-09-service-package/checks.json) passed 1,761 tests with 93% combined coverage at `09ec2fd`; the later current-base merge retains the independently verified Office/storage change. Latest-head CI and Codex review are required separately before merge. No public API, dependency, model behavior, persistence, backup or practice schema changes.

Rollback reverts package selection and its guard, then rebuilds on the previous toolchain. Never delete retained reports or task data as a workaround for this failure. This report does not claim byte-identical native installers or Docker images.
