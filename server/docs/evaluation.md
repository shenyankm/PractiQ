# 验证文档提取与主观题评分

本指南区分文档提取质量、主观题评分样本和工程检查。提取评测覆盖 text、csv、pdf、image；Word 用例及转换器验证已移除，新增输入拒绝回归；损坏文件的预期拒绝检查改用 PDF，保留该检查要求。下文历史评测及 `server/reports/` 中的 DOCX 结果仅属于当时版本，不代表当前支持或质量。

以下命令使用已有 Python 3.14+ 环境，并在 `server/` 下运行。

评测沿用真实的本地文件写入和 `document_parser`，在本地直接调用 Graph，使用内存 checkpoint。它评估文档中题目与原文答案的提取质量；业务 HTTP、持久恢复和容量由现有工程测试及压测负责。本评测不接入 LangSmith，不使用 LLM 裁判，也不自动修改提示词或发布版本。

## 检查主观题评分与原卷分值提取

`scripts/evaluate_grading.py` 使用固定的合成题目，分别检查评分和原卷分值提取。它直接调用服务内的模型逻辑，使用临时评分数据库；不验证 HTTP 鉴权、桌面交互或供应商侧恰好一次调用。

先在仓库根目录 `.env` 配置统一的多模态模型 `LLM_MODEL`，再在 `server/` 下执行。以下命令会调用模型并产生费用，请为每次运行选择新的报告路径：

```sh
python scripts/evaluate_grading.py --live --repeats 2 \
  --output reports/grading/your_grading_run.json
```

默认运行四个文本案例各两次，再运行一个图片部分得分案例。文本案例包括满分、部分分、错误作答和含伪指令的作答。报告保留期望值、实际得分、绝对误差、模型名称和调用结果。

单独检查分值提取，确认没有明确分值的题目保持 `null`：

```sh
python scripts/evaluate_grading.py --live --source-scores-only \
  --repeats 2 --output reports/grading/your_source_score_run.json
```

检查报告中的 `exactMatches`、`total` 和逐次结果。该脚本正常退出不等于样本全部通过；它也不会阻止覆盖已有输出文件。失败报告应保留，不用新结果覆盖旧证据。

这些规则构造的样本不等于教师独立标注或跨学科校准。不能据此承诺正式考试阅卷准确率。

## 文档提取数据集与人工金标

`evals/cases.json` 使用 `schemaVersion: 2`，目前包含 21 份公开合成文档；评分版本为 `3.0.0`。保留 Text、CSV、PDF、Image 四种格式，增加中文、原文无答案、长题干相同前缀、合法重复题、跨分片长文、无题目文本、损坏 PDF 七类回归案例，并增加大小写不同、同题干不同选项的来源身份案例。清单字段含义如下：

- `id` 是稳定且唯一的案例标识；`path` 必须指向清单目录内部的文件，禁止路径和符号链接逃逸。
- `tags` 用于按场景分桶，`critical: true` 表示该案例任一已标注字段或结构出错即失败。
- 正常案例必须标注 `expectedQuestions`，并预期 `SUCCEEDED`。
- 拒绝案例只标注 `expectedError: {"code": "NO_QUESTIONS_FOUND", "statusCode": 422}` 等错误，
  两个值必须同时匹配；外部服务不可用不能标为预期成功。
- `expectedGroups` 标注标题及从 0 开始的题目索引；`expectedVisualKinds` 标注视觉类别和数量。
  两者省略或为 `null` 表示未标注，`[]` 表示明确要求不存在该结构。
- `stemAliases`、`answerAliases` 仅允许根据原文确认的等价形式，例如乘除号的 LaTeX 写法、
  化学式下标。别名必须遵守原题型契约；原文无答案时不得添加答案别名。
- `sourceHasNoAnswers: true` 是整份文档没有答案的明确标注，所有输出答案都必须为 null，
  包括题干被改写、未匹配和多余的题目；不能用于混合有答案和无答案的文档。
