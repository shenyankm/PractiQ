# Bounded source quote lookup — 2026-10-20

Once two occurrences of a quoted source fragment are found, the overlap/source-evidence path already considers it ambiguous. Stop there instead of searching the remainder of the normalized source for an unused third occurrence. Match offsets, whitespace normalization, ambiguous outcomes and review flags stay unchanged.

The [raw report](python-source-locations-round2-20261020.json) uses 40,000-character normalized chunks and 1,000 identical lookups per sample, comparing baseline `f5fe3918`. It includes three alternating baseline/candidate pairs with one warmup and seven samples each. Setup, normalization and output checks/hashes are outside timing. Input and result hashes agree.

| Shape | Before / 1,000 calls | After / 1,000 calls | Reduction |
| --- | ---: | ---: | ---: |
| Unique prefix quote | 8.288 ms | 8.220 ms | 0.8% |
| Exactly two prefix matches plus unrelated tail | 8.486 ms | 0.467 ms | 94.5% |
| Absent quote | 8.404 ms | 8.586 ms | -2.2% |
| Repeated quote throughout chunk | 0.496 ms | 0.477 ms | 4.0% |

The gain is specific to the ambiguous-prefix shape: an unnecessary suffix scan disappears. Unique and absent quotes still scan the suffix, and repeated boilerplate already stops quickly. These are local Python CPU measurements, not import/DB/model latency claims. The regression checks exactly two searches, both returned Unicode-aware offsets, and passes with empty or large suffixes; it fails against the old production function. Existing source-proof and ambiguity tests cover callers.

A discarded compact-offset-array candidate reduced source-proof peak allocations but increased CPU time. Its exploratory evidence is kept locally under ignored check reports, outside this PR.

```sh
PYTHONPATH=server/src python3.14 server/scripts/benchmark_source_locations.py \
  --baseline f5fe3918 --output /absolute/path/report.json
```
