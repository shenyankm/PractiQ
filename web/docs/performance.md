# Frontend work-count regressions

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
states, keyboard jumps, current-button focus, and compact Android card collapse
and help-dialog focus. `AndroidNavigation.test.tsx` retains Android Back/draft
persistence coverage. These are JSDOM interaction/work-count tests, not physical
Android/WebView or browser-layout measurements.

## Reproduce focused checks

With existing locked frontend dependencies installed:

```sh
(cd web && node node_modules/vitest/vitest.mjs run src/App.test.tsx src/api.test.ts src/ResultReview.test.tsx)
(cd app && node node_modules/vitest/vitest.mjs run src/AnswerCardStatus.test.tsx src/ContentPerformance.test.tsx src/AndroidNavigation.test.tsx src/AnswerInput.test.tsx)
(cd web && node node_modules/typescript/bin/tsc -b && npm run lint)
(cd app && node node_modules/typescript/bin/tsc -b && npm run lint)
```

The assertions count work rather than claiming production latency, memory or
battery gains. They make no live service/model/Tencent calls and use no user data
or credentials. Full combined verification, browser/device profiling and package
builds are separate checks.
