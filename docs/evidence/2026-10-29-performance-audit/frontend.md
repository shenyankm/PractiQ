# Frontend performance review

Baseline: `2099f77a`. The review assumes one desktop user and sessions capped at
1,000 questions. It followed the render and request paths below; it was not a
line-by-line audit of every frontend component.

| Path | Finding and decision |
| --- | --- |
| `app/src/Practice.tsx`, `api.ts` | Each current-answer edit recomputed every saved answer-card state. A matching draft traversed its items three times, even when it belonged to another question. Reuse states while `session.attempts` and exam mode are unchanged; compute the current draft separately. Cache untranslated message keys so language changes still update button labels. |
| `app/src/Content.tsx`, `asset-urls.ts`, `SessionProgress.tsx` | Markdown is memoized, assets load near the viewport and share mounted consumers, and clocks update in isolated components. No additional cache or timer changes. |
| `app/src/StudySetup.tsx` | Search reads are delayed, lists/scores are paged by 30, and statistics can share a page read. Remaining scans are bounded; no measured reason to complicate them. |
| `web/src/App.tsx` | Polling pauses off the records page or when hidden, completed tasks use head checks, failures back off, and diagnostic expansion is lazy. Keep freshness and failure handling. |
| `web/src/ResultReview.tsx`, `api.ts` | Questions/resources are paged by 20; derived indexes and quality JSON are memoized. ZIP export already builds its Blob from bounded chunks. Artifact reads retain checksum validation. No duplicate optimization. |

## Reproduction and measurements

Run the opt-in benchmark from the repository root:

```sh
PRACTIQ_PRACTICE_BENCH=/tmp/practice.json npm --prefix app exec -- vitest run --root app src/PracticePerformance.test.tsx -t 'measures typing'
```

For the baseline, extract `git archive 2099f77a app shared` into a temporary
directory, copy the same benchmark file there, and link its `app/node_modules`
to the installed locked dependencies. Run the benchmark from that temporary
`app` directory with the installed `node_modules/vitest/vitest.mjs`. Do not
temporarily replace source files in an active checkout.

The retained pair ran sequentially on macOS arm64 with Node 22.23.2. Each workload
mounts three times and performs 15 input changes per mount. It uses one current
short-answer question and 19 or 999 other partial matching drafts, each with 100
items. The samples include full synchronous input-event-to-React-commit work in
the development build under jsdom. Native IPC, browser layout and hardware input
latency are excluded. The first implementation attempt exceeded the default
5-second benchmark timeout during concurrent testing; the opt-in benchmark now
allows 20 seconds. Only the final isolated pair is reported below.

| Workload | Before median | After median | Observation |
| --- | ---: | ---: | --- |
| 20 questions: input to commit | 1.934 ms | 1.865 ms | Small difference; no claim of a meaningful latency gain. |
| 1,000 questions: input to commit | 7.126 ms | 3.825 ms | 46.3% lower in this local synthetic workload. |
| 1,000 questions: React render duration | 5.568 ms | 2.122 ms | 61.9% lower. |
| Other-question item reads per edit (20 / 1,000 questions) | 57 / 2,997 | 0 / 0 | Deterministic removal of repeated item traversal. |

Raw samples, environment, input hashes and complete answer-card text hashes are
in [practice-before.json](practice-before.json) and
[practice-after.json](practice-after.json). Both workloads have identical input
and rendered-text hashes across the pair. Session inputs remain unchanged.
Source identity metadata was added after the measurements: the retained isolated
baseline matches `2099f77a`, both directories contain byte-identical benchmark
files, and the candidate is the final message-key cache implementation. Each raw
report records the full baseline commit, `Practice.tsx` SHA-256 and common probe
SHA-256; timing samples were not changed or rerun.

## Correctness and scope

`PracticePerformance.test.tsx` verifies saved-draft reuse, current-draft updates,
replacement session attempts, navigation, language changes and folded answer-card
reopening. The new regression fails on the baseline with 57 unexpected item
reads and passes after the change. Existing `ContentPerformance`, `PracticeFeedback` and `i18n` suites
cover empty drafts, submission/failure recovery, scoring states and keyboard
navigation. The four-file run passed 71 tests with the opt-in benchmark skipped;
the benchmark passed separately. App TypeScript and ESLint checks passed.

The cache lives only for the mounted answer card and is invalidated by replaced
session attempts or exam mode. It does not change persistence, grading, native
commands, contracts, credentials or request triggers. The main assumption is
React's existing immutable session replacement; in-place mutation of attempts
would not invalidate the cache. Native database flows, real providers, end-to-end
browser timing and every shared UI primitive were not profiled in this sub-review.

## Browser acceptance follow-up

The first full browser run passed 149 tests and failed the sidebar/practice test
at `check-i18n.mjs:346`, waiting for **Collapse sidebar**. Its retained trace shows
the first **Start practice** button detached at trace time 28,724 ms, followed by
a second `[vite] connecting...` at 28,889 ms, `[vite] connected.` at 28,990 ms and
the React development startup message. The document reloaded before practice
mounted, resetting the expanded sidebar to its narrow-window default. The trace
establishes this reload sequence, but not what triggered the Vite reload.

No production or test change was made for this failure. The unchanged candidate
passed the focused test three consecutive times; the isolated `2099f77a` baseline
passed it once. The isolated baseline emitted a KaTeX font serving warning from
its symlinked dependencies, so that run is evidence for this interaction only.
The first failure screenshot, context, trace and full log remain in
`/tmp/practiq-perf-first-browser-failure`; the candidate focused rerun log is
`/tmp/practiq-perf-current-practice-browser.log`.
The subsequent complete `--project=mocked` run passed all eight tests in 29.2 s
without code changes (`/tmp/practiq-perf-app-mocked-browser.log`). This is a
targeted project rerun following the initial 149/150 result, not a second full
150-test run.
