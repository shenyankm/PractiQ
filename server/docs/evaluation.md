# document_parser 评测与改进

以下命令使用已有 Python 3.14+ 环境，并在 `server/` 下运行。

评测沿用真实的本地文件写入和 `document_parser`，在本地直接调用 Graph，使用内存 checkpoint。
它评估文档中题目与原文答案的提取质量；Agent Server HTTP、持久恢复和容量由现有工程测试及压测负责。
本评测不接入 LangSmith，不使用 LLM 裁判，也不自动修改提示词或发布版本。

## 数据集与人工金标

`evals/cases.json` 使用 `schemaVersion: 2`，目前包含 20 份公开合成文档。
保留 Text、CSV、XLSX、DOCX、PDF、Image 六种格式，增加中文、原文无答案、长题干相同前缀、
合法重复题、跨分片长文、无题目文本、损坏 DOCX 七类回归案例，并增加大小写不同、同题干不同选项的来源身份案例。

- `id` 是稳定且唯一的案例标识；`path` 必须指向清单目录内部的文件，禁止路径和符号链接逃逸。
- `tags` 用于按场景分桶，`critical: true` 表示该案例任一已标注字段或结构出错即失败。
- 正常案例必须标注 `expectedQuestions`，并预期 `SUCCEEDED`。
- 拒绝案例只标注 `expectedError: {"code": "NO_QUESTIONS_FOUND", "statusCode": 422}` 等错误，
  两个值必须同时匹配；外部服务不可用不能标为预期成功。
- `expectedGroups` 标注标题及从 0 开始的题目索引；`expectedVisualKinds` 标注视觉类别和数量。
  两者省略或为 `null` 表示未标注，`[]` 表示明确要求不存在该结构。
- `stemAliases`、`answerAliases` 仅允许根据原文确认的等价形式，例如乘除号的 LaTeX 写法、
  化学式下标。别名必须遵守原题型契约；原文无答案时不得添加答案别名。

金标依据源文件人工核对，不能把模型输出直接反填为正确答案。
当前 DOCX 内嵌图片的公开输出类别固定为 `image`，其金标按该契约标注；
扫描页的图形仍按 视觉模型输出的 `diagram` 等类别评估。视觉描述语义由人工复核。

维护数据集后执行：

```bash
python scripts/evaluate.py --validate-only
python -m pytest tests/test_evaluation.py
```

CI 同时检查六种格式、四种题型、七类难例，以及每个 fixture 都有对应清单项。
清单校验器本身支持任意非空规模，方便临时小集调试。

## 评分与门禁

题干匹配仅删除开头题号及排版空白，保留大小写、标点与完整内容，不使用截断或忽略大小写的题干键；生产去重还要求原文位置与实际分片重叠一致。
同题干按出现顺序一一匹配；额外题目降低 Precision，缺失题目降低 Recall 和字段准确率。
选项按顺序比较 label/content，答案采用与原文金标一致的结构化值。

| 指标 | 分子 / 分母 |
|---|---|
| questionPrecision | 匹配题目 / 输出题目 |
| questionRecall | 匹配题目 / 金标题目 |
| answerModeAccuracy | 题型正确题目 / 金标题目 |
| optionsAccuracy | 选项正确的选择题 / 金标选择题 |
| parsedAnswerAccuracy | 原文答案正确题目 / 金标题目，包含空答案 |
| groupF1 | 2 × 完整匹配分组 /（金标分组 + 输出分组），同时检查标题和成员 |
| visualF1 | 2 × 匹配视觉元素 /（金标元素 + 输出元素），按类别多重集计数 |

各指标均为 0–100。没有分母时显示 N/A；明确标注结构为空且输出也为空时，该结构得分为 100。
总体指标按题目或结构微平均，同时给出格式、题型和标签分桶。

门禁要求：所有有标注的总体质量指标至少 90%；正常案例全部 `SUCCEEDED`；
预期拒绝案例全部匹配；关键案例没有差异；任何原文无答案的匹配题都不得补造答案。
`PARTIAL` 保留结果及阶段失败，但不计作正常案例成功。