- `expectedMissingFields`、`expectedNeedsReview` 可按题目标注合法草稿的缺失字段和审核状态。
- `expectedVisuals: [{"kind": "diagram", "page": 0}]` 同时检查类别和从 0 开始的页码；
  嵌入原图的 page 可为 null。它与旧 `expectedVisualKinds` 二选一，[] 仍表示明确没有视觉元素。
  运行器还会读取所有视觉引用，验证大小、SHA-256 和图片解码；不会把引用写入报告。
- `expectedProcess` 可指定 `requiredCallKinds` 和 `maxModelCalls`，由固定工作流的过程断言检查。
- `split` 默认为 `regression`。新增 `image-holdout-instruction` 为独立的 `holdout`；
  原有案例均保留在回归集。只用回归集调试，发布前运行两个集合；不能反复看留出集改提示词。
  一个留出案例只验证流程，不构成泛化证据。真实材料须先脱敏、授权和独立人工标注后再加入。

金标依据源文件人工核对，不能把模型输出直接反填为正确答案。PDF 和图片中的图形按视觉模型输出的 `diagram` 等类别评估。视觉描述语义由人工复核。

维护数据集后执行：

```bash
python scripts/evaluate.py --validate-only
python -m pytest tests/test_evaluation.py
```

CI 同时检查四种格式、七种题型、七类难例，以及每个 fixture 都有对应清单项。清单校验器本身支持任意非空规模，方便临时小集调试。

## 评分与门禁

`qualityPassed` 表示该次执行满足状态、全部已标注字段/结构、视觉产物和过程期望。它与执行状态独立：SUCCEEDED 仍可质量不合格，原文没有答案且正确返回 null 则可质量合格。预期拒绝单独报告，不混入正常任务的执行成功率和失败耗时。

`reliability` 报告文档执行成功率、质量通过率，以及每个案例至少三次执行时的`allRepetitionsPassRate` / `anyRepetitionPassRate`；不足三次显示 N/A。`reliabilitySlices` 按格式、标签和数据集划分汇总。三次重复不是生产可靠性置信保证。

`fidelity` 分别记录补造答案、多余题目、字段不一致和来源待确认的题目数量。未匹配题目或来源警告不是自动判定的幻觉；不能从这些计数推导总体幻觉率。

题干匹配仅删除开头题号及排版空白，保留大小写、标点与完整内容，不使用截断或忽略大小写的题干键；生产去重还要求原文位置与实际分片重叠一致。同题干按出现顺序一一匹配；额外题目降低 Precision，缺失题目降低 Recall 和字段准确率。选项按顺序比较 label/content，答案采用与原文金标一致的结构化值。

| 指标 | 分子 / 分母 |
|---|---|
| questionPrecision | 匹配题目 / 输出题目 |
| questionRecall | 匹配题目 / 金标题目 |
| answerModeAccuracy | 题型正确题目 / 金标题目 |
| optionsAccuracy | 选项正确的选择题 / 金标选择题 |
| parsedAnswerAccuracy | 原文答案正确题目 / 金标题目，包含空答案 |
| groupF1 | 2 × 完整匹配分组 /（金标分组 + 输出分组），同时检查标题和成员 |
| visualF1 | 2 × 匹配视觉元素 /（金标元素 + 输出元素），按类别及已标注页码的多重集计数 |

各指标均为 0–100。没有分母时显示 N/A；明确标注结构为空且输出也为空时，该结构得分为 100。总体指标按题目或结构微平均，同时给出格式、题型和标签分桶。

门禁要求：所有有标注的总体质量指标至少 90%；正常案例全部 `SUCCEEDED`；预期拒绝案例全部匹配；关键案例没有差异；任何原文无答案的匹配题都不得补造答案，整份无答案案例中的未匹配题和额外题也必须保持空答案。`PARTIAL` 保留结果及阶段失败，但不计作正常案例成功。

