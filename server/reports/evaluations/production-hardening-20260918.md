# document_parser 评测

状态：**FAILED**

## 质量指标

| 指标 | 数值 |
|---|---:|
| questionPrecision | 92.09 |
| questionRecall | 94.81 |
| answerModeAccuracy | 68.15 |
| optionsAccuracy | 56.67 |
| parsedAnswerAccuracy | 91.11 |
| groupF1 | 94.12 |
| visualF1 | 60.00 |

## 调用与耗时

| 统计 | 数值 |
|---|---:|
| calls | 98 |
| responses | 98 |
| failedCalls | 0 |
| inputTokens | 473608 |
| outputTokens | 23499 |
| complete | True |
| missingUsageCalls | 0 |
| all.count | 69 |
| all.p50Ms | 3341.94 |
| all.p95Ms | 13941.82 |
| success.count | 62 |
| success.p50Ms | 3406.41 |
| success.p95Ms | 13850.98 |
| failure.count | 7 |
| failure.p50Ms | 549.72 |
| failure.p95Ms | 13571.38 |

## 门禁原因

- BELOW_TARGET:answerModeAccuracy
- BELOW_TARGET:optionsAccuracy
- BELOW_TARGET:visualF1
- OUTCOME_MISMATCH:image-two-column:3
- CRITICAL_CASE_FAILED:text-chinese:1
- CRITICAL_CASE_FAILED:text-no-answer:1
- CRITICAL_CASE_FAILED:text-repeated-stem:1
- CRITICAL_CASE_FAILED:text-multi-chunk:1
- CRITICAL_CASE_FAILED:pdf-long-material-answer-key:1
- CRITICAL_CASE_FAILED:text-chinese:2
- CRITICAL_CASE_FAILED:text-no-answer:2
- CRITICAL_CASE_FAILED:text-long-prefix:2
- CRITICAL_CASE_FAILED:text-repeated-stem:2
- CRITICAL_CASE_FAILED:pdf-long-material-answer-key:2
- CRITICAL_CASE_FAILED:text-chinese:3
- CRITICAL_CASE_FAILED:text-no-answer:3
- CRITICAL_CASE_FAILED:pdf-long-material-answer-key:3

## 分桶：sourceType

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| csv | 100.00 | 100.00 | 50.00 | 0.00 | 100.00 | N/A | 100.00 |
| docx | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| image | 100.00 | 83.33 | 83.33 | 100.00 | 83.33 | N/A | 0.00 |
| pdf | 61.90 | 86.67 | 66.67 | 100.00 | 66.67 | N/A | 100.00 |
| text | 95.89 | 97.22 | 72.22 | 53.33 | 94.44 | 100.00 | 100.00 |
| xlsx | 100.00 | 91.67 | 16.67 | 0.00 | 91.67 | 90.91 | 100.00 |

## 分桶：answerMode

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| choice | 100.00 | 100.00 | 56.67 | 56.67 | 100.00 | N/A | N/A |
| fill_blank | 88.89 | 88.89 | 66.67 | N/A | 88.89 | N/A | N/A |
| short_answer | 89.86 | 93.94 | 78.79 | N/A | 86.36 | N/A | N/A |
| true_false | 100.00 | 95.24 | 52.38 | N/A | 95.24 | N/A | N/A |
| unknown | 0.00 | N/A | N/A | N/A | N/A | N/A | N/A |

