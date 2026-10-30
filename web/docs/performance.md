# Frontend work-count regressions

## Metadata previews and saved practice statistics (October 30)

Web detail and preview reads retain their existing lifecycle, polling, failures
and checkpoint controls. The client opts into `include_result=false` for previews,
so a merged result's questions/groups/visuals travel in detail only. The review
reuses that detail content when checkpoint IDs match; source-only units still
render, and a mismatched metadata preview cannot lend its provenance to detail
questions. Full previews from older services and unmerged partial units retain
their existing rendering path. Export still requires a fresh matching preview.

The practice answer card caches saved status counts and progress with its saved
states. Draft edits adjust only the current question's contribution; no status
array copy or per-status scans are needed. The closed completion dialog also
reuses its saved-attempt counts. Submitted/skipped precedence, false answers,
empty drafts, fixed status order and all answer buttons remain unchanged.

`ResultReview.test.tsx`, `App.test.tsx`, `api.test.ts`, `ContentPerformance.test.tsx`
and `AnswerCardStatus.test.tsx` cover these boundaries. The opt-in answer-card
probe records complete output hashes, noncurrent answer reads and React/JSDOM
render durations, including small controls. See the
[acceptance record](../../docs/history/performance/read-paths-20261030.md) for raw
paired measurements and limits; these are not native WebView latency guarantees.

These optimizations remove redundant work without changing task APIs, result
contracts, persistence, or explicit paid-action boundaries. They add no dependency
or additional cache layer.

## Import Web

- Only a previously read `COMPLETED` detail uses the lightweight head check.
  Noncomplete details are read directly: pending writes and interrupts must not be
  inferred from an unchanged checkpoint.
- Focus, document visibility and returning to the records workspace wake the
  existing pollers. An unchanged completed head reuses detail and preview.
  First reads, explicit refresh/retry and successful task controls still force
  detail and preview reads.
- Import and settings workspaces stop records polling. Poller closures and mounted
  result components survive workspace switches, retaining task selection, list
  cursors/filter, result search/filter/page and expanded question details. Returning
  immediately refreshes the list and selected task; task controls remain disabled
  until detail freshness is confirmed. A visible wake arriving during a read is
  retained and checked immediately after that read settles, rather than waiting
  for the next polling interval. Already-started reads may finish, but hidden
  successful responses are discarded and do not trigger a follow-up preview.
- Task diagnostics use the existing first-expansion pattern from `QuestionRecord`.
  Native `details`/`summary` semantics remain unchanged. Before expansion, no usage
  totals or diagnostic JSON body are computed. Once loaded, the body survives
  closing/reopening and updates with subsequent task details, including unknown
  usage and provider request IDs.

`web/src/App.test.tsx` supplies deterministic mocked-HTTP/fake-clock evidence:

| Scenario | Verified work after the change |
| --- | --- |
| 20 focus/visibility wakes, unchanged completed task | 20 heads, zero additional detail/preview reads (previous implementation forced 20 of each full read) |
| Ten polling rounds for RUNNING, PAUSED, WAITING_REVIEW, FAILED and INTERRUPTED | Ten details per state, zero heads (previous implementation added ten heads per state) |
| 60 seconds in either other workspace, including 20 focus/visibility event pairs | Zero additional task reads; returning starts one list and one direct active detail read immediately |
| Five changed details before expanding diagnostics | Zero diagnostic serializations and no diagnostic `pre` element |
| First diagnostic expansion, close/reopen, then changed detail | One initial serialization, none on reopen, one for the changed detail |

Tests also cover changed checkpoints, runs, state, timestamps and model settings;
head failures disabling export; explicit refresh/control behavior; in-flight reads
finishing while hidden; result and list state retention; focus restoration; and
unchanged GET-only behavior for passive actions. Existing API/result tests retain
authentication, checksum and rendering safeguards.

### View-owned artifact reads

Image and source-evidence viewers cancel their authenticated artifact read when
unmounted (including leaving the resources tab or resource page) or when the
client, task ID, or any reference field changes. Equivalent reference objects
from subsequent checkpoints retain the loaded view. Cancelled reads cannot publish
stale images, evidence, or error messages; a new identity requires an explicit
read. Reload/retry remains explicit, and replaced/unmounted image object URLs are
revoked. Original-source and ZIP downloads are not cancelled by viewer cleanup.

`web/src/ResultReview.test.tsx` and `web/src/api.test.ts` use synthetic stalled
responses: abandoning either viewer aborts the fetch signal, cancels the body
reader once, releases its lock, and performs zero SHA-256 calls. Tests also cover
header-stage cancellation, deadline cleanup, fresh reads after cancellation,
StrictMode, complete reference/client/task replacement, late publication, explicit
reload/retry, and unchanged MIME/byte/hash rejection. Cancellation prevents further
body buffering; it cannot interrupt a Web Crypto digest already in progress.
These are deterministic work/lifecycle assertions, not browser throughput or
memory measurements.

