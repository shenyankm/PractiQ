# document_parser 评测

状态：**FAILED**

## 质量指标

| 指标 | 数值 |
|---|---:|
| questionPrecision | 97.76 |
| questionRecall | 97.04 |
| answerModeAccuracy | 97.04 |
| optionsAccuracy | 100.00 |
| parsedAnswerAccuracy | 96.30 |
| groupF1 | 100.00 |
| visualF1 | 80.00 |

## 调用与耗时

| 统计 | 数值 |
|---|---:|
| calls | 101 |
| responses | 101 |
| failedCalls | 0 |
| inputTokens | 565577 |
| outputTokens | 28663 |
| complete | True |
| missingUsageCalls | 0 |
| all.count | 69 |
| all.p50Ms | 4066.81 |
| all.p95Ms | 13092.68 |
| success.count | 62 |
| success.p50Ms | 4273.42 |
| success.p95Ms | 12815.10 |
| failure.count | 7 |
| failure.p50Ms | 765.97 |
| failure.p95Ms | 11999.25 |

## 门禁原因

- BELOW_TARGET:visualF1
- OUTCOME_MISMATCH:image-two-column:2
- CRITICAL_CASE_FAILED:pdf-long-material-answer-key:1

## 分桶：sourceType

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| csv | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| docx | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| image | 90.00 | 75.00 | 75.00 | 100.00 | 75.00 | N/A | 50.00 |
| pdf | 87.50 | 93.33 | 93.33 | 100.00 | 86.67 | N/A | 100.00 |
| text | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 |
| xlsx | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 |

## 分桶：answerMode

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| choice | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | N/A |
| fill_blank | 88.89 | 88.89 | 88.89 | N/A | 88.89 | N/A | N/A |
| short_answer | 98.48 | 98.48 | 98.48 | N/A | 96.97 | N/A | N/A |
| true_false | 100.00 | 95.24 | 95.24 | N/A | 95.24 | N/A | N/A |

## 分桶：tag

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| chinese | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| chunk-boundary | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |
| concentrated-answers | 92.31 | 100.00 | 100.00 | N/A | 91.67 | N/A | 100.00 |
| corrupt-input | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| cross-page | 75.00 | 100.00 | 100.00 | N/A | 66.67 | N/A | 100.00 |
| csv | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| docx | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| image | 90.00 | 75.00 | 75.00 | 100.00 | 75.00 | N/A | 50.00 |
| long-material | 75.00 | 100.00 | 100.00 | N/A | 66.67 | N/A | 100.00 |
| long-stem | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |
| no-questions | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| no-source-answer | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| pdf | 91.67 | 91.67 | 91.67 | 100.00 | 91.67 | N/A | 100.00 |
| prompt-injection | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |
| regression | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| repeated-stem | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| smoke | 97.14 | 94.44 | 94.44 | 100.00 | 94.44 | 100.00 | 80.00 |
| source-identity | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| synthetic | 97.76 | 97.04 | 97.04 | 100.00 | 96.30 | 100.00 | 80.00 |
| text | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 |
| xlsx | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 |

## 逐次案例

