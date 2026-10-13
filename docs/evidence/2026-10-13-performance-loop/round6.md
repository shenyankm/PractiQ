# Round 6: move export preparation off the event loop

Baseline is the current-workspace snapshot at commit `16e47c9c69bdad410a299ef6d385bfe0beb85dee`; earlier service changes affect chunk merging, not the exporter. Paired source SHA-256 values for `bank_export.py` are `4e4f031c82156dc5e9f3bc598c3f0ef54c2ee4174be8e215b4c4475ebc18176c` before and `b85558fdd02df5336c890530627e17e4d44e92e1bf20694c64fd35082924bf0d` after. Baseline localization found 65.6–72.8 ms in result/processing validation and input dumps, plus 18.6–19.7 ms in output dumps/serialization. These separately instrumented phases are localization clues, not paired acceptance samples.

Hypothesis: reusing the existing cancellation-safe `_thread_io` for the unchanged validation, serialization, package limits and resource-reference checks reduces event-loop stalls. Candidate extracts that sequence into `_prepare_bank`; readiness, source namespace and bank metadata checks remain before preparation. No archive exists until preparation finishes. ZIP writing, verified storage reads, image validation, permissions and compression remain unchanged. Cancellation waits for the preparation thread, including repeated cancellation, before the export slot can be released.

Fixed load: 1,000 rich choice questions with supplied/null answers and nested content, ten material groups, source associations and quality issues. The source is 4,666,638 bytes. The no-resource case produces 4,752,767 bytes of questions JSON; the image case produces 4,753,572 bytes and includes one immutable 2048×1536 PNG of 9,441,806 bytes, referenced twice but packaged once. No real model calls or user data.

Five alternating AB/BA pairs per case use separate sequential fresh Python workers. Each worker performs three complete exports: the first measured call is separate from two warm calls. A 1 ms async heartbeat records maximum scheduling gap minus the requested sleep. Fixture creation, storage writes/fsync and independent ZIP inspection are outside timing; source/resource reads and checksums, image verification/loading and private ZIP construction are inside. macOS 27.0.1 arm64, Python 3.14.7, Pydantic 2.13.4 and Pillow 12.3.0; `PYTHONHASHSEED=0`, `PYTHONOPTIMIZE=0`. Worker environment and source/harness hashes are recorded in the raw report.

| Workload / metric | Baseline warm median ms | Candidate warm median ms |
| --- | ---: | ---: |
| No resources: maximum event-loop stall | 113.180 | 34.654 |
| Image: maximum event-loop stall | 106.256 | 38.030 |
| No resources: complete export wall time | 122.379 | 114.440 |
| Image: complete export wall time | 131.958 | 133.963 |

Decision: retain for responsiveness. Every stall pair improves: 65.2–72.7% without resources and 63.7–66.1% with the image. Warm stall ranges are disjoint: 107.1–126.8 / 32.3–39.4 ms without resources and 104.4–113.9 / 36.1–39.4 ms with the image. Median reductions are 69.4% and 64.2%. Complete-export wall changes vary in sign across pairs; no reliable throughput improvement is claimed. The image median is 1.5% slower, within overlapping measured variation, with no reproducible material wall-time regression.

First measured call medians are separately 94.660 / 92.704 ms wall and 85.521 / 17.598 ms stall without resources; 112.075 / 115.364 ms wall and 85.372 / 19.788 ms stall with the image. Fresh workers do not imply cold OS files, and imports/fixture creation are excluded; these are not service-startup measurements.

All 60 complete sample archives and input fingerprints match across versions. Assertions check byte-identical manifest/questions/resources and whole ZIP SHA-256, unchanged source task data, CRC, declared resource checksums, deduplication, deterministic entry order and 0600 entry permissions. The added regression first failed because preparation ran on the event-loop thread, then `round6-regression.log` records 66 passing export tests. It checks that repeated cancellation waits for preparation and that neither a private archive nor storage reads begin. Existing tests cover partial/null/tree preservation, namespace and checksum rejection, budgets, image limits, stale snapshots, cancelled ZIP writers and HTTP export-slot ownership. A read-only review found no new error, snapshot or cancellation issue.

Raw paired results and localization are in `round6-export.json`; commands/environment are implemented by `export_compare.py`; the retained source/test diff is `round6-retained.patch`. Reproduce the recorded paired run from the repository root with the saved baseline snapshot:

```sh
/Users/sheny/.local/share/uv/python/cpython-3.14-macos-aarch64-none/bin/python3.14 \
  docs/evidence/2026-10-13-performance-loop/export_compare.py \
  --baseline /var/folders/1b/b19xbzjx7xqc4kl0k9x_y4y80000gp/T/practiq-perf-loop-qrdu2192/baseline \
  --candidate /Users/sheny/Developer/code/PractiQ \
  --pairs 5 \
  --output docs/evidence/2026-10-13-performance-loop/round6-export.json
```

The baseline path is a temporary snapshot, so preserve or reconstruct its recorded source hashes before reproduction. Earlier probe/localization artifacts are investigative only; the accepted comparison is `round6-export.json`. The first localization attempt failed fixture validation and contributes no measurement; the corrected runner validates the fixture before timing.

Real local ObjectStore/export and event-loop scheduling only. Database snapshot lookup, account authorization, HTTP transfer/network, desktop import and WebView interaction are outside the measurement. The CPython GIL and timer scheduling still leave 35–38 ms median maximum stalls; offloading does not eliminate them. HTTP cleanup/ownership is covered by regression tests, not an HTTP latency benchmark. Final `make verify` remains pending.

Final acceptance outcomes and interaction limits are recorded in [README.md](README.md) and [native-interaction.md](native-interaction.md); earlier pending notes above describe the per-round checkpoint.
