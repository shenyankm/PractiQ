# Import comparison and human correction acceptance — November 6, 2026

Maintainer-approved scope: source comparison/problem navigation and human correction with preserved revisions. Range selection, selective reparse, separate answer-sheet matching and selective export are outside this change. See the [workflow/API guide](../../../server/docs/import-workbench.md).

## Acceptance

| Layer | Result and boundary |
| --- | --- |
| Full service `make verify` | Passed: 3,820 tests, six existing warnings, 93% coverage; lock, Ruff, Pyright, evaluation fixtures, recovery probes, wheel/sdist and source integrity. |
| Focused service regressions | Ten new cases cover protected evidence, tree validation, rich-text structure, real HTTP save/replay/history/versioned export, concurrency, expiry/read-only behavior and source-page authorization. Eighteen read/correction cases passed after completing an old read fixture. |
| Original Web check | Passed: 276 tests, one skipped; TypeScript, ESLint, coverage and production build. |
| Original browser regression | Existing 57 cases and the keyboard focus case passed against production assets. |
| App check | Passed: generated contracts, 542 frontend tests (six skipped), 277 native tests (27 explicitly ignored), formatting and Clippy. |
| Chromium → HTTP → PostgreSQL | Passed with disposable PostgreSQL/RabbitMQ, local files and Tencent/model substitutes. Verified PNG display, stem/rich-text/type/answer/explanation changes, save, full reload and original/revised ZIPs. |
| Isolation and provider work | Original result and usage remain identical; one known substitute model call before/after manual operations. Evidence is unchanged and review flags remain. |
| Same ZIP → native persistence | Revised ZIP SHA-256 `7ee6b65e16d95b27a3c06ad596f99d48b81e3e25950ae6767f4e81d1b4c01c55`: three questions imported, practised, submitted, reopened, backed up and restored with the freshly compiled macOS release Rust test. |
| Layout | Inspected desktop light/narrow dark result views and both editor widths; Chromium found no horizontal overflow. |

[Reports, screenshots and checksums](../../evidence/2026-11-06-import-workbench/) are retained. Full logs are in ignored `server/reports/checks/corrections-*` paths. Screenshots came from bounded visual run 04; final functional run 05 verified behavior without another screenshot set.

## Retained failures

The first helper used native `selectOption` on a Radix control and failed before saving. The next browser/native business assertions passed, but report writing failed because `PRACTIQ_BENCH_OUTPUT` was missing. The identical ZIP passed the native rerun, followed by a complete successful helper run.

The first full service run had 3,816 passes, three failures and 93% coverage: an old read-path test double lacked the newly used `Store.aget`. Completing the fixture passed 18 focused cases; the subsequent full `make verify` passed all 3,820. Earlier logs remain. Unrelated import formatting from an incorrectly rooted Ruff invocation was fully reverted.

## Review fixes: delayed responses and task changes

The reviewer reproduced post-submission input being lost when a delayed response closed the editor, and task selection losing drafts/unconfirmed request IDs.

- Lock editable inputs, Radix selectors and option controls during saves/receipt reads. Uncertain saves keep their submitted draft and original ID; explicit retries reuse that request.
- Register a leave guard at the App task boundary. Draft-only replacement/detail refresh requires discard confirmation. In-flight/uncertain saves block replacement until recovery. Parent mutations use the same guard.
- Existing hidden workspace containers preserve editors during page navigation. Passive original downloads retain drafts.
- A definitive validation/concurrency rejection can unlock input, including on replay. Changed-checkpoint, not-ready and read-only errors preserve previously uncertain request IDs.

Review fixes passed the full Web check (280 tests, one skipped), production build, all 60 production-browser cases, and the actual temporary HTTP/PostgreSQL/native ZIP workflow with substitutes. Controlled browser failures use intercepted HTTP; the separate integration flow uses the real service. Results are recorded in `review-fixes.json` and `review-http-native.json`, preserving original acceptance. No service/native source changed for these fixes.

## Hosted review follow-up

Hosted review found that rereading another writer's revision could replace an uncertain request and silently rebase its draft, and that a definitive rejection on retry left the editor locked. Retain the exact submitted request until resolved. Bind drafts to their starting revision and original answer; adopting a newly read revision requires an explicit action. Definitive validation/concurrency rejections release the request so the draft can be corrected or discarded; state changes that cannot establish the earlier outcome retain it.

Passed the full Web check (286 tests, one existing skip), production build, all 63 Chromium cases and the real HTTP/PostgreSQL/native workflow with substitutes. Six component regressions and three controlled browser cases cover this follow-up. The initial focused browser conflict fixture used a top-level error code instead of the service's `detail.code`; corrected the fixture and passed the full rerun. Original results and provider usage remained unchanged. See `review-fixes.json` and `hosted-review-http-native.json` in the retained evidence. Service and native source remain unchanged.

## Hosted review: normalized-answer replay

A second hosted review reproduced an idempotency failure: a shared-option answer `b` was saved as `B`, then the unchanged request was rejected as conflicting. Replay now reconstructs the question tree preceding that receipt and applies the same validation/normalization before comparison. Later edits removing an old option cannot change replay semantics. Different/invalid answers or another question index still conflict. No contract or storage schema change.

The new real HTTP/PostgreSQL regression failed before the fix and passed afterward, together with all 11 correction tests. Ruff and Pyright passed. Original result and usage remain unchanged, with one substitute model call. The original full local service verification predates this backend fix; latest-head hosted service CI is required before merge. The first test fixture used dicts in a typed constructor; switched it to model validation to satisfy Pyright.

## Limits

No real paid Tencent/model call, extraction-accuracy claim, teacher calibration, Tauri IPC/WebView, installer, signing or notarization acceptance. The native phase uses the release Rust/SQLite test. Historical/Office sources lacking complete images require original-file inspection. Drafts do not survive a confirmed full reload. Revisions expire with tasks; download ZIPs for retention.
