# document_parser 评测

状态：**PASSED**

## 质量指标

| 指标 | 数值 |
|---|---:|
| questionPrecision | 100.00 |
| questionRecall | 100.00 |
| answerModeAccuracy | 100.00 |
| optionsAccuracy | N/A |
| parsedAnswerAccuracy | 100.00 |
| groupF1 | N/A |
| visualF1 | 100.00 |

## 调用与耗时

| 统计 | 数值 |
|---|---:|
| calls | 5 |
| responses | 5 |
| failedCalls | 0 |
| inputTokens | 25830 |
| outputTokens | 1669 |
| complete | True |
| missingUsageCalls | 0 |
| all.count | 2 |
| all.p50Ms | 8579.42 |
| all.p95Ms | 11929.34 |
| success.count | 2 |
| success.p50Ms | 8579.42 |
| success.p95Ms | 11929.34 |
| failure.count | 0 |
| failure.p50Ms | N/A |
| failure.p95Ms | N/A |

## 门禁原因


## 分桶：sourceType

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| docx | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |
| image | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |

## 分桶：answerMode

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| short_answer | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | N/A |
| true_false | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | N/A |

## 分桶：tag

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| docx | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |
| image | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |
| smoke | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |
| synthetic | 100.00 | 100.00 | 100.00 | N/A | 100.00 | N/A | 100.00 |

## 逐次案例

| 案例 | 次数 | 状态 | 预期结果匹配 | 耗时 ms | 差异 |
|---|---:|---|---|---:|---|
| docx-formula-image | 1 | SUCCEEDED | True | 4857.29 |  |
| image-two-column | 1 | SUCCEEDED | True | 12301.56 |  |

Token 为已返回用量；complete=false 时不代表实际总消耗。视觉描述语义需人工复核。
完整逐题期望、实际值、阶段失败、耗时和版本信息见同名 JSON。
