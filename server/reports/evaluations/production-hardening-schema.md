# document_parser 评测

状态：**PASSED**

## 质量指标

| 指标 | 数值 |
|---|---:|
| questionPrecision | 100.00 |
| questionRecall | 100.00 |
| answerModeAccuracy | 100.00 |
| optionsAccuracy | 100.00 |
| parsedAnswerAccuracy | 100.00 |
| groupF1 | N/A |
| visualF1 | 100.00 |

## 调用与耗时

| 统计 | 数值 |
|---|---:|
| calls | 7 |
| responses | 7 |
| failedCalls | 0 |
| inputTokens | 51065 |
| outputTokens | 1171 |
| complete | True |
| missingUsageCalls | 0 |
| all.count | 4 |
| all.p50Ms | 4215.62 |
| all.p95Ms | 10701.70 |
| success.count | 4 |
| success.p50Ms | 4215.62 |
| success.p95Ms | 10701.70 |
| failure.count | 0 |
| failure.p50Ms | N/A |
| failure.p95Ms | N/A |

## 门禁原因


## 分桶：sourceType

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| csv | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| pdf | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |
| text | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |

## 分桶：answerMode

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| choice | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | N/A |
| short_answer | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | N/A |
| true_false | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | N/A |

## 分桶：tag

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| chinese | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| concentrated-answers | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |
| cross-page | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |
| csv | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| long-material | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |
| no-source-answer | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| regression | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| smoke | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |
| synthetic | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | N/A | 100.00 |

## 逐次案例

| 案例 | 次数 | 状态 | 预期结果匹配 | 耗时 ms | 差异 |
|---|---:|---|---|---:|---|
| csv-basic | 1 | SUCCEEDED | True | 4779.70 |  |
| text-chinese | 1 | SUCCEEDED | True | 3647.24 |  |
| text-no-answer | 1 | SUCCEEDED | True | 3651.54 |  |
| pdf-long-material-answer-key | 1 | SUCCEEDED | True | 11746.76 |  |

Token 为已返回用量；complete=false 时不代表实际总消耗。视觉描述语义需人工复核。
完整逐题期望、实际值、阶段失败、耗时和版本信息见同名 JSON。
