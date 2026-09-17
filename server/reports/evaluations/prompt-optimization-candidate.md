# document_parser 评测

状态：**FAILED**

## 质量指标

| 指标 | 数值 |
|---|---:|
| questionPrecision | 88.35 |
| questionRecall | 86.67 |
| answerModeAccuracy | 84.76 |
| optionsAccuracy | 95.83 |
| parsedAnswerAccuracy | 72.38 |
| groupF1 | 18.18 |
| visualF1 | 100.00 |

## 调用与耗时

| 统计 | 数值 |
|---|---:|
| calls | 81 |
| responses | 81 |
| failedCalls | 0 |
| inputTokens | 187874 |
| outputTokens | 202146 |
| complete | True |
| missingUsageCalls | 0 |
| all.count | 57 |
| all.p50Ms | 31056.74 |
| all.p95Ms | 70524.59 |
| success.count | 50 |
| success.p50Ms | 31889.83 |
| success.p95Ms | 62943.79 |
| failure.count | 7 |
| failure.p50Ms | 4689.03 |
| failure.p95Ms | 120159.92 |

## 门禁原因

- BELOW_TARGET:questionPrecision
- BELOW_TARGET:questionRecall
- BELOW_TARGET:answerModeAccuracy
- BELOW_TARGET:parsedAnswerAccuracy
- BELOW_TARGET:groupF1
- OUTCOME_MISMATCH:text-basic:2
- CRITICAL_CASE_FAILED:text-repeated-stem:3

## 分桶：sourceType

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| csv | 83.33 | 83.33 | 83.33 | 100.00 | 83.33 | N/A | 100.00 |
| docx | 100.00 | 100.00 | 100.00 | 100.00 | 83.33 | N/A | 100.00 |
| image | 75.00 | 75.00 | 75.00 | 100.00 | 25.00 | N/A | 100.00 |
| pdf | 66.67 | 66.67 | 66.67 | 100.00 | 66.67 | N/A | 100.00 |
| text | 93.02 | 88.89 | 84.44 | 88.89 | 77.78 | 40.00 | 100.00 |
| xlsx | 100.00 | 100.00 | 100.00 | 100.00 | 83.33 | 0.00 | 100.00 |

## 分桶：answerMode

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| choice | 100.00 | 95.83 | 95.83 | 95.83 | 95.83 | N/A | N/A |
| fill_blank | 44.44 | 44.44 | 44.44 | N/A | 38.89 | N/A | N/A |
| short_answer | 97.62 | 97.62 | 92.86 | N/A | 76.19 | N/A | N/A |
| true_false | 95.00 | 90.48 | 90.48 | N/A | 66.67 | N/A | N/A |

## 分桶：tag

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| chinese | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| chunk-boundary | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |
| corrupt-input | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| csv | 83.33 | 83.33 | 83.33 | 100.00 | 83.33 | N/A | 100.00 |
| docx | 100.00 | 100.00 | 100.00 | 100.00 | 83.33 | N/A | 100.00 |
| image | 75.00 | 75.00 | 75.00 | 100.00 | 25.00 | N/A | 100.00 |
| long-stem | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |
| no-questions | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| no-source-answer | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| pdf | 66.67 | 66.67 | 66.67 | 100.00 | 66.67 | N/A | 100.00 |
| regression | 100.00 | 100.00 | 93.94 | 100.00 | 93.94 | N/A | 100.00 |
| repeated-stem | 100.00 | 100.00 | 66.67 | N/A | 66.67 | N/A | 100.00 |
| smoke | 82.86 | 80.56 | 80.56 | 94.44 | 62.50 | 18.18 | 100.00 |
| synthetic | 88.35 | 86.67 | 84.76 | 95.83 | 72.38 | 18.18 | 100.00 |
| text | 70.00 | 58.33 | 58.33 | 66.67 | 33.33 | 40.00 | 100.00 |
| xlsx | 100.00 | 100.00 | 100.00 | 100.00 | 83.33 | 0.00 | 100.00 |

## 逐次案例