| 状态 / 退出码 | 含义 |
|---|---|
| PASSED / 0 | 本次门禁通过；指定有效基线时也没有指标回退 |
| FAILED / 1 | 质量、预期状态、关键案例或不回退门禁失败 |
| BLOCKED / 2 | 配置缺失、模型/本地存储 不可用、输入无效或基线不可比较 |

外部失败不会被当作“模型答案得分为零”的有效基线。报告仍保留已取得的结果与失败耗时。Token 是回调观察到的已返回用量，`complete: false` 和 `missingUsageCalls` 表示不能据此推断全部消耗；不估算价格或缺失用量。耗时按所有执行、成功执行、失败或 PARTIAL 执行分别报告 P50/P95，首期不作为阻断指标。

`efficiency` 的分子包含所有评测尝试（包括拒绝案例、失败和纠错）的用量，分母只使用质量合格的正常文档数；同时展示分子和分母。缺失用量时 Token/合格文档显示 N/A；价格尚未配置，因此货币成本显示 N/A，不能把平台估价或已知用量当成完整账单。阶段 P50/P95 来自现有事件，同一文档的并发阶段耗时不能相加当作总耗时。

`trajectory` 使用本地事件串起 thread/run、页面或分片、callKey、attempt、Schema、校验结果和重试/纠错/接受/停止。RETURNED 只表示供应商已返回，validation=passed 才表示结构校验通过。断言检查准备阶段、文本组装、允许的模型类型/Schema、页上下文、四次尝试及任务调用上限，允许并发单元交换完成顺序。事件不包含消息正文、图片、密钥或异常正文。文档状态与模型耗时仍复用 Prometheus；这些指标不代表语义准确率。

## 运行、比较与保存

以下命令在 `server/` 中执行，环境配置统一读取仓库根目录 `.env`。

```bash
# 单次冒烟；--case 可重复指定。
python -m dotenv -f ../.env run -- python scripts/evaluate.py --case text-basic

# 调试时只使用回归集；默认不指定 split 时运行全部案例。
python -m dotenv -f ../.env run -- python scripts/evaluate.py --split regression

# 正式基线或候选运行：每个案例三次，每次使用独立 thread。
python -m dotenv -f ../.env run -- python scripts/evaluate.py --repetitions 3

# 用实际基线报告路径替换占位符。
python -m dotenv -f ../.env run -- python scripts/evaluate.py --repetitions 3 \
  --baseline 'reports/evaluations/your_baseline_run/report.json'

# 比较已有报告，不需要 .env，不会调用模型或本地存储。
python scripts/evaluate.py --compare \
  'reports/evaluations/your_baseline_run/report.json' \
  'reports/evaluations/your_candidate_run/report.json'
```

默认在 `reports/evaluations/<runId>/` 生成 `report.json` 和 `report.md`，终端显示实际路径。`--output` 可指定新的 `.json` 路径，同时生成同名 Markdown；已有文件拒绝覆盖。原来的 `reports/evaluation.json` 是 v1 历史失败证据，继续保留，不能用作 v2 基线。

报告记录 Git commit、dirty 状态、源码与依赖指纹、提示词指纹、模型、白名单运行参数、所选金标及文件内容哈希、评分版本、每次执行的字段差异、处理失败、模型调用和耗时。不导出密钥、签名 URL、对象引用或原始异常正文。

有效基线必须 PASSED，且基线与候选均至少运行三次；数据集哈希、评分版本、所选案例及重复次数必须一致。比较使用未四舍五入的指标，总体指标不得下降；报告展示百分点差异、逐案例计数变化及代码/模型/参数变化。单次运行可检查绝对门禁，但不能作为正式比较基线。修改评分含义时须更新 `SCORER_VERSION` 并重新实跑基线，禁止与旧评分混比。旧 v2 评分报告继续只读保存；v3 比较器拒绝旧评分版本，不迁移或重写历史分数。运行器会关闭 LANGSMITH_TRACING 和 LANGCHAIN_TRACING_V2，不向远端评测平台发送数据。

