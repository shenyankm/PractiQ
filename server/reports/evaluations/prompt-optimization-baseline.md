# document_parser 评测

状态：**FAILED**

## 质量指标

| 指标 | 数值 |
|---|---:|
| questionPrecision | 81.90 |
| questionRecall | 81.90 |
| answerModeAccuracy | 77.14 |
| optionsAccuracy | 83.33 |
| parsedAnswerAccuracy | 53.33 |
| groupF1 | 66.67 |
| visualF1 | 66.67 |

## 调用与耗时

| 统计 | 数值 |
|---|---:|
| calls | 102 |
| responses | 102 |
| failedCalls | 0 |
| inputTokens | 207740 |
| outputTokens | 176643 |
| complete | True |
| missingUsageCalls | 0 |
| all.count | 57 |
| all.p50Ms | 28060.32 |
| all.p95Ms | 66661.56 |
| success.count | 48 |
| success.p50Ms | 27273.39 |
| success.p95Ms | 61889.30 |
| failure.count | 9 |
| failure.p50Ms | 32625.54 |
| failure.p95Ms | 66522.72 |

## 门禁原因

- BELOW_TARGET:questionPrecision
- BELOW_TARGET:questionRecall
- BELOW_TARGET:answerModeAccuracy
- BELOW_TARGET:optionsAccuracy
- BELOW_TARGET:parsedAnswerAccuracy
- BELOW_TARGET:groupF1
- BELOW_TARGET:visualF1
- OUTCOME_MISMATCH:docx-formula-image:1
- OUTCOME_MISMATCH:text-no-questions:1
- OUTCOME_MISMATCH:docx-formula-image:2
- OUTCOME_MISMATCH:docx-formula-image:3
- CRITICAL_CASE_FAILED:text-repeated-stem:1
- CRITICAL_CASE_FAILED:text-multi-chunk:1
- CRITICAL_CASE_FAILED:text-chinese:2
- CRITICAL_CASE_FAILED:text-long-prefix:2
- CRITICAL_CASE_FAILED:text-repeated-stem:2
- CRITICAL_CASE_FAILED:text-multi-chunk:2
- CRITICAL_CASE_FAILED:text-long-prefix:3
- CRITICAL_CASE_FAILED:text-repeated-stem:3
- CRITICAL_CASE_FAILED:text-multi-chunk:3

## 分桶：sourceType

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| csv | 100.00 | 100.00 | 100.00 | 100.00 | 50.00 | N/A | 100.00 |
| docx | 91.67 | 91.67 | 91.67 | 100.00 | 58.33 | N/A | 0.00 |
| image | 66.67 | 66.67 | 66.67 | 66.67 | 58.33 | N/A | 100.00 |
| pdf | 58.33 | 58.33 | 58.33 | 66.67 | 50.00 | N/A | 100.00 |
| text | 80.00 | 80.00 | 68.89 | 77.78 | 42.22 | 0.00 | 100.00 |
| xlsx | 100.00 | 100.00 | 100.00 | 100.00 | 91.67 | 100.00 | 100.00 |

## 分桶：answerMode

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| choice | 83.33 | 83.33 | 83.33 | 83.33 | 66.67 | N/A | N/A |
| fill_blank | 44.44 | 44.44 | 44.44 | N/A | 33.33 | N/A | N/A |
| short_answer | 92.86 | 92.86 | 80.95 | N/A | 47.62 | N/A | N/A |
| true_false | 90.48 | 90.48 | 90.48 | N/A | 66.67 | N/A | N/A |