| 案例 | 次数 | 状态 | 预期结果匹配 | 耗时 ms | 差异 |
|---|---:|---|---|---:|---|
| text-basic | 1 | SUCCEEDED | True | 26465.82 |  |
| text-grouped | 1 | SUCCEEDED | True | 29860.02 | q0: missing; q1: missing; qNone: extra; qNone: extra; groups |
| csv-basic | 1 | SUCCEEDED | True | 23652.96 |  |
| csv-quoted | 1 | SUCCEEDED | True | 28402.19 | q0: missing; qNone: extra |
| xlsx-single-sheet | 1 | SUCCEEDED | True | 21862.69 |  |
| xlsx-multi-sheet | 1 | SUCCEEDED | True | 31575.28 | q0: answerPayload; q1: answerPayload; groups |
| docx-table | 1 | SUCCEEDED | True | 47469.84 |  |
| docx-formula-image | 1 | SUCCEEDED | True | 43131.42 |  |
| pdf-text-layer | 1 | SUCCEEDED | True | 31089.77 |  |
| pdf-scanned | 1 | SUCCEEDED | True | 39409.77 | q0: missing; qNone: extra |
| image-clean | 1 | SUCCEEDED | True | 24317.76 | q1: missing; qNone: extra |
| image-two-column | 1 | SUCCEEDED | True | 46746.70 | q0: answerPayload; q1: answerPayload |
| text-chinese | 1 | SUCCEEDED | True | 15434.72 |  |
| text-no-answer | 1 | SUCCEEDED | True | 39424.36 |  |
| text-long-prefix | 1 | SUCCEEDED | True | 18724.14 |  |
| text-repeated-stem | 1 | SUCCEEDED | True | 17273.56 |  |
| text-multi-chunk | 1 | SUCCEEDED | True | 25400.06 |  |
| text-no-questions | 1 | ERROR | True | 4689.03 | NO_QUESTIONS_FOUND |
| docx-corrupt | 1 | ERROR | True | 6.76 | DOCUMENT_PROCESSING_FAILED |
| text-basic | 2 | ERROR | False | 169332.73 | q0: missing; q1: missing; DOCUMENT_PARSE_FAILED |
| text-grouped | 2 | SUCCEEDED | True | 35322.96 | q0: missing; q1: answerPayload; qNone: extra; groups |
| csv-basic | 2 | SUCCEEDED | True | 32204.39 |  |
| csv-quoted | 2 | SUCCEEDED | True | 27607.55 |  |
| xlsx-single-sheet | 2 | SUCCEEDED | True | 32650.22 |  |
| xlsx-multi-sheet | 2 | SUCCEEDED | True | 29579.69 | groups |
| docx-table | 2 | SUCCEEDED | True | 26666.06 |  |
| docx-formula-image | 2 | SUCCEEDED | True | 32762.88 |  |
| pdf-text-layer | 2 | SUCCEEDED | True | 47550.13 |  |
| pdf-scanned | 2 | SUCCEEDED | True | 38646.49 | q0: missing; qNone: extra |
| image-clean | 2 | SUCCEEDED | True | 58786.31 | q1: missing; qNone: extra |
| image-two-column | 2 | SUCCEEDED | True | 34423.64 | q0: answerPayload; q1: answerPayload |
| text-chinese | 2 | SUCCEEDED | True | 52513.83 |  |
| text-no-answer | 2 | SUCCEEDED | True | 87241.52 |  |
| text-long-prefix | 2 | SUCCEEDED | True | 30619.12 |  |
| text-repeated-stem | 2 | SUCCEEDED | True | 19830.40 |  |
| text-multi-chunk | 2 | SUCCEEDED | True | 27421.80 |  |
| text-no-questions | 2 | ERROR | True | 5423.37 | NO_QUESTIONS_FOUND |
| docx-corrupt | 2 | ERROR | True | 12.16 | DOCUMENT_PROCESSING_FAILED |
| text-basic | 3 | SUCCEEDED | True | 27624.82 |  |
| text-grouped | 3 | SUCCEEDED | True | 34810.58 | q0: answerPayload; q1: answerPayload |
| csv-basic | 3 | SUCCEEDED | True | 29994.51 |  |
| csv-quoted | 3 | SUCCEEDED | True | 51757.53 | q0: missing; qNone: extra |
| xlsx-single-sheet | 3 | SUCCEEDED | True | 33391.34 |  |
| xlsx-multi-sheet | 3 | SUCCEEDED | True | 31056.74 | groups |
| docx-table | 3 | SUCCEEDED | True | 37288.15 |  |
| docx-formula-image | 3 | SUCCEEDED | True | 97201.48 | q0: answerPayload; q1: answerPayload |
| pdf-text-layer | 3 | SUCCEEDED | True | 25769.74 |  |
| pdf-scanned | 3 | SUCCEEDED | True | 57123.95 | q0: missing; q1: missing; qNone: extra; qNone: extra |
| image-clean | 3 | SUCCEEDED | True | 32917.73 | q1: missing; qNone: extra |
| image-two-column | 3 | SUCCEEDED | True | 45235.99 | q0: answerPayload; q1: answerPayload |
| text-chinese | 3 | SUCCEEDED | True | 25090.49 |  |
| text-no-answer | 3 | SUCCEEDED | True | 66345.36 |  |
| text-long-prefix | 3 | SUCCEEDED | True | 49267.70 |  |
| text-repeated-stem | 3 | SUCCEEDED | True | 29115.36 | q0: answerMode,answerPayload; q1: answerMode,answerPayload |
| text-multi-chunk | 3 | SUCCEEDED | True | 29750.31 |  |
| text-no-questions | 3 | ERROR | True | 5005.11 | NO_QUESTIONS_FOUND |
| docx-corrupt | 3 | ERROR | True | 8.23 | DOCUMENT_PROCESSING_FAILED |

Token 为已返回用量；complete=false 时不代表实际总消耗。视觉描述语义需人工复核。
完整逐题期望、实际值、阶段失败、耗时和版本信息见同名 JSON。
