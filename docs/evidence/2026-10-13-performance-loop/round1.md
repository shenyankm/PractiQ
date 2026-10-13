# Round 1: uniform composite-group feasible counts

Baseline: current commit `16e47c9c69bdad410a299ef6d385bfe0beb85dee`, with the same benchmark instrumentation and test-only assertions as the candidate. The baseline executable was copied before the production change. Both optimized binaries use Rust 1.98.1 on the same macOS arm64 host. No concurrent builds, tests or other benchmark jobs were launched during paired timing.

Hypothesis: the existing single-question shortcut can cover every positive uniform group weight while preserving exact feasible counts and the 1,000-answerable-question cap. Empty, zero and mixed weights retain the dynamic-programming path.

| 100,000 roots | Baseline median ms | Candidate median ms |
| --- | ---: | ---: |
| 1 leaves per group | 0.024500 | 0.023042 |
| 3 leaves per group | 88.780666 | 0.025000 |
| 10 leaves per group | 87.503166 | 0.022959 |
| [2, 3] leaves per group | 94.209166 | 92.990125 |

Decision: retain. All five paired improvements for weights 3 and 10 greatly exceed sample variation; input and complete feasible-count output SHA-256 hashes agree across every repetition group and version. The 10,000-unit control changed by 0.001542 ms (microseconds), below the material regression floor of 1 ms; no end-to-end claim is made. The five focused paper tests pass, including exhaustive small subset enumeration and zero/999/1000/1001 boundaries.

See `round1/` for all ten raw worker reports/logs and comparison, `native_compare.py` for exact commands, and `round1-retained.patch` for source/test changes. The timed scope is calculation only; input construction, assertions, output serialization and SQLite fixture creation are excluded. Each process retains the first measured call and two subsequent warm calls; this is not a cold-OS-cache measurement. Existing composite-list controls and assertions also ran. Native IPC, actual WebView, Windows and Android latency remain unmeasured. Final app checks and isolated native interaction validation are still pending.

Final acceptance outcomes and interaction limits are recorded in [README.md](README.md) and [native-interaction.md](native-interaction.md); earlier pending notes above describe the per-round checkpoint.
