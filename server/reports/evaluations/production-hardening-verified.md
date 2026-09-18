# document_parser 评测

状态：**FAILED**

## 质量指标

| 指标 | 数值 |
|---|---:|
| questionPrecision | 97.06 |
| questionRecall | 97.78 |
| answerModeAccuracy | 95.56 |
| optionsAccuracy | 100.00 |
| parsedAnswerAccuracy | 95.56 |
| groupF1 | 100.00 |
| visualF1 | 54.55 |

## 调用与耗时

| 统计 | 数值 |
|---|---:|
| calls | 101 |
| responses | 101 |
| failedCalls | 0 |
| inputTokens | 571360 |
| outputTokens | 28214 |
| complete | True |
| missingUsageCalls | 0 |
| all.count | 69 |
| all.p50Ms | 4281.22 |
| all.p95Ms | 11556.53 |
| success.count | 63 |
| success.p50Ms | 4441.88 |
| success.p95Ms | 11571.52 |
| failure.count | 6 |
| failure.p50Ms | 586.01 |
| failure.p95Ms | 1320.95 |

## 门禁原因

- BELOW_TARGET:visualF1
- CRITICAL_CASE_FAILED:text-multi-chunk:3
- CRITICAL_CASE_FAILED:text-concentrated-answers:3

## 分桶：sourceType

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| csv | 91.67 | 91.67 | 91.67 | 100.00 | 91.67 | N/A | 100.00 |
| docx | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| image | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 0.00 |
| pdf | 86.67 | 86.67 | 86.67 | 100.00 | 86.67 | N/A | 100.00 |
| text | 98.63 | 100.00 | 95.83 | 100.00 | 95.83 | 100.00 | 100.00 |
| xlsx | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 |

## 分桶：answerMode

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| choice | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | N/A |
| fill_blank | 83.33 | 83.33 | 83.33 | N/A | 83.33 | N/A | N/A |
| short_answer | 98.51 | 100.00 | 95.45 | N/A | 95.45 | N/A | N/A |
| true_false | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | N/A |

## 分桶：tag

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| chinese | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| chunk-boundary | 90.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |
| concentrated-answers | 100.00 | 100.00 | 75.00 | N/A | 75.00 | N/A | 100.00 |
| corrupt-input | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| cross-page | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |
| csv | 91.67 | 91.67 | 91.67 | 100.00 | 91.67 | N/A | 100.00 |
| docx | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| image | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 0.00 |
| long-material | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |
| long-stem | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |
| no-questions | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| no-source-answer | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| pdf | 83.33 | 83.33 | 83.33 | 100.00 | 83.33 | N/A | 100.00 |
| prompt-injection | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |
| regression | 97.83 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| repeated-stem | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| smoke | 95.83 | 95.83 | 95.83 | 100.00 | 95.83 | 100.00 | 54.55 |
| source-identity | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| synthetic | 97.06 | 97.78 | 95.56 | 100.00 | 95.56 | 100.00 | 54.55 |
| text | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 |
| xlsx | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 |

## 逐次案例