## 分桶：tag

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| chinese | 100.00 | 100.00 | 100.00 | 100.00 | 66.67 | N/A | 100.00 |
| chunk-boundary | 100.00 | 100.00 | 88.89 | N/A | 44.44 | N/A | 100.00 |
| corrupt-input | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| csv | 100.00 | 100.00 | 100.00 | 100.00 | 50.00 | N/A | 100.00 |
| docx | 91.67 | 91.67 | 91.67 | 100.00 | 58.33 | N/A | 0.00 |
| image | 66.67 | 66.67 | 66.67 | 66.67 | 58.33 | N/A | 100.00 |
| long-stem | 100.00 | 100.00 | 66.67 | N/A | 33.33 | N/A | 100.00 |
| no-questions | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| no-source-answer | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| pdf | 58.33 | 58.33 | 58.33 | 66.67 | 50.00 | N/A | 100.00 |
| regression | 100.00 | 100.00 | 84.85 | 100.00 | 48.48 | N/A | 100.00 |
| repeated-stem | 100.00 | 100.00 | 66.67 | N/A | 0.00 | N/A | 100.00 |
| smoke | 73.61 | 73.61 | 73.61 | 77.78 | 55.56 | 66.67 | 66.67 |
| synthetic | 81.90 | 81.90 | 77.14 | 83.33 | 53.33 | 66.67 | 66.67 |
| text | 25.00 | 25.00 | 25.00 | 33.33 | 25.00 | 0.00 | 100.00 |
| xlsx | 100.00 | 100.00 | 100.00 | 100.00 | 91.67 | 100.00 | 100.00 |

## 逐次案例