### Quality JSON during resource paging (October 29)

`ResultReview` formats the selected quality report through its existing React
memoization pattern. The memo depends on the report reference, selected tab and
quality disclosure state, so paging source associations does not format the same report again. The question
tab performs no quality serialization, including when a fresh report arrives.
Opening resources alone does not format the report. Expanding Quality record or
changing the report while expanded refreshes the text; collapsed updates do not. Preview
quality retains priority over task-processing quality. The JSON text, resource
pagination, task APIs and explicit artifact-read actions are unchanged.

`ResultReview.performance.test.tsx` checks preview and task-only inputs in
StrictMode: opening Sources performs zero quality serializations; expanding the
quality record formats it twice (StrictMode's initial double invocation), and
three page changes perform no further serialization. The test also verifies changed/hidden reports, exact text,
unchanged DTOs and zero network calls.

The [raw report](../../docs/evidence/2026-10-29-review-quality/web.json) compares
baseline `125dae03a9594bd8892818819982df578412e87c` with the candidate using the same
probe and locked dependencies. Three alternating pairs use isolated Vitest/React
development/JSDOM processes, one warmup and seven samples per case/process.
Timers surround only the native `JSON.stringify` call for the chosen quality
object. Setup, scheduling, DOM work, assertions and hashing are excluded; all
input and complete visible-text output hashes match. This does not measure
browser input latency, frame rate, memory or end-to-end import performance.

| Questions / tab / page updates | Quality formats before / after | Native stringify total median ms before / after |
| --- | ---: | ---: |
| 20 / sources / 0 | 1 / 1 | 0.0050 / 0.0060 |
| 1000 / sources / 10 | 11 / 1 | 3.1151 / 0.2691 |
| 1000 / questions / 10 | 0 / 0 | 0.0000 / 0.0000 |

Large inputs have 1,000 reviewable questions, 2,000 quality issues and 1,000 source
associations. The sequence opens resources and advances ten pages. The small
control opens a 20-question report without paging; the hidden control advances
question pages and never opens resources.

Final checks and the initial setup failure are recorded with this phase's PR.
The first browser run used a dependency symlink outside the checkout: Vite's file
allow list rejected KaTeX font requests. Each checkout then received its own
unchanged locked dependencies with `npm ci`; no product filesystem policy was
relaxed. First-failure logs, screenshots and trace remain under
`/private/tmp/practiq-web-quality-first-browser-failure/` on the validation host.

To repeat the probe, put this same test file in isolated baseline and candidate
checkouts with matching locked dependencies, then alternate the following command
three times per variant using fresh output paths. The normal suite runs its
functional cases and skips only the opt-in timing case.

```sh
(cd web && PRACTIQ_BENCH_OUTPUT=/tmp/review-quality.json \
  node node_modules/vitest/vitest.mjs run src/ResultReview.performance.test.tsx \
  -t 'quality serialization probe')
make web-check web-build
```

## Practice App frontend

`answerState` now returns unanswered for a null draft only after skipped/submitted
states have been handled. The answer-card buttons reuse the already computed state
array. False answers and incomplete non-null drafts still take the original
validation path; saving and grading behavior are unchanged.

`app/src/ContentPerformance.test.tsx` uses a 1,000-attempt fixture: one current short
answer and 999 null matching answers with 100 items each. Initial rendering and
21 typed characters perform zero matching-item-array reads; only the current
answer button changes its rendered state. Making one noncurrent matching answer
partial performs three item-array reads for one state calculation, rather than
six from the former duplicate calculation. The null short-circuit also avoids
all item copies for the other attempts.

`AnswerCardStatus.test.tsx` verifies false, partial, null, skipped and submitted
states, keyboard jumps, current-button focus, and compact card collapse
and help-dialog focus. Historical Android Back/draft checks are retired; macOS native lifecycle retains draft
persistence coverage. These are JSDOM interaction/work-count tests, not physical
Android/WebView or browser-layout measurements.

## Reproduce focused checks

With existing locked frontend dependencies installed:

```sh
(cd web && node node_modules/vitest/vitest.mjs run src/App.test.tsx src/api.test.ts src/ResultReview.test.tsx)
(cd app && node node_modules/vitest/vitest.mjs run src/AnswerCardStatus.test.tsx src/ContentPerformance.test.tsx src/AnswerInput.test.tsx)
(cd web && node node_modules/typescript/bin/tsc -b && npm run lint)
(cd app && node node_modules/typescript/bin/tsc -b && npm run lint)
```

The assertions count work rather than claiming production latency, memory or
battery gains. They make no live service/model/Tencent calls and use no user data
or credentials. Full combined verification, browser/device profiling and package
builds are separate checks.
