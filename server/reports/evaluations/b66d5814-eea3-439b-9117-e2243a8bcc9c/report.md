# document_parser 评测

状态：**FAILED**

## 质量指标

| 指标 | 数值 |
|---|---:|
| questionPrecision | 72.73 |
| questionRecall | 68.57 |
| answerModeAccuracy | 51.43 |
| optionsAccuracy | 50.00 |
| parsedAnswerAccuracy | 37.14 |
| groupF1 | 66.67 |
| visualF1 | 66.67 |

## 调用与耗时

| 统计 | 数值 |
|---|---:|
| calls | 30 |
| responses | 30 |
| failedCalls | 0 |
| inputTokens | 59811 |
| outputTokens | 20887 |
| complete | True |
| missingUsageCalls | 0 |
| all.count | 19 |
| all.p50Ms | 14101.79 |
| all.p95Ms | 40410.13 |
| success.count | 15 |
| success.p50Ms | 14950.30 |
| success.p95Ms | 29285.37 |
| failure.count | 4 |
| failure.p50Ms | 11838.77 |
| failure.p95Ms | 48732.82 |

## 门禁原因

- BELOW_TARGET:questionPrecision
- BELOW_TARGET:questionRecall
- BELOW_TARGET:answerModeAccuracy
- BELOW_TARGET:optionsAccuracy
- BELOW_TARGET:parsedAnswerAccuracy
- BELOW_TARGET:groupF1
- BELOW_TARGET:visualF1
- OUTCOME_MISMATCH:csv-basic:1
- OUTCOME_MISMATCH:docx-formula-image:1
- CRITICAL_CASE_FAILED:text-long-prefix:1
- CRITICAL_CASE_FAILED:text-repeated-stem:1
- CRITICAL_CASE_FAILED:text-multi-chunk:1

## 分桶：sourceType

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| csv | 100.00 | 50.00 | 50.00 | 0.00 | 50.00 | N/A | 100.00 |
| docx | 100.00 | 100.00 | 100.00 | 100.00 | 50.00 | N/A | 0.00 |
| image | 50.00 | 50.00 | 50.00 | 0.00 | 50.00 | N/A | 100.00 |
| pdf | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | N/A | 100.00 |
| text | 80.00 | 80.00 | 40.00 | 66.67 | 40.00 | 0.00 | 100.00 |
| xlsx | 100.00 | 100.00 | 100.00 | 100.00 | 25.00 | 100.00 | 100.00 |

## 分桶：answerMode

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| choice | 57.14 | 50.00 | 50.00 | 50.00 | 50.00 | N/A | N/A |
| fill_blank | 50.00 | 50.00 | 50.00 | N/A | 33.33 | N/A | N/A |
| short_answer | 92.86 | 92.86 | 50.00 | N/A | 35.71 | N/A | N/A |
| true_false | 66.67 | 57.14 | 57.14 | N/A | 28.57 | N/A | N/A |

## 分桶：tag

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| chinese | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| chunk-boundary | 100.00 | 100.00 | 33.33 | N/A | 33.33 | N/A | 100.00 |
| corrupt-input | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| csv | 100.00 | 50.00 | 50.00 | 0.00 | 50.00 | N/A | 100.00 |
| docx | 100.00 | 100.00 | 100.00 | 100.00 | 50.00 | N/A | 0.00 |
| image | 50.00 | 50.00 | 50.00 | 0.00 | 50.00 | N/A | 100.00 |
| long-stem | 100.00 | 100.00 | 0.00 | N/A | 0.00 | N/A | 100.00 |
| no-questions | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| no-source-answer | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| pdf | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | N/A | 100.00 |
| regression | 100.00 | 100.00 | 45.45 | 100.00 | 45.45 | N/A | 100.00 |
| repeated-stem | 100.00 | 100.00 | 0.00 | N/A | 0.00 | N/A | 100.00 |
| smoke | 59.09 | 54.17 | 54.17 | 33.33 | 33.33 | 66.67 | 66.67 |
| synthetic | 72.73 | 68.57 | 51.43 | 50.00 | 37.14 | 66.67 | 66.67 |
| text | 25.00 | 25.00 | 25.00 | 0.00 | 25.00 | 0.00 | 100.00 |
| xlsx | 100.00 | 100.00 | 100.00 | 100.00 | 25.00 | 100.00 | 100.00 |

## 逐次案例

| 案例 | 次数 | 状态 | 预期结果匹配 | 耗时 ms | 差异 |
|---|---:|---|---|---:|---|
| text-basic | 1 | SUCCEEDED | True | 20970.75 | q0: missing; q1: missing; qNone: extra; qNone: extra |
| text-grouped | 1 | SUCCEEDED | True | 10826.59 | q0: missing; qNone: extra; groups |
| csv-basic | 1 | ERROR | False | 11048.56 | q0: missing; q1: missing; NO_QUESTIONS_FOUND |
| csv-quoted | 1 | SUCCEEDED | True | 7991.57 |  |
| xlsx-single-sheet | 1 | SUCCEEDED | True | 25217.32 | q1: answerPayload |
| xlsx-multi-sheet | 1 | SUCCEEDED | True | 8033.00 | q0: answerPayload; q1: answerPayload |
| docx-table | 1 | SUCCEEDED | True | 10991.00 |  |
| docx-formula-image | 1 | PARTIAL | False | 55104.09 | q0: answerPayload; q1: answerPayload; visuals |
| pdf-text-layer | 1 | SUCCEEDED | True | 13091.03 | q0: missing; q1: missing; qNone: extra; qNone: extra |
| pdf-scanned | 1 | SUCCEEDED | True | 19457.07 | q0: missing; q1: missing; qNone: extra; qNone: extra |
| image-clean | 1 | SUCCEEDED | True | 17307.16 | q0: missing; q1: missing; qNone: extra; qNone: extra |
| image-two-column | 1 | SUCCEEDED | True | 38777.47 |  |
| text-chinese | 1 | SUCCEEDED | True | 16620.39 |  |
| text-no-answer | 1 | SUCCEEDED | True | 14101.79 |  |
| text-long-prefix | 1 | SUCCEEDED | True | 13750.74 | q0: answerMode,answerPayload; q1: answerMode,answerPayload |
| text-repeated-stem | 1 | SUCCEEDED | True | 14950.30 | q0: answerMode,answerPayload; q1: answerMode,answerPayload |
| text-multi-chunk | 1 | SUCCEEDED | True | 20655.70 | q0: answerMode,answerPayload; q1: answerMode,answerPayload |
| text-no-questions | 1 | ERROR | True | 12628.98 | NO_QUESTIONS_FOUND |
| docx-corrupt | 1 | ERROR | True | 4956.24 | DOCUMENT_PROCESSING_FAILED |

Token 为已返回用量；complete=false 时不代表实际总消耗。视觉描述语义需人工复核。
完整逐题期望、实际值、阶段失败、耗时和版本信息见同名 JSON。
