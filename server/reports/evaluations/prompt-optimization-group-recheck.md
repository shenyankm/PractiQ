# document_parser 评测

状态：**FAILED**

## 质量指标

| 指标 | 数值 |
|---|---:|
| questionPrecision | 100.00 |
| questionRecall | 88.89 |
| answerModeAccuracy | 88.89 |
| optionsAccuracy | N/A |
| parsedAnswerAccuracy | 66.67 |
| groupF1 | 94.12 |
| visualF1 | 100.00 |

## 调用与耗时

| 统计 | 数值 |
|---|---:|
| calls | 12 |
| responses | 12 |
| failedCalls | 0 |
| inputTokens | 25615 |
| outputTokens | 34345 |
| complete | True |
| missingUsageCalls | 0 |
| all.count | 9 |
| all.p50Ms | 28304.52 |
| all.p95Ms | 99978.38 |
| success.count | 8 |
| success.p50Ms | 26301.41 |
| success.p95Ms | 33947.04 |
| failure.count | 1 |
| failure.p50Ms | 142774.60 |
| failure.p95Ms | 142774.60 |

## 门禁原因

- BELOW_TARGET:questionRecall
- BELOW_TARGET:answerModeAccuracy
- BELOW_TARGET:parsedAnswerAccuracy
- OUTCOME_MISMATCH:text-grouped:1

## 分桶：sourceType

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| text | 100.00 | 83.33 | 83.33 | N/A | 66.67 | 80.00 | 100.00 |
| xlsx | 100.00 | 100.00 | 100.00 | N/A | 66.67 | 100.00 | 100.00 |

## 分桶：answerMode

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| fill_blank | 100.00 | 66.67 | 66.67 | N/A | 33.33 | N/A | N/A |
| short_answer | 100.00 | 91.67 | 91.67 | N/A | 75.00 | N/A | N/A |
| true_false | 100.00 | 100.00 | 100.00 | N/A | 66.67 | N/A | N/A |

## 分桶：tag

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| regression | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |
| repeated-stem | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |
| smoke | 100.00 | 83.33 | 83.33 | N/A | 50.00 | 94.12 | 100.00 |
| synthetic | 100.00 | 88.89 | 88.89 | N/A | 66.67 | 94.12 | 100.00 |
| text | 100.00 | 66.67 | 66.67 | N/A | 33.33 | 80.00 | 100.00 |
| xlsx | 100.00 | 100.00 | 100.00 | N/A | 66.67 | 100.00 | 100.00 |

## 逐次案例

| 案例 | 次数 | 状态 | 预期结果匹配 | 耗时 ms | 差异 |
|---|---:|---|---|---:|---|
| text-grouped | 1 | ERROR | False | 142774.60 | q0: missing; q1: missing; groups; DOCUMENT_PARSE_FAILED |
| xlsx-multi-sheet | 1 | SUCCEEDED | True | 35784.06 | q0: answerPayload; q1: answerPayload |
| text-repeated-stem | 1 | SUCCEEDED | True | 28304.52 |  |
| text-grouped | 2 | SUCCEEDED | True | 23816.33 |  |
| xlsx-multi-sheet | 2 | SUCCEEDED | True | 30535.44 |  |
| text-repeated-stem | 2 | SUCCEEDED | True | 29180.99 |  |
| text-grouped | 3 | SUCCEEDED | True | 24298.30 | q0: answerPayload; q1: answerPayload |
| xlsx-multi-sheet | 3 | SUCCEEDED | True | 23937.23 |  |
| text-repeated-stem | 3 | SUCCEEDED | True | 18371.52 |  |

Token 为已返回用量；complete=false 时不代表实际总消耗。视觉描述语义需人工复核。
完整逐题期望、实际值、阶段失败、耗时和版本信息见同名 JSON。
