# Answer display performance, October 20, 2026

`AnswerDisplay` normalized and cloned every question item again for every answer
slot and language-completeness check. It now calls the existing `itemIds` once
for ordering and once per side for matching. It retains the existing lookup,
first-match behavior, side-local fallback IDs, missing-answer labels, Markdown
and language selection. Practice, historical review and question previews share
this component. No cache, dependency, contract or visible layout changes.

## Measurement

Baseline `c7635acb`. Three alternating before/after processes each run one warmup
and seven samples of ten complete React static-markup renders. Fixtures respect
the 100-item contract limit; matching splits items evenly between both sides.
All input and output SHA-256 values match across all processes, and inputs stay
unchanged. No other build or test suite runs during the timed render processes.
The clock includes Markdown and server rendering, and excludes browser layout,
Tauri IPC and physical devices. These are local component timings, not App-wide
latency or native-device acceptance.

| Mode | Items | Before median | After median | Reduction |
| --- | ---: | ---: | ---: | ---: |
| ordering | 6 | 0.2144 ms | 0.2256 ms | -5.2% |
| ordering | 100 | 0.6927 ms | 0.5345 ms | 22.8% |
| matching | 6 | 0.3928 ms | 0.4034 ms | -2.7% |
| matching | 100 | 3.4090 ms | 3.3026 ms | 3.1% |

The six-item controls are slightly slower; matching's large-case difference is
small. Only the 100-item ordering case demonstrates a useful timing improvement.
The regression bounds item normalization to one call per relevant side without a
wall-clock threshold. The baseline fails both work-bound cases; the candidate
passes. Existing display/localization regressions preserve missing and incomplete
answers, readable content and language annotations.

[Raw samples and hashes](../../../server/reports/typescript-answer-performance-20261020.json)
are retained. The opt-in probe is `app/src/AnswerDisplay.performance.test.tsx`:
run `PRACTIQ_ANSWER_BENCH=/absolute/report.json npm exec -- vitest run
src/AnswerDisplay.performance.test.tsx` from `app/` on each runtime revision with
the identical probe. Local process logs are in ignored
`server/reports/checks/perf-20261020/`.

## Validation

TypeScript and ESLint pass. Focused display and localization tests pass (23).
Full coverage verification passes with two workers: 448 tests, 93.69% lines
and 86.03% branches; two opt-in probes are excluded from ordinary runs. The
answer-display probe is executed separately in all six paired processes. An initial
unbounded-worker run timed out an existing 1,000-button UI test under concurrent
build load; its first log is retained. No live model, installer, native UI or
physical-device test is part of this component optimization.