## 离线故障探针与本地复核

`make verify` 和 CI 只运行一次完整 pytest，并将其 JUnit 结果转为故障探针报告：

```bash
python -m pytest --junitxml=reports/checks/probes.xml
python scripts/evaluate.py --probes reports/checks/probes.xml
```

探针复用恢复、预算、引用校验、转换器、相似来源和结构化输出测试，区分恢复成功率、正确停止率、路由通过率与未知用量保留。每个参数化场景是一条观测；缺失、跳过或 setup失败不算通过。JUnit 记录代码和测试指纹，过期证据返回 BLOCKED。不会导出测试异常正文。这些结果只证明确定性故障测试；此探针摘要的真实进程重启仍标为 NOT_ASSESSED；进程强杀/恢复由 tests/test_agent_server.py 的隔离 SQLite 测试单独证明，不能代替真实 OSS 验收。

运行日志中的 `review_candidate` 只含任务标识、格式、状态和错误码。将 `practiq.events`的消息内容按 JSONL 保存到本地持久日志目录后生成复核清单：

```bash
python scripts/review_queue.py /absolute/logs/practiq.events.jsonl \
  --output reports/reviews/2026-09-18.json
```

所有执行错误、PARTIAL 和质量审核标记都入选；其余任务按格式及稳定 thread 标识散列抽样约 5%，不是每个小批次恰好 5%。同一 run 去重，重放不改变抽样选择。清单仅含元数据；人工通过现有鉴权任务接口读取原文并记录复核结果。确认问题后，先脱敏、制作金标，再进入回归集。不会自动认定问题、修改提示词或发布版本。JSON/Markdown 输出禁止覆盖已有文件，生成报告无需提交到 Git。

可用 `--decisions /absolute/review-decisions.json` 合并人工结论，输入为 JSON 数组：

```json
[
  {
    "threadId": "your_first_thread_id",
    "runId": "your_first_run_id",
    "verdict": "incorrect",
    "errorCategory": "model_output"
  },
  {
    "threadId": "your_second_thread_id",
    "runId": "your_second_run_id",
    "verdict": "correct",
    "errorCategory": null
  }
]
```

`verdict` 为 `correct`、`incorrect` 或 `uncertain`。只有 `incorrect` 必须填写`errorCategory`（`extraction`、`model_output`、`merge`、`gold_label`）；其他结论必须为 null。每条记录必须属于这批日志生成的已选复核清单，且 `(threadId, runId)` 不得重复。可以只填写部分任务；未填写项输出 null 并显示“待复核”。额外字段会被拒绝，不在结论文件中添加正文、答案或凭据。重新生成时使用新的 `--output` 路径。该本地结论不修改服务器结果或清除质量标记；接受服务器结果也不自动生成“正确”结论。

2026-09-18 的 [v3 首轮报告](../reports/evaluations/fc0f9716-001e-4849-9b4c-94399d9b501f/report.md)覆盖全部 25 个案例、各三次真实模型执行，结果 FAILED。69 次正常任务中执行成功 66 次、质量合格 61 次；23 个正常案例均至少通过一次，其中 17 个三次全通过；6 次预期拒绝均匹配。过程断言和视觉产物校验通过，但视觉 F1 为 80%，文件名伪指令案例出现一次补造答案，另有跨页答案、额外题目和视觉输出校验失败。保留全部失败证据，不作为合格基线。本轮未使用留出集结果修改提示词。

当时独立 Agent Server/PostgreSQL/Redis 的生产崩溃恢复矩阵尚未完成。补充实测：隔离目录中仅使用本地运行配置并关闭 tracing，开发服务器两次启动的 `/ok` 均返回 200，正常停止后重启仍可读取原线程，未调用模型。该结果验证开发模式的线程落盘与正常重启，不覆盖执行中崩溃、模型结果复用或生产数据库恢复。

