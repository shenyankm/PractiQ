# Production task-diagnostic measurement

`measure_web_usage.mjs` reuses the existing Web fixtures, Node's built-in TypeScript stripping and installed Playwright. It constructs exactly 1,000 questions (the result contract maximum), 10 saved source associations per question, and two valid quality issues per question. It validates task and preview against current Python Pydantic contracts before launching Chromium. The unusually high provenance count is intentional and must be recorded as a measurement limit.

Build baseline and candidate independently before running. The harness does not build, mutate production sources, call models, or access user databases. Every synthetic API request must be a GET; all private reads must carry the expected phone and synthetic card. A baseline source snapshot must include its fresh `web/dist`; the candidate root supplies the existing dependency runtime and Vite preview configuration.

From the repository root, with the existing Python 3.14+ interpreter selected:

```sh
AI_PYTHON=/absolute/path/to/python3.14 node docs/evidence/2026-10-13-performance-loop/measure_web_usage.mjs /absolute/baseline/root /Users/sheny/Developer/code/PractiQ /absolute/new/web-usage.json
```

Before choosing a candidate, add `--baseline-probe` to run only the baseline preview and one instrumented context. This skips the 30-second wait and does not require a candidate production build. Its latency values are instrumentation evidence only; it records current diagnostic stringify call counts/durations and phase counts. It never substitutes for the five-pair comparison.

Port 18671 must be unused. Run without other timed workloads. Five pairs run serially, with pair order alternating baseline/candidate then candidate/baseline. Each sample launches one local production Vite preview server, a fresh uninstrumented browser context, and a separate localization context. API routes are synthetic; this is rendered production Chromium evidence, not service HTTP or native WebView evidence.

The uninstrumented context records browser event to two animation frames after readiness for cold task selection, five closed-diagnostic task-filter changes, first diagnostic opening, and five open-diagnostic filter changes. It also observes one real 30-second task-list poll while diagnostics are closed; no clock or timer acceleration is used. This adds roughly five minutes across ten versions. Browser timings include frame scheduling and Playwright readiness round trips; stringify duration is recorded separately and must not be presented as an end-to-end gain.

The localization context wraps only the diagnostic `JSON.stringify` shape and preserves the original operation. Its calls/durations and phase counts localize the work; latency values from this context are not acceptance measurements. Both contexts assert exact diagnostic JSON before and after unrelated filters and a changed task refresh, pagination, full-result search, null supplied answers, and authenticated GET-only behavior. Refresh waits for an explicit changed-result marker, then opens diagnostics only if closed; it accepts both remounted and preserved open state. Raw input, source/asset hashes, all samples and request records are saved; a final candidate screenshot is also saved. Startup imports, fixture generation and Pydantic validation are outside measured intervals.

The harness was prepared without running builds, tests, or measurements; only `node --check` and availability of built-in TypeScript stripping were checked. First execution must establish whether the natural-poll and browser readiness assumptions hold; failures remain in the output JSON and must be reported rather than discarded.
