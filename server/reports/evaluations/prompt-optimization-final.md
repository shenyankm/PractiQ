# document_parser 评测

状态：**FAILED**

## 质量指标

| 指标 | 数值 |
|---|---:|
| questionPrecision | 93.00 |
| questionRecall | 88.57 |
| answerModeAccuracy | 88.57 |
| optionsAccuracy | 95.83 |
| parsedAnswerAccuracy | 70.48 |
| groupF1 | 100.00 |
| visualF1 | 72.73 |

## 调用与耗时

| 统计 | 数值 |
|---|---:|
| calls | 87 |
| responses | 87 |
| failedCalls | 0 |
| inputTokens | 228278 |
| outputTokens | 85177 |
| complete | True |
| missingUsageCalls | 0 |
| all.count | 57 |
| all.p50Ms | 3500.13 |
| all.p95Ms | 10343.54 |
| success.count | 49 |
| success.p50Ms | 3528.87 |
| success.p95Ms | 8846.08 |
| failure.count | 8 |
| failure.p50Ms | 1844.98 |
| failure.p95Ms | 9770.35 |

## 门禁原因

- BELOW_TARGET:questionRecall
- BELOW_TARGET:answerModeAccuracy
- BELOW_TARGET:parsedAnswerAccuracy
- BELOW_TARGET:visualF1
- OUTCOME_MISMATCH:text-no-questions:1
- OUTCOME_MISMATCH:image-two-column:2
- OUTCOME_MISMATCH:text-basic:3
- OUTCOME_MISMATCH:text-no-questions:3
- CRITICAL_CASE_FAILED:text-long-prefix:1
- CRITICAL_CASE_FAILED:text-multi-chunk:1
- CRITICAL_CASE_FAILED:text-long-prefix:2
- CRITICAL_CASE_FAILED:text-repeated-stem:2
- CRITICAL_CASE_FAILED:text-multi-chunk:2

## 分桶：sourceType

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| csv | 100.00 | 100.00 | 100.00 | 100.00 | 66.67 | N/A | 100.00 |
| docx | 91.67 | 91.67 | 91.67 | 100.00 | 75.00 | N/A | 100.00 |
| image | 100.00 | 83.33 | 83.33 | 100.00 | 50.00 | N/A | 40.00 |
| pdf | 83.33 | 83.33 | 83.33 | 100.00 | 83.33 | N/A | 100.00 |
| text | 90.48 | 84.44 | 84.44 | 88.89 | 73.33 | 100.00 | 100.00 |
| xlsx | 100.00 | 100.00 | 100.00 | 100.00 | 66.67 | 100.00 | 100.00 |

## 分桶：answerMode

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| choice | 100.00 | 95.83 | 95.83 | 95.83 | 95.83 | N/A | N/A |
| fill_blank | 83.33 | 83.33 | 83.33 | N/A | 66.67 | N/A | N/A |
| short_answer | 90.00 | 85.71 | 85.71 | N/A | 59.52 | N/A | N/A |
| true_false | 100.00 | 90.48 | 90.48 | N/A | 66.67 | N/A | N/A |

## 分桶：tag

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| chinese | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| chunk-boundary | 100.00 | 88.89 | 88.89 | N/A | 77.78 | N/A | 100.00 |
| corrupt-input | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| csv | 100.00 | 100.00 | 100.00 | 100.00 | 66.67 | N/A | 100.00 |
| docx | 91.67 | 91.67 | 91.67 | 100.00 | 75.00 | N/A | 100.00 |
| image | 100.00 | 83.33 | 83.33 | 100.00 | 50.00 | N/A | 40.00 |
| long-stem | 33.33 | 33.33 | 33.33 | N/A | 33.33 | N/A | 100.00 |
| no-questions | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| no-source-answer | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| pdf | 83.33 | 83.33 | 83.33 | 100.00 | 83.33 | N/A | 100.00 |
| regression | 87.50 | 84.85 | 84.85 | 100.00 | 75.76 | N/A | 100.00 |
| repeated-stem | 100.00 | 100.00 | 100.00 | N/A | 66.67 | N/A | 100.00 |
| smoke | 95.59 | 90.28 | 90.28 | 94.44 | 68.06 | 100.00 | 72.73 |
| synthetic | 93.00 | 88.57 | 88.57 | 95.83 | 70.48 | 100.00 | 72.73 |
| text | 100.00 | 83.33 | 83.33 | 66.67 | 66.67 | 100.00 | 100.00 |
| xlsx | 100.00 | 100.00 | 100.00 | 100.00 | 66.67 | 100.00 | 100.00 |

## 逐次案例

