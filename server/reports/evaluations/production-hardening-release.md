# document_parser 评测

状态：**FAILED**

## 质量指标

| 指标 | 数值 |
|---|---:|
| questionPrecision | 99.23 |
| questionRecall | 95.56 |
| answerModeAccuracy | 95.56 |
| optionsAccuracy | 100.00 |
| parsedAnswerAccuracy | 94.81 |
| groupF1 | 100.00 |
| visualF1 | 66.67 |

## 调用与耗时

| 统计 | 数值 |
|---|---:|
| calls | 102 |
| responses | 102 |
| failedCalls | 0 |
| inputTokens | 578955 |
| outputTokens | 29250 |
| complete | True |
| missingUsageCalls | 0 |
| all.count | 69 |
| all.p50Ms | 4451.15 |
| all.p95Ms | 12032.84 |
| success.count | 60 |
| success.p50Ms | 4524.45 |
| success.p95Ms | 11069.18 |
| failure.count | 9 |
| failure.p50Ms | 914.07 |
| failure.p95Ms | 14042.87 |

## 门禁原因

- BELOW_TARGET:visualF1
- OUTCOME_MISMATCH:image-two-column:1
- OUTCOME_MISMATCH:image-two-column:2
- OUTCOME_MISMATCH:docx-formula-image:3
- CRITICAL_CASE_FAILED:pdf-long-material-answer-key:2

## 分桶：sourceType

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| csv | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| docx | 100.00 | 83.33 | 83.33 | 100.00 | 83.33 | N/A | 80.00 |
| image | 100.00 | 66.67 | 66.67 | 100.00 | 66.67 | N/A | 50.00 |
| pdf | 93.75 | 100.00 | 100.00 | 100.00 | 93.33 | N/A | 100.00 |
| text | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 |
| xlsx | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 |

## 分桶：answerMode

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| choice | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | N/A |
| fill_blank | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | N/A |
| short_answer | 98.44 | 95.45 | 95.45 | N/A | 93.94 | N/A | N/A |
| true_false | 100.00 | 85.71 | 85.71 | N/A | 85.71 | N/A | N/A |

## 分桶：tag

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| chinese | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| chunk-boundary | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |
| concentrated-answers | 92.31 | 100.00 | 100.00 | N/A | 91.67 | N/A | 100.00 |
| corrupt-input | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| cross-page | 75.00 | 100.00 | 100.00 | N/A | 66.67 | N/A | 100.00 |
| csv | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| docx | 100.00 | 83.33 | 83.33 | 100.00 | 83.33 | N/A | 80.00 |
| image | 100.00 | 66.67 | 66.67 | 100.00 | 66.67 | N/A | 50.00 |
| long-material | 75.00 | 100.00 | 100.00 | N/A | 66.67 | N/A | 100.00 |
| long-stem | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |
| no-questions | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| no-source-answer | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| pdf | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| prompt-injection | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |
| regression | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| repeated-stem | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| smoke | 100.00 | 91.67 | 91.67 | 100.00 | 91.67 | 100.00 | 66.67 |
| source-identity | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| synthetic | 99.23 | 95.56 | 95.56 | 100.00 | 94.81 | 100.00 | 66.67 |
| text | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 |
| xlsx | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 |

## 逐次案例