## 持续改进流程

保留固定数据和失败证据，按以下顺序验证改动：

1. 根据 Markdown 门禁原因和分桶指标，定位 JSON 中的逐题期望、实际值及 `processing.failures`。
2. 人工核对原文；确认是错误金标、合理等价表达、提取/视觉识别错误、模型输出错误还是合并错误。
3. 把确认的失败材料补为案例；原始数据及正确标注固定后，再修改提示词、模型或代码中的一个因素。
4. 运行完整工程检查，再用相同数据集重复三次真实评测；用有效基线比较质量变化与 Token/耗时变化。
5. 人工复核差异，通过后记录新的报告路径作为后续基线；保留旧报告和回归样本，不自动替换基线。

PR 中记录修改原因、案例 ID、工程测试命令、实跑报告路径及基线差异。CI 不调用真实模型，不能证明提示词改动后的语义质量；此部分证据由本地实跑提供。合成小样本通过也不代表生产质量或泛化效果达标。

## 首轮实跑复核入口

[首次 v2 报告](../reports/evaluations/b66d5814-eea3-439b-9117-e2243a8bcc9c/report.md)覆盖全部 19 个案例，单次运行，结果 FAILED，不能用作三次重复的有效基线。该轮问题包括：

- `csv-basic` 没有提取出题目；`docx-formula-image` 的视觉描述四次输出仍不符合契约，返回 PARTIAL。
- `xlsx-multi-sheet` 等案例丢失原文答案；长题干、重复题、跨分片样本存在简答题被标为填空题的情况。
- 部分题干保留了 `Multiple choice:` 等源文件中的题型前缀，导致严格匹配失败；`Na` 与 `\mathrm{Na}` 等表达也需人工判定等价。
- 两个预期拒绝案例符合预期，原文无答案案例没有补造答案。成功状态不等于所有字段正确。

先核对这些差异再决定修改金标、评分规则或 Agent。若人工确认新的等价别名，应在固定的新数据集上重新实跑，不能直接与本轮不同数据集哈希的报告比较，也不能覆盖本轮证据。


## 提示词与生成结果约束

文档解析仅提取原文答案和解析，缺失时返回 null，不通过解题补全；保留真实重复题，按原文题型标签或作答要求判断题型，分组包含原文中的显式章节与 `[sheet]` 文本标记（不代表支持 Excel 文件），使用当前片段内从 0 开始的索引。提示词包含无答案填空题、有答案简答题与工作表判断题三个示例。题干保留原始措辞、标点和填空下划线数量，LaTeX 转换放入公式内容块。页面由视觉模型直接结构化提题；无法辨认的内容保留缺失字段和审核标记，不补造内容；图片没有文字时 `extractedText` 为 null。文档、文件名、图片和请求字段中的指令均视为数据。这些是语义约束，不代表能够彻底阻止提示注入或保证提取准确率。

回归测试覆盖题目完整性、模型纠错和每次调用用量。FakeModel 测试通过不等于真实模型质量提升。

### 百炼结构化输出配置