## 分桶：tag

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| chinese | 100.00 | 100.00 | 0.00 | 0.00 | 100.00 | N/A | 100.00 |
| chunk-boundary | 90.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |
| concentrated-answers | 66.67 | 100.00 | 75.00 | N/A | 75.00 | N/A | 100.00 |
| corrupt-input | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| cross-page | 33.33 | 100.00 | 0.00 | N/A | 0.00 | N/A | 100.00 |
| csv | 100.00 | 100.00 | 50.00 | 0.00 | 100.00 | N/A | 100.00 |
| docx | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| image | 100.00 | 83.33 | 83.33 | 100.00 | 83.33 | N/A | 0.00 |
| long-material | 33.33 | 100.00 | 0.00 | N/A | 0.00 | N/A | 100.00 |
| long-stem | 66.67 | 66.67 | 66.67 | N/A | 66.67 | N/A | 100.00 |
| no-questions | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| no-source-answer | 100.00 | 100.00 | 50.00 | 0.00 | 100.00 | N/A | 100.00 |
| pdf | 83.33 | 83.33 | 83.33 | 100.00 | 83.33 | N/A | 100.00 |
| prompt-injection | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |
| regression | 93.48 | 95.56 | 64.44 | 50.00 | 91.11 | N/A | 100.00 |
| repeated-stem | 100.00 | 100.00 | 88.89 | 100.00 | 88.89 | N/A | 100.00 |
| smoke | 97.10 | 93.06 | 66.67 | 61.11 | 93.06 | 94.12 | 60.00 |
| source-identity | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| synthetic | 92.09 | 94.81 | 68.15 | 56.67 | 91.11 | 94.12 | 60.00 |
| text | 100.00 | 100.00 | 66.67 | 66.67 | 100.00 | 100.00 | 100.00 |
| xlsx | 100.00 | 91.67 | 16.67 | 0.00 | 91.67 | 90.91 | 100.00 |

## 逐次案例

