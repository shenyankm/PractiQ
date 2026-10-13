# Round 3: unused overlap content on page merges

Current service baseline is commit `16e47c9c69bdad410a299ef6d385bfe0beb85dee`; app-only rounds 1–2 do not modify service inputs. Baseline-only cProfile established 1,000 `_content` calls taking 7.26 ms of 113.27 ms profiled page merge. Candidate changes one line: build comparison content only when overlapping is true. Deep copies, source matching, quality and truncation remain unchanged.

Fixed load: 1,000 rich choice questions with nullable supplied answers, four options, eight content blocks, source rubric and explanation, two pages of 500 nodes. Text control uses two fully overlapping chunks of the same 1,000 questions (2,000 input occurrences). Full canonical outputs and original inputs must remain identical; nested records must stay independent. Accept only if all five paired page improvements exceed the observed spread and text control has no reproducible >5% regression.

| Workload | Baseline warm median ms | Candidate warm median ms |
| --- | ---: | ---: |
| pages | 47.871 | 39.040 |
| text-overlap | 98.664 | 98.549 |

Decision: retain. Each page pair improves by 16.4–22.8%; median reduction is 18.4%, exceeding baseline/candidate spread. Text control medians differ by 0.1%; no improvement claim. First measured page-call medians are separately 37.54 / 29.22 ms; imports/fixture construction are excluded, and this is not process startup or OS-cold latency.

The focused regression first failed at the unwanted content call, then 48 relevant chunking/composite/English/off-event-loop tests passed. A separate read-only reviewer found no correctness issues. Raw pairs, input/output/source hashes, first/warm samples and profiler rows are in `round3-merge.json`; exact commands are in `merge_compare.py`; source/test patch is `round3-retained.patch`. No model calls, database access, extraction, checkpoint storage, export, HTTP or WebView time is included. Final make verify remains pending.

Final acceptance outcomes and interaction limits are recorded in [README.md](README.md) and [native-interaction.md](native-interaction.md); earlier pending notes above describe the per-round checkpoint.