所有 Agent 共用 `llm.py` 的模型与协议选择。默认`AI_STRUCTURED_OUTPUT_METHOD=function_calling`；`json_schema` 显式启用百炼`response_format.type=json_schema`、`strict=true`，`auto` 仅在官方支持的Qwen3.7 Plus/Flash/Max、Qwen3.8 Flash/Max 系列上选择原生 Schema，其余使用工具调用。显式指定原生模式但模型不支持时直接报错，不静默降级。支持范围依据[百炼官方文档](https://help.aliyun.com/zh/model-studio/qwen-structured-output)。

Qwen3.7 调用统一关闭 thinking，模型、Token 上限与超时仍取原配置。原生模式直接取得完整响应后再做 Pydantic 校验，避免 SDK 提前抛出截断错误而丢失用量；截断、未闭合 JSON、语义校验失败均拒绝采用，并纳入既有有限纠错与用量记录。明确 token 截断的输出不会被本地 JSON 修复接受。

协议选择依据及实跑边界见[本轮优化记录](../reports/evaluations/prompt-optimization-summary.md)。

工具调用的数量、名称和参数结构在使用 SDK 的已解析对象之前检查；原始工具参数优先。原生 JSON Schema 和没有工具调用的结构化对象路径继续受同一业务校验约束。分组索引拒绝布尔值、浮点数与数字字符串；`isCorrect` 和 `needsReview` 不接受字符串或数字转布尔。关键字段和图形坐标的语义描述随 Schema 发送，合法草稿、false、0、null 的含义不变。截断错误保留为 `OUTPUT_TRUNCATED`，包括重复截断提前止损；不开放人工同参数补跑。

本地 JSON Repair 已接入共用响应校验：补闭合括号、移除闭括号前的尾逗号、剥离完整代码围栏后重新执行原 Schema／内容校验。修复不新增模型调用；缺字段继续返回待补全。明确 token 截断、残缺字符串、缺失值以及类型或内容矛盾仍进入有限纠错，不因修复而放宽质量门禁。

### 失败止损与质量可见性回归

`text-source-identity` 的金标固定保留大小写不同的题干及同题干不同选项的题目。分片偏移、来源歧义、同源内容冲突、重复坏输出止损及补跑上限由离线测试覆盖；真实评测仍使用同一数据集分别运行基线与候选各三次，不为通过门禁修改金标。合法草稿的空题干作为未匹配项计分；空题型在报告中归入 `unknown` 分桶，原结果仍保留 null。新增的 `processing.questionSources/quality` 仅提供来源和审核提示，不影响原质量评分，也不证明图片或答案已通过语义校验。失败报告复用 Graph 的失败分类与剩余补跑次数。

比较调用次数、已知输入/输出 Token 及未知用量，同时检查原有质量门禁。如果基线本身未通过，正式比较仍返回 BLOCKED；可以报告实测差异，但不能宣称通过不回退验收。持久恢复须另外完成 document-tasks.md 的 local/OSS 隔离演练。

2026-09-18 补充的人工定义合成金标包括文档内伪指令、集中答案及四页长材料/末页答案。与双栏图、表格、无原文答案等现有样本一起验证，保持原 90% 指标门槛及关键案例全通过要求。源数据只有人工构造内容，不含用户材料；PDF 为固定的四页英文观察记录及唯一问题/答案。评测的 PASSED/FAILED 与运行成功分开，提示词调整不能通过降低门槛或删除失败样本验收。


### 定位模型校验失败

评测报告每次模型调用的 `validationIssues` 记录失败字段路径与 Pydantic 错误类型，最多 20 项；未知字段名替换为 `?`，不记录字段值、原文或异常上下文。先定位失败 case/repetition 的 `calls`，区分 `list_type` 等结构错误、截断、业务校验与最终评分差异；HTTP 成功和任务完成不代表金标质量通过。

已捕获的 `questions` 字符串包裹整段对象尾部响应作为离线回归样本保存于`tests/fixtures/stringified-page-arguments.json`。这种响应继续拒绝，不丢弃尾部字段，不猜测修复内容；共享纠错路径明确要求真正的数组和独立顶层字段，用量照常计入。模型初始提示同样明确数组结构。百炼预设与桌面的同一自定义 Base URL使用相同的 Qwen3.7 thinking 参数；其他自定义端点不注入该供应商参数。


曾对百炼 Qwen3.7 试验 `vl_high_resolution_images=true`：扫描样本改善，但完整回归出现长 PDF 重复题和答案遗漏，未采用此参数。不能依据单个样本提高分辨率就断言整体质量改善。供应商图像参数说明见[百炼视觉理解文档](https://help.aliyun.com/zh/model-studio/vision)。严格字符评分和人工审核标记继续保留。
