# document_parser 评测

状态：**FAILED**

## 质量指标

| 指标 | 数值 |
|---|---:|
| questionPrecision | 97.04 |
| questionRecall | 97.04 |
| answerModeAccuracy | 94.81 |
| optionsAccuracy | 100.00 |
| parsedAnswerAccuracy | 94.81 |
| groupF1 | 100.00 |
| visualF1 | 60.00 |

## 调用与耗时

| 统计 | 数值 |
|---|---:|
| calls | 103 |
| responses | 103 |
| failedCalls | 0 |
| inputTokens | 578287 |
| outputTokens | 28944 |
| complete | True |
| missingUsageCalls | 0 |
| all.count | 69 |
| all.p50Ms | 4434.04 |
| all.p95Ms | 10880.44 |
| success.count | 63 |
| success.p50Ms | 4645.48 |
| success.p95Ms | 10900.26 |
| failure.count | 6 |
| failure.p50Ms | 382.78 |
| failure.p95Ms | 1296.44 |

## 门禁原因

- BELOW_TARGET:visualF1
- CRITICAL_CASE_FAILED:text-concentrated-answers:1

## 分桶：sourceType

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| csv | 91.67 | 91.67 | 91.67 | 100.00 | 91.67 | N/A | 100.00 |
| docx | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| image | 91.67 | 91.67 | 91.67 | 100.00 | 91.67 | N/A | 0.00 |
| pdf | 86.67 | 86.67 | 86.67 | 100.00 | 86.67 | N/A | 100.00 |
| text | 100.00 | 100.00 | 95.83 | 100.00 | 95.83 | 100.00 | 100.00 |
| xlsx | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 |

## 分桶：answerMode

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| choice | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | N/A |
| fill_blank | 77.78 | 77.78 | 77.78 | N/A | 77.78 | N/A | N/A |
| short_answer | 100.00 | 100.00 | 95.45 | N/A | 95.45 | N/A | N/A |
| true_false | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | N/A |

## 分桶：tag

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| chinese | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| chunk-boundary | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |
| concentrated-answers | 100.00 | 100.00 | 75.00 | N/A | 75.00 | N/A | 100.00 |
| corrupt-input | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| cross-page | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |
| csv | 91.67 | 91.67 | 91.67 | 100.00 | 91.67 | N/A | 100.00 |
| docx | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| image | 91.67 | 91.67 | 91.67 | 100.00 | 91.67 | N/A | 0.00 |
| long-material | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |
| long-stem | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |
| no-questions | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| no-source-answer | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| pdf | 83.33 | 83.33 | 83.33 | 100.00 | 83.33 | N/A | 100.00 |
| prompt-injection | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |
| regression | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| repeated-stem | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| smoke | 94.44 | 94.44 | 94.44 | 100.00 | 94.44 | 100.00 | 60.00 |
| source-identity | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| synthetic | 97.04 | 97.04 | 94.81 | 100.00 | 94.81 | 100.00 | 60.00 |
| text | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 |
| xlsx | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 |

## 逐次案例