| 状态 / 退出码 | 含义 |
|---|---|
| PASSED / 0 | 本次门禁通过；指定有效基线时也没有指标回退 |
| FAILED / 1 | 质量、预期状态、关键案例或不回退门禁失败 |
| BLOCKED / 2 | 配置缺失、模型/本地存储 不可用、输入无效或基线不可比较 |

外部失败不会被当作“模型答案得分为零”的有效基线。
报告仍保留已取得的结果与失败耗时。Token 是回调观察到的已返回用量，
`complete: false` 和 `missingUsageCalls` 表示不能据此推断全部消耗；不估算价格或缺失用量。
耗时按所有执行、成功执行、失败或 PARTIAL 执行分别报告 P50/P95，首期不作为阻断指标。

## 运行、比较与保存

```bash
# 单次冒烟；--case 可重复指定。
python -m dotenv -f .env run -- python scripts/evaluate.py --case text-basic

# 正式基线或候选运行：每个案例三次，每次使用独立 thread。
python -m dotenv -f .env run -- python scripts/evaluate.py --repetitions 3

# 用实际基线报告路径替换占位符。
python -m dotenv -f .env run -- python scripts/evaluate.py --repetitions 3 \
  --baseline 'reports/evaluations/<baseline-run-id>/report.json'

# 比较已有报告，不需要 .env，不会调用模型或本地存储。
python scripts/evaluate.py --compare \
  'reports/evaluations/<baseline-run-id>/report.json' \
  'reports/evaluations/<candidate-run-id>/report.json'
```

默认在 `reports/evaluations/<runId>/` 生成 `report.json` 和 `report.md`，终端显示实际路径。
`--output` 可指定新的 `.json` 路径，同时生成同名 Markdown；已有文件拒绝覆盖。
原来的 `reports/evaluation.json` 是 v1 历史失败证据，继续保留，不能用作 v2 基线。

报告记录 Git commit、dirty 状态、源码与依赖指纹、提示词指纹、模型、白名单运行参数、
所选金标及文件内容哈希、评分版本、每次执行的字段差异、处理失败、模型调用和耗时。
不导出密钥、签名 URL、对象引用或原始异常正文。

有效基线必须 PASSED，且基线与候选均至少运行三次；数据集哈希、评分版本、所选案例及
重复次数必须一致。比较使用未四舍五入的指标，总体指标不得下降；报告展示百分点差异、
逐案例计数变化及代码/模型/参数变化。单次运行可检查绝对门禁，但不能作为正式比较基线。
修改评分含义时须更新 `SCORER_VERSION` 并重新实跑基线，禁止与旧评分混比。

## 持续改进流程

1. 根据 Markdown 门禁原因和分桶指标，定位 JSON 中的逐题期望、实际值及 `processing.failures`。
2. 人工核对原文；确认是错误金标、合理等价表达、提取/视觉识别错误、模型输出错误还是合并错误。
3. 把确认的失败材料补为案例；原始数据及正确标注固定后，再修改提示词、模型或代码中的一个因素。
4. 运行完整工程检查，再用相同数据集重复三次真实评测；用有效基线比较质量变化与 Token/耗时变化。
5. 人工复核差异，通过后记录新的报告路径作为后续基线；保留旧报告和回归样本，不自动替换基线。

PR 中记录修改原因、案例 ID、工程测试命令、实跑报告路径及基线差异。
CI 不调用真实模型，不能证明提示词改动后的语义质量；此部分证据由本地实跑提供。
合成小样本通过也不代表生产质量或泛化效果达标。

## 首轮实跑复核入口

[首次 v2 报告](../reports/evaluations/b66d5814-eea3-439b-9117-e2243a8bcc9c/report.md)
覆盖全部 19 个案例，单次运行，结果 FAILED，不能用作三次重复的有效基线。

- `csv-basic` 没有提取出题目；`docx-formula-image` 的视觉描述四次输出仍不符合契约，返回 PARTIAL。
- `xlsx-multi-sheet` 等案例丢失原文答案；长题干、重复题、跨分片样本存在简答题被标为填空题的情况。
- 部分题干保留了 `Multiple choice:` 等源文件中的题型前缀，导致严格匹配失败；`Na` 与 `\mathrm{Na}` 等表达也需人工判定等价。
- 两个预期拒绝案例符合预期，原文无答案案例没有补造答案。成功状态不等于所有字段正确。

