# Round 4: reuse unchanged task diagnostics

Baseline service/frontend source is current commit 16e47c9; prior app/server rounds do not change web behavior. The production baseline probe found 31 serializations of the same 1,476,634-character diagnostic body over 10 state filters, each about 1–1.2 ms. Candidate wraps the existing Usage component in React memo; JSX, eager initial content, details behavior, fetches and polling remain unchanged. Successful detail fetches replace the task object, so refreshed usage/budget/processing/blocking values still render.

Load: Pydantic-validated 1000-question task, 10000 source associations, 2000 quality issues, one supplied usage entry, authenticated synthetic GET routes. Ten sequential Vite-preview runs, alternating AB/BA source order across five pairs; fresh production Chromium context and a separate localization context per variant. No model calls, user credentials or database. Each variant observes a real 30-second poll.

| Metric | Baseline median | Candidate median | Interpretation |
| --- | ---: | ---: | --- |
| Diagnostic stringify calls over ten filters | 31 | 1 | Direct localized CPU work removed |
| Instrumented diagnostic stringify total | 42.8 ms | 1.2 ms | All five pairs improve far beyond spread |
| Natural GET poll to two RAFs | 21.8 ms | 7.1 ms | Four pairs faster; one 0.4 ms slower; scheduling-limited observation |
| Fresh-context task open | 831.6 ms | 831.6 ms | No reliable speed gain |
| Closed diagnostic filter event/paint | 29.4 ms | 28.6 ms | Noise-scale change |
| Open diagnostic filter event/paint | 29.2 ms | 29.0 ms | Noise-scale change |
| First diagnostic opening | 163.2 ms | 148.7 ms | Frame-aligned spread; no reliable opening speed claim |
| Initial JS/CSS gzip bytes | 105583 | 105595 | +12 bytes, immaterial |

Decision: retain. Primary direct CPU metric improves in every pair; page correctness, passive/authenticated requests and refreshed diagnostics all pass. Browser metrics are separate from the instrumented stringify timings. No service HTTP, native WebView or typical-task end-to-end speed claim is made. High provenance density is a legal synthetic stress case, not a production population estimate.

The new regression failed with repeated diagnostic calls, then App/ResultReviewPerformance tests passed 24/24. Production TypeScript initially rejected a Testing Library test's unsupported exact option; fixed and build rerun passed. The first browser attempt read stale build assets and was terminated; round4-web.json/log are excluded. Only round4-web-valid.json/log and round4-comparison.json are accepted. The runner's asset walk initially returned an empty map because its file test was wrong; round4-assets.json independently repairs inventory after the paired run without rebuild/source change, with source hashes checked. Per-variant served index equality and diagnostic call differences confirm the builds actually exercised during every valid run. The harness file test is corrected for reproduction.

Raw fixture/source/requests/samples are retained with measure_web_usage.mjs. The original `round4-web-valid-candidate.png` captured the production browser; that image was removed on October 17, 2026 and can be recovered from Git commit `6a0ea50`, with its SHA-256 recorded in the [historical screenshot manifest](../screenshots-removed-20261017.sha256). Exact diagnostic JSON, 20-record pagination, 1000-record search, supplied-null answer handling, refreshed usage and GET-only account scoping assertions pass in every context. A read-only reviewer found no memoization/auth lifecycle issue. Final web-check/web-build remain pending.

Final acceptance outcomes and interaction limits are recorded in [README.md](README.md) and [native-interaction.md](native-interaction.md); earlier pending notes above describe the per-round checkpoint.
