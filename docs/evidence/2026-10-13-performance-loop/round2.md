# Round 2: saturated mixed-group subset paths

Baseline is the retained round-1 implementation; candidate only changes selection_paths termination. Same release compiler, machine, fixed input and benchmark probe. The smallest positive eligible weight is computed across the entire input before processing, so later smaller groups cannot be missed. Sums below it are impossible. Once zero and every sum from that minimum through the target are populated, later roots cannot improve or overwrite any path.

Acceptance constraints: complete feasible-count and full preview hashes must agree; exhaustive subset results and distinct ordered exact selections must pass; all five target pairs must improve by more than target variation. Controls are treated as a material regression only if reproducibly above both noise and 5% (or 1 ms for sub-millisecond workloads).

| Workload | Baseline median ms | Candidate median ms |
| --- | ---: | ---: |
| 10000:[2, 3] feasible counts | 9.547041 | 0.376792 |
| 100000:[2, 3] feasible counts | 93.282000 | 0.460250 |
| 100000:count:random=False full native count-20 preview | 168.532458 | 170.872625 |
| 100000:count:random=True full native count-20 preview | 170.040708 | 171.691042 |

Decision: retain. Target improves in every pair, with byte-identical outputs and >96% reduction at 10k / >99% at 100k roots. Full count-20 preview controls differ by 1.0–1.4%, below the observed run spread and the 5% material threshold; no full-preview improvement is claimed. Computing a global minimum adds one linear pass, but output/backtracking order remains unchanged. All six paper tests pass, including all small 0..3 vectors up to length six, selected-index/sum constraints, future-smaller weights, zeros and 1000-count bounds.

Raw five-pair results: `round2/` and `round2-preview-controls/`. Exact commands are in `native_compare.py`; build/test logs preserve both source roots. The latter baseline is an isolated source copy with round-1 production code plus identical current benchmark/test instrumentation. Input/selected-ID/answer/score/digest assertions pass in every native preview call, including ordered and seeded-random quota controls. Timings exclude fixture setup, assertions, final serialization and expected-output reads, but include the complete Store::preview_paper method. OS/SQLite caches are warm; IPC, WebView and device latency are excluded. Final app checks and native interaction remain pending.

Final acceptance outcomes and interaction limits are recorded in [README.md](README.md) and [native-interaction.md](native-interaction.md); earlier pending notes above describe the per-round checkpoint.