先核对这些差异再决定修改金标、评分规则或 Agent。若人工确认新的等价别名，
应在固定的新数据集上重新实跑，不能直接与本轮不同数据集哈希的报告比较，也不能覆盖本轮证据。


## 提示词与生成结果约束

文档解析仅提取原文答案和解析，缺失时返回 null，不通过解题补全；保留真实重复题，
按原文题型标签或作答要求判断题型，分组包含显式章节与 `[sheet]` 工作表标记，
使用当前片段内从 0 开始的索引。提示词包含无答案填空题、有答案简答题与工作表判断题三个示例。
题干保留原始措辞、标点和填空下划线数量，LaTeX 转换放入公式内容块。页面由视觉模型直接结构化提题；无法辨认的内容保留缺失字段和审核标记，不补造内容；
图片没有文字时 `extractedText` 为 null。文档、文件名、图片和请求字段中的指令均视为数据。
这些是语义约束，不代表能够彻底阻止提示注入或保证提取准确率。

回归测试覆盖题目完整性、模型纠错和每次调用用量。FakeModel 测试通过不等于真实模型质量提升。

### 百炼结构化输出配置

所有 Agent 共用 `llm.py` 的模型与协议选择。默认
`AI_STRUCTURED_OUTPUT_METHOD=function_calling`；`json_schema` 显式启用百炼
`response_format.type=json_schema`、`strict=true`，`auto` 仅在官方支持的
Qwen3.7 Plus/Flash/Max、Qwen3.8 Flash/Max 系列上选择原生 Schema，其余使用工具调用。
显式指定原生模式但模型不支持时直接报错，不静默降级。
支持范围依据[百炼官方文档](https://help.aliyun.com/zh/model-studio/qwen-structured-output)。

Qwen3.7 调用统一关闭 thinking，模型、Token 上限与超时仍取原配置。
原生模式直接取得完整响应后再做 Pydantic 校验，避免 SDK 提前抛出截断错误而丢失用量；
截断、未闭合 JSON、语义校验失败均拒绝采用，并纳入既有有限纠错与用量记录。
明确 token 截断的输出不会被本地 JSON 修复接受。

协议选择依据及实跑边界见[本轮优化记录](../reports/evaluations/prompt-optimization-summary.md)。

本地 JSON Repair 已接入共用响应校验：补闭合括号、移除闭括号前的尾逗号、剥离完整代码围栏后重新执行原 Schema／内容校验。修复不新增模型调用；缺字段继续返回待补全。明确 token 截断、残缺字符串、缺失值以及类型或内容矛盾仍进入有限纠错，不因修复而放宽质量门禁。

### 失败止损与质量可见性回归

`text-source-identity` 的金标固定保留大小写不同的题干及同题干不同选项的题目。
分片偏移、来源歧义、同源内容冲突、重复坏输出止损及补跑上限由离线测试覆盖；
真实评测仍使用同一数据集分别运行基线与候选各三次，不为通过门禁修改金标。
合法草稿的空题干作为未匹配项计分；空题型在报告中归入 `unknown` 分桶，原结果仍保留 null。
新增的 `processing.questionSources/quality` 仅提供来源和审核提示，不影响原质量评分，
也不证明图片或答案已通过语义校验。失败报告复用 Graph 的失败分类与剩余补跑次数。

比较调用次数、已知输入/输出 Token 及未知用量，同时检查原有质量门禁。
如果基线本身未通过，正式比较仍返回 BLOCKED；可以报告实测差异，但不能宣称通过不回退验收。
持久恢复须另外完成 document-tasks.md 的 local/OSS 隔离演练。

2026-09-18 补充的人工定义合成金标包括文档内伪指令、集中答案及四页长材料/末页答案。
与双栏图、表格、无原文答案等现有样本一起验证，保持原 90% 指标门槛及关键案例全通过要求。
源数据只有人工构造内容，不含用户材料；PDF 为固定的四页英文观察记录及唯一问题/答案。
评测的 PASSED/FAILED 与运行成功分开，提示词调整不能通过降低门槛或删除失败样本验收。