| 案例 | 次数 | 状态 | 预期结果匹配 | 耗时 ms | 差异 |
|---|---:|---|---|---:|---|
| text-basic | 1 | SUCCEEDED | True | 4929.61 |  |
| text-grouped | 1 | SUCCEEDED | True | 3983.30 |  |
| csv-basic | 1 | SUCCEEDED | True | 4360.05 |  |
| csv-quoted | 1 | SUCCEEDED | True | 4138.56 |  |
| xlsx-single-sheet | 1 | SUCCEEDED | True | 4172.99 |  |
| xlsx-multi-sheet | 1 | SUCCEEDED | True | 3883.51 |  |
| docx-table | 1 | SUCCEEDED | True | 10906.87 |  |
| docx-formula-image | 1 | SUCCEEDED | True | 7347.00 |  |
| pdf-text-layer | 1 | SUCCEEDED | True | 7323.62 |  |
| pdf-scanned | 1 | SUCCEEDED | True | 7327.61 |  |
| image-clean | 1 | SUCCEEDED | True | 7171.84 |  |
| image-two-column | 1 | SUCCEEDED | True | 6684.98 | visuals |
| text-chinese | 1 | SUCCEEDED | True | 4518.93 |  |
| text-no-answer | 1 | SUCCEEDED | True | 3857.38 |  |
| text-long-prefix | 1 | SUCCEEDED | True | 4685.98 |  |
| text-repeated-stem | 1 | SUCCEEDED | True | 3547.48 |  |
| text-multi-chunk | 1 | SUCCEEDED | True | 8284.70 |  |
| text-no-questions | 1 | ERROR | True | 1071.60 | NO_QUESTIONS_FOUND |
| docx-corrupt | 1 | ERROR | True | 8.93 | DOCUMENT_PROCESSING_FAILED |
| text-source-identity | 1 | SUCCEEDED | True | 10840.79 |  |
| text-document-instruction | 1 | SUCCEEDED | True | 4111.93 |  |
| text-concentrated-answers | 1 | SUCCEEDED | True | 5320.32 | q0: answerMode,answerPayload; q1: answerMode,answerPayload; q2: answerMode,answerPayload |
| pdf-long-material-answer-key | 1 | SUCCEEDED | True | 9440.15 |  |
| text-basic | 2 | SUCCEEDED | True | 4092.64 |  |
| text-grouped | 2 | SUCCEEDED | True | 3595.74 |  |
| csv-basic | 2 | SUCCEEDED | True | 4283.24 |  |
| csv-quoted | 2 | SUCCEEDED | True | 3336.23 | q0: missing; qNone: extra |
| xlsx-single-sheet | 2 | SUCCEEDED | True | 5440.16 |  |
| xlsx-multi-sheet | 2 | SUCCEEDED | True | 4460.75 |  |
| docx-table | 2 | SUCCEEDED | True | 9496.93 |  |
| docx-formula-image | 2 | SUCCEEDED | True | 8029.23 |  |
| pdf-text-layer | 2 | SUCCEEDED | True | 6244.61 |  |
| pdf-scanned | 2 | SUCCEEDED | True | 6140.12 | q0: missing; qNone: extra |
| image-clean | 2 | SUCCEEDED | True | 10496.59 |  |
| image-two-column | 2 | SUCCEEDED | True | 8846.35 | visuals |
| text-chinese | 2 | SUCCEEDED | True | 3932.34 |  |
| text-no-answer | 2 | SUCCEEDED | True | 3484.17 |  |
| text-long-prefix | 2 | SUCCEEDED | True | 4318.35 |  |
| text-repeated-stem | 2 | SUCCEEDED | True | 3275.99 |  |
| text-multi-chunk | 2 | SUCCEEDED | True | 3748.82 |  |
| text-no-questions | 2 | ERROR | True | 756.25 | NO_QUESTIONS_FOUND |
| docx-corrupt | 2 | ERROR | True | 4.75 | DOCUMENT_PROCESSING_FAILED |
| text-source-identity | 2 | SUCCEEDED | True | 10738.97 |  |
| text-document-instruction | 2 | SUCCEEDED | True | 3094.95 |  |
| text-concentrated-answers | 2 | SUCCEEDED | True | 4645.48 |  |
| pdf-long-material-answer-key | 2 | SUCCEEDED | True | 11210.87 |  |
| text-basic | 3 | SUCCEEDED | True | 4000.38 |  |
| text-grouped | 3 | SUCCEEDED | True | 3555.17 |  |
| csv-basic | 3 | SUCCEEDED | True | 3704.86 |  |
| csv-quoted | 3 | SUCCEEDED | True | 3200.24 |  |
| xlsx-single-sheet | 3 | SUCCEEDED | True | 3937.76 |  |
| xlsx-multi-sheet | 3 | SUCCEEDED | True | 3448.75 |  |
| docx-table | 3 | SUCCEEDED | True | 7901.21 |  |
| docx-formula-image | 3 | SUCCEEDED | True | 7640.53 |  |
| pdf-text-layer | 3 | SUCCEEDED | True | 10055.62 |  |
| pdf-scanned | 3 | SUCCEEDED | True | 6484.78 | q0: missing; qNone: extra |
| image-clean | 3 | SUCCEEDED | True | 6090.40 | q1: missing; qNone: extra |
| image-two-column | 3 | SUCCEEDED | True | 5838.08 | visuals |
| text-chinese | 3 | SUCCEEDED | True | 5080.56 |  |
| text-no-answer | 3 | SUCCEEDED | True | 3420.55 |  |
| text-long-prefix | 3 | SUCCEEDED | True | 4434.04 |  |
| text-repeated-stem | 3 | SUCCEEDED | True | 2937.01 |  |
| text-multi-chunk | 3 | SUCCEEDED | True | 3867.79 |  |
| text-no-questions | 3 | ERROR | True | 1371.39 | NO_QUESTIONS_FOUND |
| docx-corrupt | 3 | ERROR | True | 9.31 | DOCUMENT_PROCESSING_FAILED |
| text-source-identity | 3 | SUCCEEDED | True | 12052.46 |  |
| text-document-instruction | 3 | SUCCEEDED | True | 3262.68 |  |
| text-concentrated-answers | 3 | SUCCEEDED | True | 7520.90 |  |
| pdf-long-material-answer-key | 3 | SUCCEEDED | True | 12847.99 |  |

Token 为已返回用量；complete=false 时不代表实际总消耗。视觉描述语义需人工复核。
完整逐题期望、实际值、阶段失败、耗时和版本信息见同名 JSON。