| 案例 | 次数 | 状态 | 预期结果匹配 | 耗时 ms | 差异 |
|---|---:|---|---|---:|---|
| text-basic | 1 | SUCCEEDED | True | 4343.26 |  |
| text-grouped | 1 | SUCCEEDED | True | 4646.94 |  |
| csv-basic | 1 | SUCCEEDED | True | 4359.20 |  |
| csv-quoted | 1 | SUCCEEDED | True | 3261.11 |  |
| xlsx-single-sheet | 1 | SUCCEEDED | True | 4607.59 |  |
| xlsx-multi-sheet | 1 | SUCCEEDED | True | 3580.96 |  |
| docx-table | 1 | SUCCEEDED | True | 4706.84 |  |
| docx-formula-image | 1 | SUCCEEDED | True | 5964.06 |  |
| pdf-text-layer | 1 | SUCCEEDED | True | 7306.35 |  |
| pdf-scanned | 1 | SUCCEEDED | True | 6294.34 |  |
| image-clean | 1 | SUCCEEDED | True | 7177.59 |  |
| image-two-column | 1 | ERROR | False | 14198.76 | q0: missing; q1: missing; visuals; DOCUMENT_PARSE_FAILED |
| text-chinese | 1 | SUCCEEDED | True | 3630.85 |  |
| text-no-answer | 1 | SUCCEEDED | True | 3904.86 |  |
| text-long-prefix | 1 | SUCCEEDED | True | 4534.82 |  |
| text-repeated-stem | 1 | SUCCEEDED | True | 3191.18 |  |
| text-multi-chunk | 1 | SUCCEEDED | True | 7806.27 |  |
| text-no-questions | 1 | ERROR | True | 914.07 | NO_QUESTIONS_FOUND |
| docx-corrupt | 1 | ERROR | True | 5.47 | DOCUMENT_PROCESSING_FAILED |
| text-source-identity | 1 | SUCCEEDED | True | 5845.71 |  |
| text-document-instruction | 1 | SUCCEEDED | True | 3672.21 |  |
| text-concentrated-answers | 1 | SUCCEEDED | True | 4613.55 |  |
| pdf-long-material-answer-key | 1 | SUCCEEDED | True | 15166.68 |  |
| text-basic | 2 | SUCCEEDED | True | 4130.69 |  |
| text-grouped | 2 | SUCCEEDED | True | 4039.03 |  |
| csv-basic | 2 | SUCCEEDED | True | 3742.41 |  |
| csv-quoted | 2 | SUCCEEDED | True | 3500.34 |  |
| xlsx-single-sheet | 2 | SUCCEEDED | True | 3996.50 |  |
| xlsx-multi-sheet | 2 | SUCCEEDED | True | 4133.07 |  |
| docx-table | 2 | SUCCEEDED | True | 9595.19 |  |
| docx-formula-image | 2 | SUCCEEDED | True | 5142.31 |  |
| pdf-text-layer | 2 | SUCCEEDED | True | 7235.11 |  |
| pdf-scanned | 2 | SUCCEEDED | True | 5558.75 |  |
| image-clean | 2 | SUCCEEDED | True | 7061.37 |  |
| image-two-column | 2 | ERROR | False | 13809.03 | q0: missing; q1: missing; visuals; DOCUMENT_PARSE_FAILED |
| text-chinese | 2 | SUCCEEDED | True | 3609.73 |  |
| text-no-answer | 2 | SUCCEEDED | True | 3552.55 |  |
| text-long-prefix | 2 | SUCCEEDED | True | 4837.35 |  |
| text-repeated-stem | 2 | SUCCEEDED | True | 3115.56 |  |
| text-multi-chunk | 2 | SUCCEEDED | True | 7506.67 |  |
| text-no-questions | 2 | ERROR | True | 863.21 | NO_QUESTIONS_FOUND |
| docx-corrupt | 2 | ERROR | True | 6.26 | DOCUMENT_PROCESSING_FAILED |
| text-source-identity | 2 | SUCCEEDED | True | 11041.73 |  |
| text-document-instruction | 2 | SUCCEEDED | True | 3326.43 |  |
| text-concentrated-answers | 2 | SUCCEEDED | True | 4514.07 |  |
| pdf-long-material-answer-key | 2 | SUCCEEDED | True | 11590.77 | q0: answerPayload; qNone: extra |
| text-basic | 3 | SUCCEEDED | True | 4709.87 |  |
| text-grouped | 3 | SUCCEEDED | True | 3964.96 |  |
| csv-basic | 3 | SUCCEEDED | True | 4451.15 |  |
| csv-quoted | 3 | SUCCEEDED | True | 3414.62 |  |
| xlsx-single-sheet | 3 | SUCCEEDED | True | 4208.53 |  |
| xlsx-multi-sheet | 3 | SUCCEEDED | True | 3384.92 |  |
| docx-table | 3 | SUCCEEDED | True | 7543.04 |  |
| docx-formula-image | 3 | ERROR | False | 8815.35 | q0: missing; q1: missing; visuals; DOCUMENT_PARSE_FAILED |
| pdf-text-layer | 3 | SUCCEEDED | True | 6519.20 |  |
| pdf-scanned | 3 | SUCCEEDED | True | 7205.23 |  |
| image-clean | 3 | SUCCEEDED | True | 6126.49 |  |
| image-two-column | 3 | SUCCEEDED | True | 7184.96 |  |
| text-chinese | 3 | SUCCEEDED | True | 3881.42 |  |
| text-no-answer | 3 | SUCCEEDED | True | 3534.29 |  |
| text-long-prefix | 3 | SUCCEEDED | True | 4250.55 |  |
| text-repeated-stem | 3 | SUCCEEDED | True | 3391.88 |  |
| text-multi-chunk | 3 | SUCCEEDED | True | 3463.11 |  |
| text-no-questions | 3 | ERROR | True | 1058.00 | NO_QUESTIONS_FOUND |
| docx-corrupt | 3 | ERROR | True | 9.11 | DOCUMENT_PROCESSING_FAILED |
| text-source-identity | 3 | SUCCEEDED | True | 10517.64 |  |
| text-document-instruction | 3 | SUCCEEDED | True | 3577.53 |  |
| text-concentrated-answers | 3 | SUCCEEDED | True | 6140.65 |  |
| pdf-long-material-answer-key | 3 | SUCCEEDED | True | 12327.56 |  |

Token 为已返回用量；complete=false 时不代表实际总消耗。视觉描述语义需人工复核。
完整逐题期望、实际值、阶段失败、耗时和版本信息见同名 JSON。