| 案例 | 次数 | 状态 | 预期结果匹配 | 耗时 ms | 差异 |
|---|---:|---|---|---:|---|
| text-basic | 1 | SUCCEEDED | True | 3437.47 |  |
| text-grouped | 1 | SUCCEEDED | True | 3156.11 |  |
| csv-basic | 1 | SUCCEEDED | True | 3620.15 |  |
| csv-quoted | 1 | SUCCEEDED | True | 3180.30 |  |
| xlsx-single-sheet | 1 | SUCCEEDED | True | 3513.99 |  |
| xlsx-multi-sheet | 1 | SUCCEEDED | True | 2992.03 |  |
| docx-table | 1 | SUCCEEDED | True | 4020.23 |  |
| docx-formula-image | 1 | SUCCEEDED | True | 4480.90 | q0: answerPayload; q1: answerPayload |
| pdf-text-layer | 1 | SUCCEEDED | True | 3222.01 |  |
| pdf-scanned | 1 | SUCCEEDED | True | 4648.11 | q0: missing; qNone: extra |
| image-clean | 1 | SUCCEEDED | True | 5448.14 |  |
| image-two-column | 1 | SUCCEEDED | True | 5874.63 | q0: answerPayload; q1: answerPayload; visuals |
| text-chinese | 1 | SUCCEEDED | True | 3315.83 |  |
| text-no-answer | 1 | SUCCEEDED | True | 3343.68 |  |
| text-long-prefix | 1 | SUCCEEDED | True | 3638.26 | q0: missing; q1: missing; qNone: extra; qNone: extra |
| text-repeated-stem | 1 | SUCCEEDED | True | 2773.37 |  |
| text-multi-chunk | 1 | SUCCEEDED | True | 304485.05 | q2: missing |
| text-no-questions | 1 | ERROR | False | 2734.22 | DOCUMENT_PARSE_FAILED |
| docx-corrupt | 1 | ERROR | True | 7.96 | DOCUMENT_PROCESSING_FAILED |
| text-basic | 2 | SUCCEEDED | True | 3154.72 |  |
| text-grouped | 2 | SUCCEEDED | True | 2941.92 |  |
| csv-basic | 2 | SUCCEEDED | True | 5148.36 |  |
| csv-quoted | 2 | SUCCEEDED | True | 3276.30 | q0: answerPayload; q1: answerPayload |
| xlsx-single-sheet | 2 | SUCCEEDED | True | 3528.87 |  |
| xlsx-multi-sheet | 2 | SUCCEEDED | True | 3059.60 | q0: answerPayload; q1: answerPayload |
| docx-table | 2 | SUCCEEDED | True | 3839.66 |  |
| docx-formula-image | 2 | SUCCEEDED | True | 5131.54 |  |
| pdf-text-layer | 2 | SUCCEEDED | True | 3462.99 |  |
| pdf-scanned | 2 | SUCCEEDED | True | 6754.34 |  |
| image-clean | 2 | SUCCEEDED | True | 4537.55 |  |
| image-two-column | 2 | ERROR | False | 7941.03 | q0: missing; q1: missing; visuals; VISION_OUTPUT_EMPTY |
| text-chinese | 2 | SUCCEEDED | True | 3057.65 |  |
| text-no-answer | 2 | SUCCEEDED | True | 3536.80 |  |
| text-long-prefix | 2 | SUCCEEDED | True | 3622.07 | q0: missing; q1: missing; qNone: extra; qNone: extra |
| text-repeated-stem | 2 | SUCCEEDED | True | 2934.22 | q0: answerPayload; q1: answerPayload |
| text-multi-chunk | 2 | SUCCEEDED | True | 111465.90 | q2: answerPayload |
| text-no-questions | 2 | ERROR | True | 1065.65 | NO_QUESTIONS_FOUND |
| docx-corrupt | 2 | ERROR | True | 3.97 | DOCUMENT_PROCESSING_FAILED |
| text-basic | 3 | ERROR | False | 10755.36 | q0: missing; q1: missing; DOCUMENT_PARSE_FAILED |
| text-grouped | 3 | SUCCEEDED | True | 2783.19 | q0: answerPayload; q1: answerPayload |
| csv-basic | 3 | SUCCEEDED | True | 2772.74 |  |
| csv-quoted | 3 | SUCCEEDED | True | 2432.79 | q0: answerPayload; q1: answerPayload |
| xlsx-single-sheet | 3 | SUCCEEDED | True | 3544.39 |  |
| xlsx-multi-sheet | 3 | SUCCEEDED | True | 3128.33 | q0: answerPayload; q1: answerPayload |
| docx-table | 3 | SUCCEEDED | True | 3550.69 | q1: missing; qNone: extra |
| docx-formula-image | 3 | SUCCEEDED | True | 4386.71 |  |
| pdf-text-layer | 3 | SUCCEEDED | True | 3612.06 |  |
| pdf-scanned | 3 | SUCCEEDED | True | 4304.90 | q0: missing; qNone: extra |
| image-clean | 3 | SUCCEEDED | True | 4941.07 |  |
| image-two-column | 3 | SUCCEEDED | True | 10240.58 | q0: answerPayload; q1: answerPayload |
| text-chinese | 3 | SUCCEEDED | True | 2820.15 |  |
| text-no-answer | 3 | SUCCEEDED | True | 2593.47 |  |
| text-long-prefix | 3 | SUCCEEDED | True | 4476.10 |  |
| text-repeated-stem | 3 | SUCCEEDED | True | 2676.72 |  |
| text-multi-chunk | 3 | SUCCEEDED | True | 3500.13 |  |
| text-no-questions | 3 | ERROR | False | 2624.32 | DOCUMENT_PARSE_FAILED |
| docx-corrupt | 3 | ERROR | True | 10.60 | DOCUMENT_PROCESSING_FAILED |

Token 为已返回用量；complete=false 时不代表实际总消耗。视觉描述语义需人工复核。
完整逐题期望、实际值、阶段失败、耗时和版本信息见同名 JSON。
