# Round 5: linear quota ordering

Baseline is the retained rounds1–2 paper code with current valid quota regression and an identical preview workload. Each worker constructs temporary 10k/100k banks with contiguous true_false/short_answer categories, fixed IDs and a fixed random seed7. Core native method: preview_paper selecting500+500 complete roots. Count20 ordered/random requests are regression controls. Setup, independent expected-ID reads, request decode, checks and final report serialization are outside timing.

Hypothesis: selected IDs can be collected into the already imported standard HashSet and reconstructed in original roots order, avoiding repeated roots.iter().position inside sorting. Sorted quota-key validation and errors remain unchanged. The final variant borrows roots and clones only chosen IDs; roots lifetime remains as before.

| Workload | Baseline median ms | Final candidate median ms |
| --- | ---: | ---: |
| 10k roots, ordered quota1000 |49.474|35.680|
| 100k roots, ordered quota1000 |311.142|188.398|
| 100k roots, seed7 random quota1000 |202.639|202.143|
| 100k roots, ordered count20 |165.796|167.041|
| 100k roots, seed7 random count20 |167.032|166.933|

Decision: retain final borrowed-roots variant. All five ordered quota pairs improve (~39.4% at100k), well above spread. Count20 medians differ by0–0.8%, within measured variation; random100k quota has no confirmed gain. Complete output SHA-256, selected IDs/order, supplied answer payloads, integer scores, digest and deterministic random assertions match every repetition and version. Seven paper tests pass, including interleaved/late categories, complete reading groups, zero/unavailable quotas and existing snapshot/score behavior.

Rejected experiment: the first owned roots.into_iter variant showed ~35% target gain but repeated count20 ordered control medians regressed7.3% (165.52→177.54ms), so it was withdrawn. Original and repeated raw measurements are in round5/ and round5-control-repeat/; its patch is round5a-rejected.patch. The final variant's five pairs are round5b/, with source/test patch round5-retained.patch. The observed control regression motivated preserving the old root-vector lifetime; no cause such as compiler code generation is asserted without a profile.

Native Rust/SQLite only, warm local files and process first/warm samples; no picker, IPC, actual WebView or Windows/Android speed claim. Final app-check and isolated native interaction are pending.

Final acceptance outcomes and interaction limits are recorded in [README.md](README.md) and [native-interaction.md](native-interaction.md); earlier pending notes above describe the per-round checkpoint.