| 案例 | 次数 | 状态 | 预期结果匹配 | 耗时 ms | 差异 |
|---|---:|---|---|---:|---|
| text-basic | 1 | SUCCEEDED | True | 46329.03 |  |
| text-grouped | 1 | SUCCEEDED | True | 23334.19 | q0: missing; q1: missing; qNone: extra; qNone: extra; groups |
| csv-basic | 1 | SUCCEEDED | True | 33628.59 |  |
| csv-quoted | 1 | SUCCEEDED | True | 20072.42 | q0: answerPayload; q1: answerPayload |
| xlsx-single-sheet | 1 | SUCCEEDED | True | 20611.57 |  |
| xlsx-multi-sheet | 1 | SUCCEEDED | True | 16615.42 |  |
| docx-table | 1 | SUCCEEDED | True | 26486.46 |  |
| docx-formula-image | 1 | PARTIAL | False | 49797.29 | q0: answerPayload; q1: answerPayload; visuals |
| pdf-text-layer | 1 | SUCCEEDED | True | 17953.92 | q0: missing; q1: missing; qNone: extra; qNone: extra |
| pdf-scanned | 1 | SUCCEEDED | True | 41294.85 | q0: missing; qNone: extra |
| image-clean | 1 | SUCCEEDED | True | 30597.26 | q0: answerPayload; q1: missing; qNone: extra |
| image-two-column | 1 | SUCCEEDED | True | 66445.17 |  |
| text-chinese | 1 | SUCCEEDED | True | 28060.32 |  |
| text-no-answer | 1 | SUCCEEDED | True | 13707.61 |  |
| text-long-prefix | 1 | SUCCEEDED | True | 29645.68 |  |
| text-repeated-stem | 1 | SUCCEEDED | True | 14329.28 | q0: answerPayload; q1: answerPayload |
| text-multi-chunk | 1 | SUCCEEDED | True | 25445.23 | q2: answerPayload |
| text-no-questions | 1 | ERROR | False | 69900.47 | DOCUMENT_PARSE_FAILED |
| docx-corrupt | 1 | ERROR | True | 12.08 | DOCUMENT_PROCESSING_FAILED |
| text-basic | 2 | SUCCEEDED | True | 11361.20 | q0: missing; q1: missing; qNone: extra; qNone: extra |
| text-grouped | 2 | SUCCEEDED | True | 26100.95 | q0: missing; qNone: extra; groups |
| csv-basic | 2 | SUCCEEDED | True | 25416.17 | q0: answerPayload; q1: answerPayload |
| csv-quoted | 2 | SUCCEEDED | True | 21546.57 | q0: answerPayload; q1: answerPayload |
| xlsx-single-sheet | 2 | SUCCEEDED | True | 18561.71 | q0: answerPayload |
| xlsx-multi-sheet | 2 | SUCCEEDED | True | 21905.97 |  |
| docx-table | 2 | SUCCEEDED | True | 47531.42 |  |
| docx-formula-image | 2 | PARTIAL | False | 57127.46 | q0: answerPayload; q1: answerPayload; visuals |
| pdf-text-layer | 2 | SUCCEEDED | True | 11543.26 |  |
| pdf-scanned | 2 | SUCCEEDED | True | 67527.11 | q0: missing; qNone: extra |
| image-clean | 2 | SUCCEEDED | True | 40768.06 | q0: missing; q1: missing; qNone: extra; qNone: extra |
| image-two-column | 2 | SUCCEEDED | True | 53231.10 |  |
| text-chinese | 2 | SUCCEEDED | True | 39127.16 | q0: answerPayload; q1: answerPayload |
| text-no-answer | 2 | SUCCEEDED | True | 21766.35 |  |
| text-long-prefix | 2 | SUCCEEDED | True | 21225.11 | q0: answerPayload; q1: answerPayload |
| text-repeated-stem | 2 | SUCCEEDED | True | 22725.17 | q0: answerPayload; q1: answerPayload |
| text-multi-chunk | 2 | SUCCEEDED | True | 28360.24 | q0: answerPayload; q1: answerPayload; q2: answerMode,answerPayload |
| text-no-questions | 2 | ERROR | True | 32625.54 | NO_QUESTIONS_FOUND |
| docx-corrupt | 2 | ERROR | True | 7.68 | DOCUMENT_PROCESSING_FAILED |
| text-basic | 3 | SUCCEEDED | True | 46463.54 | q0: missing; q1: missing; qNone: extra; qNone: extra |
| text-grouped | 3 | SUCCEEDED | True | 28116.00 | q0: missing; q1: missing; qNone: extra; qNone: extra; groups |
| csv-basic | 3 | SUCCEEDED | True | 28481.49 |  |
| csv-quoted | 3 | SUCCEEDED | True | 36398.63 |  |
| xlsx-single-sheet | 3 | SUCCEEDED | True | 23393.41 |  |
| xlsx-multi-sheet | 3 | SUCCEEDED | True | 40745.57 |  |
| docx-table | 3 | SUCCEEDED | True | 48485.08 | q1: missing; qNone: extra |
| docx-formula-image | 3 | PARTIAL | False | 61456.10 | visuals |
| pdf-text-layer | 3 | SUCCEEDED | True | 19672.35 |  |
| pdf-scanned | 3 | SUCCEEDED | True | 53428.39 | q0: missing; q1: answerPayload; qNone: extra |
| image-clean | 3 | SUCCEEDED | True | 36185.98 | q1: missing; qNone: extra |
| image-two-column | 3 | SUCCEEDED | True | 68864.43 |  |
| text-chinese | 3 | SUCCEEDED | True | 21779.53 |  |
| text-no-answer | 3 | SUCCEEDED | True | 15489.41 |  |
| text-long-prefix | 3 | SUCCEEDED | True | 31736.73 | q0: answerMode,answerPayload; q1: answerMode,answerPayload |
| text-repeated-stem | 3 | SUCCEEDED | True | 25177.67 | q0: answerMode,answerPayload; q1: answerMode,answerPayload |
| text-multi-chunk | 3 | SUCCEEDED | True | 50306.80 | q2: answerPayload |
| text-no-questions | 3 | ERROR | True | 25565.85 | NO_QUESTIONS_FOUND |
| docx-corrupt | 3 | ERROR | True | 10.58 | DOCUMENT_PROCESSING_FAILED |

Token 为已返回用量；complete=false 时不代表实际总消耗。视觉描述语义需人工复核。
完整逐题期望、实际值、阶段失败、耗时和版本信息见同名 JSON。