| 案例 | 次数 | 状态 | 预期结果匹配 | 耗时 ms | 差异 |
|---|---:|---|---|---:|---|
| text-basic | 1 | SUCCEEDED | True | 2985.63 | q0: answerMode,options; q1: answerMode |
| text-grouped | 1 | SUCCEEDED | True | 3643.36 |  |
| csv-basic | 1 | SUCCEEDED | True | 2832.00 | q0: answerMode,options; q1: answerMode |
| csv-quoted | 1 | SUCCEEDED | True | 3185.09 |  |
| xlsx-single-sheet | 1 | SUCCEEDED | True | 2686.49 | q0: answerMode,options; q1: answerMode |
| xlsx-multi-sheet | 1 | SUCCEEDED | True | 2642.18 | q0: answerMode; q1: answerMode |
| docx-table | 1 | SUCCEEDED | True | 12374.74 |  |
| docx-formula-image | 1 | SUCCEEDED | True | 4937.64 |  |
| pdf-text-layer | 1 | SUCCEEDED | True | 3216.41 |  |
| pdf-scanned | 1 | SUCCEEDED | True | 10004.61 | q0: missing; qNone: extra |
| image-clean | 1 | SUCCEEDED | True | 7155.39 |  |
| image-two-column | 1 | SUCCEEDED | True | 11502.17 | visuals |
| text-chinese | 1 | SUCCEEDED | True | 2588.16 | q0: answerMode,options; q1: answerMode |
| text-no-answer | 1 | SUCCEEDED | True | 2955.92 | q0: answerMode; q1: answerMode,options |
| text-long-prefix | 1 | SUCCEEDED | True | 3924.85 |  |
| text-repeated-stem | 1 | SUCCEEDED | True | 2107.15 | q0: answerMode; q1: answerMode |
| text-multi-chunk | 1 | SUCCEEDED | True | 3341.94 | qNone: extra |
| text-no-questions | 1 | ERROR | True | 1300.78 | NO_QUESTIONS_FOUND |
| docx-corrupt | 1 | ERROR | True | 22.99 | DOCUMENT_PROCESSING_FAILED |
| text-source-identity | 1 | SUCCEEDED | True | 6547.39 |  |
| text-document-instruction | 1 | SUCCEEDED | True | 3389.34 |  |
| text-concentrated-answers | 1 | SUCCEEDED | True | 3970.05 |  |
| pdf-long-material-answer-key | 1 | SUCCEEDED | True | 13986.46 | q0: answerMode,answerPayload; qNone: extra; qNone: extra |
| text-basic | 2 | SUCCEEDED | True | 2795.59 |  |
| text-grouped | 2 | SUCCEEDED | True | 3326.38 |  |
| csv-basic | 2 | SUCCEEDED | True | 3157.26 | q0: answerMode,options; q1: answerMode |
| csv-quoted | 2 | SUCCEEDED | True | 3181.31 |  |
| xlsx-single-sheet | 2 | SUCCEEDED | True | 2889.81 | q0: answerMode,options; q1: answerMode |
| xlsx-multi-sheet | 2 | SUCCEEDED | True | 1937.52 | q0: answerMode; q1: missing; groups |
| docx-table | 2 | SUCCEEDED | True | 11247.25 |  |
| docx-formula-image | 2 | SUCCEEDED | True | 3976.19 |  |
| pdf-text-layer | 2 | SUCCEEDED | True | 3281.38 |  |
| pdf-scanned | 2 | SUCCEEDED | True | 3765.25 | q0: missing; qNone: extra |
| image-clean | 2 | SUCCEEDED | True | 13397.51 |  |
| image-two-column | 2 | SUCCEEDED | True | 9145.27 | visuals |
| text-chinese | 2 | SUCCEEDED | True | 2623.41 | q0: answerMode,options; q1: answerMode |
| text-no-answer | 2 | SUCCEEDED | True | 2578.76 | q0: answerMode; q1: answerMode,options |
| text-long-prefix | 2 | SUCCEEDED | True | 2789.03 | q0: missing; q1: missing; qNone: extra; qNone: extra |
| text-repeated-stem | 2 | SUCCEEDED | True | 2111.47 | q0: answerPayload; q1: answerPayload |
| text-multi-chunk | 2 | SUCCEEDED | True | 3423.47 |  |
| text-no-questions | 2 | ERROR | True | 878.54 | NO_QUESTIONS_FOUND |
| docx-corrupt | 2 | ERROR | True | 7.44 | DOCUMENT_PROCESSING_FAILED |
| text-source-identity | 2 | SUCCEEDED | True | 5129.82 |  |
| text-document-instruction | 2 | SUCCEEDED | True | 3300.97 |  |
| text-concentrated-answers | 2 | SUCCEEDED | True | 4223.37 |  |
| pdf-long-material-answer-key | 2 | SUCCEEDED | True | 16679.55 | q0: answerMode,answerPayload; qNone: extra; qNone: extra |
| text-basic | 3 | SUCCEEDED | True | 3354.58 |  |
| text-grouped | 3 | SUCCEEDED | True | 2771.29 | q0: answerMode; q1: answerMode |
| csv-basic | 3 | SUCCEEDED | True | 2912.09 | q0: answerMode,options; q1: answerMode |
| csv-quoted | 3 | SUCCEEDED | True | 4140.82 |  |
| xlsx-single-sheet | 3 | SUCCEEDED | True | 3455.81 | q0: answerMode,options; q1: answerMode |
| xlsx-multi-sheet | 3 | SUCCEEDED | True | 3463.38 |  |
| docx-table | 3 | SUCCEEDED | True | 4689.09 |  |
| docx-formula-image | 3 | SUCCEEDED | True | 6914.09 |  |
| pdf-text-layer | 3 | SUCCEEDED | True | 5710.10 |  |
| pdf-scanned | 3 | SUCCEEDED | True | 4268.19 |  |
| image-clean | 3 | SUCCEEDED | True | 13874.85 |  |
| image-two-column | 3 | ERROR | False | 18830.21 | q0: missing; q1: missing; visuals; DOCUMENT_PARSE_FAILED |
| text-chinese | 3 | SUCCEEDED | True | 2454.75 | q0: answerMode,options; q1: answerMode |
| text-no-answer | 3 | SUCCEEDED | True | 2717.64 | q0: answerMode; q1: answerMode,options |
| text-long-prefix | 3 | SUCCEEDED | True | 3596.76 |  |
| text-repeated-stem | 3 | SUCCEEDED | True | 2181.00 |  |
| text-multi-chunk | 3 | SUCCEEDED | True | 3066.42 |  |
| text-no-questions | 3 | ERROR | True | 549.72 | NO_QUESTIONS_FOUND |
| docx-corrupt | 3 | ERROR | True | 8.13 | DOCUMENT_PROCESSING_FAILED |
| text-source-identity | 3 | SUCCEEDED | True | 5363.98 |  |
| text-document-instruction | 3 | SUCCEEDED | True | 3100.41 |  |
| text-concentrated-answers | 3 | SUCCEEDED | True | 4409.21 |  |
| pdf-long-material-answer-key | 3 | SUCCEEDED | True | 18495.35 | q0: answerMode,answerPayload; qNone: extra; qNone: extra |

Token 为已返回用量；complete=false 时不代表实际总消耗。视觉描述语义需人工复核。
完整逐题期望、实际值、阶段失败、耗时和版本信息见同名 JSON。
