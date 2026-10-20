# Writing word count CPU follow-up — 2026-10-20

Writing answers used to scan the same response up to three times in one render and allocate a full array of matched words each time. Count once per render and count regex matches without retaining that array. The Unicode letters/numbers, contractions, hyphens, word-limit warning and ability to submit remain unchanged.

The [paired report](typescript-words-round2-20261020.json) compares `f5fe3918` with this change using `app/src/EnglishWords.performance.test.tsx`: three alternating fresh baseline/candidate process pairs, one warmup and seven samples of twenty calls/renders per process. Input and output hashes agree. Timings are per call, on local macOS; static React markup excludes browser layout, input events, IPC and device performance.

| Workload | Before median | After median | Reduction |
| --- | ---: | ---: | ---: |
| Count 20 words | 0.000513 ms | 0.000542 ms | -5.7% |
| Render 20-word writing answer | 0.0767 ms | 0.0782 ms | -1.9% |
| Count 20,000 words / 120,000 characters | 0.3859 ms | 0.3308 ms | 14.3% |
| Render 20,000-word writing answer | 1.2276 ms | 0.4468 ms | 63.6% |

Small-input controls have no measured benefit; retain those negative results. No memory allocation or end-to-end typing latency claim is made. The render-count regression fails against the baseline and passes after the change; semantic cases cover Unicode, combining marks, apostrophes, hyphens, empty input and repeated calls.

Reproduce with the opt-in probe against each version of `english.ts` and `AnswerInput.tsx` while keeping the probe identical:

```sh
cd app
PRACTIQ_WORDS_BENCH=/absolute/path/report.json npm exec -- vitest run src/EnglishWords.performance.test.tsx
```
