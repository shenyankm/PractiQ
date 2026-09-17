# document_parser 评测

状态：**FAILED**

## 质量指标

| 指标 | 数值 |
|---|---:|
| questionPrecision | 85.71 |
| questionRecall | 66.67 |
| answerModeAccuracy | 66.67 |
| optionsAccuracy | 66.67 |
| parsedAnswerAccuracy | 44.44 |
| groupF1 | N/A |
| visualF1 | 100.00 |

## 调用与耗时

| 统计 | 数值 |
|---|---:|
| calls | 15 |
| responses | 15 |
| failedCalls | 0 |
| inputTokens | 34379 |
| outputTokens | 51601 |
| complete | True |
| missingUsageCalls | 0 |
| all.count | 9 |
| all.p50Ms | 38239.67 |
| all.p95Ms | 126088.72 |
| success.count | 7 |
| success.p50Ms | 26928.04 |
| success.p95Ms | 70907.95 |
| failure.count | 2 |
| failure.p50Ms | 124725.39 |
| failure.p95Ms | 130860.37 |

## 门禁原因

- BELOW_TARGET:questionPrecision
- BELOW_TARGET:questionRecall
- BELOW_TARGET:answerModeAccuracy
- BELOW_TARGET:optionsAccuracy
- BELOW_TARGET:parsedAnswerAccuracy
- OUTCOME_MISMATCH:text-basic:1
- OUTCOME_MISMATCH:text-basic:3

## 分桶：sourceType

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| csv | 66.67 | 66.67 | 66.67 | N/A | 0.00 | N/A | 100.00 |
| text | 100.00 | 66.67 | 66.67 | 66.67 | 66.67 | N/A | 100.00 |

## 分桶：answerMode

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| choice | 100.00 | 66.67 | 66.67 | 66.67 | 66.67 | N/A | N/A |
| fill_blank | 33.33 | 33.33 | 33.33 | N/A | 0.00 | N/A | N/A |
| short_answer | 100.00 | 100.00 | 100.00 | N/A | 50.00 | N/A | N/A |
| true_false | 100.00 | 33.33 | 33.33 | N/A | 33.33 | N/A | N/A |

## 分桶：tag

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| csv | 66.67 | 66.67 | 66.67 | N/A | 0.00 | N/A | 100.00 |
| no-source-answer | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| regression | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| smoke | 75.00 | 50.00 | 50.00 | 33.33 | 16.67 | N/A | 100.00 |
| synthetic | 85.71 | 66.67 | 66.67 | 66.67 | 44.44 | N/A | 100.00 |
| text | 100.00 | 33.33 | 33.33 | 33.33 | 33.33 | N/A | 100.00 |

## 逐次案例

| 案例 | 次数 | 状态 | 预期结果匹配 | 耗时 ms | 差异 |
|---|---:|---|---|---:|---|
| text-basic | 1 | ERROR | False | 117908.75 | q0: missing; q1: missing; DOCUMENT_PARSE_FAILED |
| csv-quoted | 1 | SUCCEEDED | True | 26928.04 | q0: missing; q1: answerPayload; qNone: extra |
| text-no-answer | 1 | SUCCEEDED | True | 24470.29 |  |
| text-basic | 2 | SUCCEEDED | True | 84064.35 |  |
| csv-quoted | 2 | SUCCEEDED | True | 40209.69 | q0: answerPayload; q1: answerPayload |
| text-no-answer | 2 | SUCCEEDED | True | 38239.67 |  |
| text-basic | 3 | ERROR | False | 131542.04 | q0: missing; q1: missing; DOCUMENT_PARSE_FAILED |
| csv-quoted | 3 | SUCCEEDED | True | 18575.79 | q0: missing; q1: answerPayload; qNone: extra |
| text-no-answer | 3 | SUCCEEDED | True | 22829.47 |  |

Token 为已返回用量；complete=false 时不代表实际总消耗。视觉描述语义需人工复核。
完整逐题期望、实际值、阶段失败、耗时和版本信息见同名 JSON。
