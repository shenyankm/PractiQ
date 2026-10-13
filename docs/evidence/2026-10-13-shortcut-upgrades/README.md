# Evaluation and review-queue upgrades

Baseline: `736eb0c7cca8c519e3de6cd8fb458d415e9b40bc` (PR #224).
Both measurements used Python 3.14.7 on the same macOS arm64 host. All inputs are synthetic; no model or external service was called.

| Workload | Before | After | Result |
| --- | --- | --- | --- |
| Match 1,000 gold questions against reversed predictions | 324.38 ms median | 7.42 ms median | 43.7× faster |
| Read 10,000 metadata-only review events, 1,477,780 bytes | 12,508,906 bytes peak Python allocation | 5,244,728 bytes | 58.1% less allocation |
| Read 10,000 review events with ignored synthetic fields, 46,637,780 bytes | 58,409,882 bytes peak Python allocation | 5,252,600 bytes | 91.0% less allocation |
| Metadata-only review workload, including JSON/Markdown output | 41.73 ms median | 39.62 ms median | No material speed improvement |
| Review workload with ignored fields, including output | 93.26 ms median | 100.07 ms median | 7.3% slower in this measurement |

The evaluation index increases peak Python allocation from 1,046,020 to 1,916,918 bytes (about 0.83 MiB extra). The review queue still retains one metadata record per unique run for deduplication. Streaming removes the full raw-event list, not that necessary metadata.

Each timing is the median of five runs without allocation tracing. A sixth run measures peak allocations using `tracemalloc`; this is not process RSS. Startup imports and synthetic-input construction are excluded. The review measurement includes file reads, validation, selection and report serialization. Full verification was running in the background, so small timing differences are not conclusive. These are local tooling measurements, not end-to-end import or production throughput claims.

The complete evaluation and review outputs have identical SHA-256 hashes before and after. The benchmark asserts deterministic outputs, 1,000 correctly matched answers, 10,000 observed runs, and omission of synthetic private content. Regression tests cover competing aliases, duplicate occurrence order, missing/extra questions, one normalization per input question, streamed input, and late malformed JSON leaving no output files.

Reproduce with an existing Python 3.14+ interpreter, from the repository root:

```sh
cd server
PYTHONPATH=src:. "$AI_PYTHON" ../docs/evidence/2026-10-13-shortcut-upgrades/benchmark.py /tmp/shortcut-result.json
```

To reproduce the baseline, use the same benchmark file with the two `server/scripts/` files from the baseline commit in a separate checkout. Compare `outputSha256` in both result files before interpreting timings. Raw measurements are in [before.json](before.json) and [after.json](after.json).

The other debt entries remain deferred. In particular, database serialization, PDFium locking and repair-evidence restrictions protect existing boundaries; this change does not establish a safe reason to relax them. App paging and caches require their own measured workloads.

Acceptance on this host: the two affected test modules passed all 125 tests. Full `make verify AI_PYTHON=...` passed all 2,116 tests with 93% coverage, lockfile checks, Ruff, Pyright, 33 evaluation fixtures, fault probes and wheel/sdist validation. The benchmark passed its self-checks and a separate Ruff check. App/Web interaction checks and real-model evaluation were not run because this change affects only offline service tooling.