| 案例 | 次数 | 状态 | 预期结果匹配 | 耗时 ms | 差异 |
|---|---:|---|---|---:|---|
| text-basic | 1 | SUCCEEDED | True | 4665.75 |  |
| text-grouped | 1 | SUCCEEDED | True | 3598.79 |  |
| csv-basic | 1 | SUCCEEDED | True | 4321.28 |  |
| csv-quoted | 1 | SUCCEEDED | True | 3703.21 |  |
| xlsx-single-sheet | 1 | SUCCEEDED | True | 4063.59 |  |
| xlsx-multi-sheet | 1 | SUCCEEDED | True | 3759.90 |  |
| docx-table | 1 | SUCCEEDED | True | 8468.41 |  |
| docx-formula-image | 1 | SUCCEEDED | True | 9802.24 |  |
| pdf-text-layer | 1 | SUCCEEDED | True | 5835.08 |  |
| pdf-scanned | 1 | SUCCEEDED | True | 9140.16 | q0: missing; qNone: extra |
| image-clean | 1 | SUCCEEDED | True | 8325.42 | q1: missing; qNone: extra |
| image-two-column | 1 | SUCCEEDED | True | 16685.00 | visuals |
| text-chinese | 1 | SUCCEEDED | True | 3962.07 |  |
| text-no-answer | 1 | SUCCEEDED | True | 4066.81 |  |
| text-long-prefix | 1 | SUCCEEDED | True | 4253.77 |  |
| text-repeated-stem | 1 | SUCCEEDED | True | 3233.46 |  |
| text-multi-chunk | 1 | SUCCEEDED | True | 3916.47 |  |
| text-no-questions | 1 | ERROR | True | 1053.37 | NO_QUESTIONS_FOUND |
| docx-corrupt | 1 | ERROR | True | 11.72 | DOCUMENT_PROCESSING_FAILED |
| text-source-identity | 1 | SUCCEEDED | True | 12924.04 |  |
| text-document-instruction | 1 | SUCCEEDED | True | 3713.60 |  |
| text-concentrated-answers | 1 | SUCCEEDED | True | 4340.47 |  |
| pdf-long-material-answer-key | 1 | SUCCEEDED | True | 13402.15 | q0: answerPayload; qNone: extra |
| text-basic | 2 | SUCCEEDED | True | 4388.06 |  |
| text-grouped | 2 | SUCCEEDED | True | 3893.87 |  |
| csv-basic | 2 | SUCCEEDED | True | 3851.66 |  |
| csv-quoted | 2 | SUCCEEDED | True | 3314.61 |  |
| xlsx-single-sheet | 2 | SUCCEEDED | True | 4152.31 |  |
| xlsx-multi-sheet | 2 | SUCCEEDED | True | 3734.44 |  |
| docx-table | 2 | SUCCEEDED | True | 8681.78 |  |
| docx-formula-image | 2 | SUCCEEDED | True | 7867.28 |  |
| pdf-text-layer | 2 | SUCCEEDED | True | 3855.63 |  |
| pdf-scanned | 2 | SUCCEEDED | True | 9255.86 |  |
| image-clean | 2 | SUCCEEDED | True | 6258.28 |  |
| image-two-column | 2 | ERROR | False | 16506.61 | q0: missing; q1: missing; visuals; DOCUMENT_PARSE_FAILED |
| text-chinese | 2 | SUCCEEDED | True | 3996.19 |  |
| text-no-answer | 2 | SUCCEEDED | True | 3834.76 |  |
| text-long-prefix | 2 | SUCCEEDED | True | 4360.62 |  |
| text-repeated-stem | 2 | SUCCEEDED | True | 3064.43 |  |
| text-multi-chunk | 2 | SUCCEEDED | True | 3825.25 |  |
| text-no-questions | 2 | ERROR | True | 765.97 | NO_QUESTIONS_FOUND |
| docx-corrupt | 2 | ERROR | True | 8.45 | DOCUMENT_PROCESSING_FAILED |
| text-source-identity | 2 | SUCCEEDED | True | 5518.43 |  |
| text-document-instruction | 2 | SUCCEEDED | True | 3706.93 |  |
| text-concentrated-answers | 2 | SUCCEEDED | True | 5643.19 |  |
| pdf-long-material-answer-key | 2 | SUCCEEDED | True | 10745.29 |  |
| text-basic | 3 | SUCCEEDED | True | 3980.81 |  |
| text-grouped | 3 | SUCCEEDED | True | 3859.80 |  |
| csv-basic | 3 | SUCCEEDED | True | 3964.06 |  |
| csv-quoted | 3 | SUCCEEDED | True | 3800.35 |  |
| xlsx-single-sheet | 3 | SUCCEEDED | True | 4494.41 |  |
| xlsx-multi-sheet | 3 | SUCCEEDED | True | 3657.53 |  |
| docx-table | 3 | SUCCEEDED | True | 8801.30 |  |
| docx-formula-image | 3 | SUCCEEDED | True | 5209.73 |  |
| pdf-text-layer | 3 | SUCCEEDED | True | 7856.13 |  |
| pdf-scanned | 3 | SUCCEEDED | True | 9184.44 |  |
| image-clean | 3 | SUCCEEDED | True | 7345.25 |  |
| image-two-column | 3 | SUCCEEDED | True | 9121.87 |  |
| text-chinese | 3 | SUCCEEDED | True | 3778.22 |  |
| text-no-answer | 3 | SUCCEEDED | True | 4005.70 |  |
| text-long-prefix | 3 | SUCCEEDED | True | 4293.07 |  |
| text-repeated-stem | 3 | SUCCEEDED | True | 3226.36 |  |
| text-multi-chunk | 3 | SUCCEEDED | True | 3372.83 |  |
| text-no-questions | 3 | ERROR | True | 1482.10 | NO_QUESTIONS_FOUND |
| docx-corrupt | 3 | ERROR | True | 8.24 | DOCUMENT_PROCESSING_FAILED |
| text-source-identity | 3 | SUCCEEDED | True | 5475.71 |  |
| text-document-instruction | 3 | SUCCEEDED | True | 3484.10 |  |
| text-concentrated-answers | 3 | SUCCEEDED | True | 4943.14 |  |
| pdf-long-material-answer-key | 3 | SUCCEEDED | True | 13205.11 |  |

Token 为已返回用量；complete=false 时不代表实际总消耗。视觉描述语义需人工复核。
完整逐题期望、实际值、阶段失败、耗时和版本信息见同名 JSON。