| 案例 | 次数 | 状态 | 预期结果匹配 | 耗时 ms | 差异 |
|---|---:|---|---|---:|---|
| text-basic | 1 | SUCCEEDED | True | 5102.39 |  |
| text-grouped | 1 | SUCCEEDED | True | 3593.53 |  |
| csv-basic | 1 | SUCCEEDED | True | 4975.75 |  |
| csv-quoted | 1 | SUCCEEDED | True | 3822.64 |  |
| xlsx-single-sheet | 1 | SUCCEEDED | True | 4070.40 |  |
| xlsx-multi-sheet | 1 | SUCCEEDED | True | 3739.74 |  |
| docx-table | 1 | SUCCEEDED | True | 8766.92 |  |
| docx-formula-image | 1 | SUCCEEDED | True | 6973.76 |  |
| pdf-text-layer | 1 | SUCCEEDED | True | 7553.60 |  |
| pdf-scanned | 1 | SUCCEEDED | True | 5817.51 |  |
| image-clean | 1 | SUCCEEDED | True | 6098.98 |  |
| image-two-column | 1 | SUCCEEDED | True | 9399.00 | visuals |
| text-chinese | 1 | SUCCEEDED | True | 3441.85 |  |
| text-no-answer | 1 | SUCCEEDED | True | 3571.71 |  |
| text-long-prefix | 1 | SUCCEEDED | True | 4441.88 |  |
| text-repeated-stem | 1 | SUCCEEDED | True | 4448.13 |  |
| text-multi-chunk | 1 | SUCCEEDED | True | 4144.90 |  |
| text-no-questions | 1 | ERROR | True | 1159.96 | NO_QUESTIONS_FOUND |
| docx-corrupt | 1 | ERROR | True | 12.05 | DOCUMENT_PROCESSING_FAILED |
| text-source-identity | 1 | SUCCEEDED | True | 5713.30 |  |
| text-document-instruction | 1 | SUCCEEDED | True | 3794.49 |  |
| text-concentrated-answers | 1 | SUCCEEDED | True | 6124.73 |  |
| pdf-long-material-answer-key | 1 | SUCCEEDED | True | 23955.97 |  |
| text-basic | 2 | SUCCEEDED | True | 4151.66 |  |
| text-grouped | 2 | SUCCEEDED | True | 3410.77 |  |
| csv-basic | 2 | SUCCEEDED | True | 4231.80 |  |
| csv-quoted | 2 | SUCCEEDED | True | 3335.78 |  |
| xlsx-single-sheet | 2 | SUCCEEDED | True | 4231.38 |  |
| xlsx-multi-sheet | 2 | SUCCEEDED | True | 3606.62 |  |
| docx-table | 2 | SUCCEEDED | True | 7769.16 |  |
| docx-formula-image | 2 | SUCCEEDED | True | 9217.34 |  |
| pdf-text-layer | 2 | SUCCEEDED | True | 7187.91 |  |
| pdf-scanned | 2 | SUCCEEDED | True | 6700.54 | q0: missing; qNone: extra |
| image-clean | 2 | SUCCEEDED | True | 3875.46 |  |
| image-two-column | 2 | SUCCEEDED | True | 11576.51 | visuals |
| text-chinese | 2 | SUCCEEDED | True | 3872.37 |  |
| text-no-answer | 2 | SUCCEEDED | True | 3871.63 |  |
| text-long-prefix | 2 | SUCCEEDED | True | 4611.18 |  |
| text-repeated-stem | 2 | SUCCEEDED | True | 2839.66 |  |
| text-multi-chunk | 2 | SUCCEEDED | True | 7366.78 |  |
| text-no-questions | 2 | ERROR | True | 1324.33 | NO_QUESTIONS_FOUND |
| docx-corrupt | 2 | ERROR | True | 6.48 | DOCUMENT_PROCESSING_FAILED |
| text-source-identity | 2 | SUCCEEDED | True | 10926.92 |  |
| text-document-instruction | 2 | SUCCEEDED | True | 3258.21 |  |
| text-concentrated-answers | 2 | SUCCEEDED | True | 4551.13 |  |
| pdf-long-material-answer-key | 2 | SUCCEEDED | True | 12895.42 |  |
| text-basic | 3 | SUCCEEDED | True | 3853.52 |  |
| text-grouped | 3 | SUCCEEDED | True | 3879.24 |  |
| csv-basic | 3 | SUCCEEDED | True | 4122.02 |  |
| csv-quoted | 3 | SUCCEEDED | True | 3937.09 | q0: missing; qNone: extra |
| xlsx-single-sheet | 3 | SUCCEEDED | True | 4281.22 |  |
| xlsx-multi-sheet | 3 | SUCCEEDED | True | 3899.33 |  |
| docx-table | 3 | SUCCEEDED | True | 3873.39 |  |
| docx-formula-image | 3 | SUCCEEDED | True | 7075.75 |  |
| pdf-text-layer | 3 | SUCCEEDED | True | 6402.75 |  |
| pdf-scanned | 3 | SUCCEEDED | True | 5374.98 | q0: missing; qNone: extra |
| image-clean | 3 | SUCCEEDED | True | 7965.63 |  |
| image-two-column | 3 | SUCCEEDED | True | 6551.10 | visuals |
| text-chinese | 3 | SUCCEEDED | True | 3917.43 |  |
| text-no-answer | 3 | SUCCEEDED | True | 4297.45 |  |
| text-long-prefix | 3 | SUCCEEDED | True | 4386.38 |  |
| text-repeated-stem | 3 | SUCCEEDED | True | 3514.72 |  |
| text-multi-chunk | 3 | SUCCEEDED | True | 9318.11 | qNone: extra |
| text-no-questions | 3 | ERROR | True | 1310.81 | NO_QUESTIONS_FOUND |
| docx-corrupt | 3 | ERROR | True | 6.16 | DOCUMENT_PROCESSING_FAILED |
| text-source-identity | 3 | SUCCEEDED | True | 11526.57 |  |
| text-document-instruction | 3 | SUCCEEDED | True | 3526.12 |  |
| text-concentrated-answers | 3 | SUCCEEDED | True | 4881.97 | q0: answerMode,answerPayload; q1: answerMode,answerPayload; q2: answerMode,answerPayload |
| pdf-long-material-answer-key | 3 | SUCCEEDED | True | 12452.97 |  |

Token 为已返回用量；complete=false 时不代表实际总消耗。视觉描述语义需人工复核。
完整逐题期望、实际值、阶段失败、耗时和版本信息见同名 JSON。
