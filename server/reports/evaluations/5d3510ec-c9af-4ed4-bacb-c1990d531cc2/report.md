# document_parser 评测

状态：**FAILED**

## 质量指标

| 指标 | 数值 |
|---|---:|
| questionPrecision | 0.00 |
| questionRecall | 0.00 |
| answerModeAccuracy | 0.00 |
| optionsAccuracy | 0.00 |
| parsedAnswerAccuracy | 0.00 |
| groupF1 | N/A |
| visualF1 | 100.00 |

## 调用与耗时

| 统计 | 数值 |
|---|---:|
| calls | 1 |
| responses | 1 |
| failedCalls | 0 |
| inputTokens | 1710 |
| outputTokens | 2383 |
| complete | True |
| missingUsageCalls | 0 |
| all.count | 1 |
| all.p50Ms | 24242.32 |
| all.p95Ms | 24242.32 |
| success.count | 1 |
| success.p50Ms | 24242.32 |
| success.p95Ms | 24242.32 |
| failure.count | 0 |
| failure.p50Ms | N/A |
| failure.p95Ms | N/A |

## 门禁原因

- BELOW_TARGET:questionPrecision
- BELOW_TARGET:questionRecall
- BELOW_TARGET:answerModeAccuracy
- BELOW_TARGET:optionsAccuracy
- BELOW_TARGET:parsedAnswerAccuracy

## 分桶：sourceType

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| text | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | N/A | 100.00 |

## 分桶：answerMode

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| choice | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | N/A | N/A |
| true_false | 0.00 | 0.00 | 0.00 | N/A | 0.00 | N/A | N/A |

## 分桶：tag

| 分组 | questionPrecision | questionRecall | answerModeAccuracy | optionsAccuracy | parsedAnswerAccuracy | groupF1 | visualF1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| smoke | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | N/A | 100.00 |
| synthetic | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | N/A | 100.00 |
| text | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | N/A | 100.00 |

## 逐次案例

| 案例 | 次数 | 状态 | 预期结果匹配 | 耗时 ms | 差异 |
|---|---:|---|---|---:|---|
| text-basic | 1 | SUCCEEDED | True | 24242.32 | q0: missing; q1: missing; qNone: extra; qNone: extra |

Token 为已返回用量；complete=false 时不代表实际总消耗。视觉描述语义需人工复核。
完整逐题期望、实际值、阶段失败、耗时和版本信息见同名 JSON。
