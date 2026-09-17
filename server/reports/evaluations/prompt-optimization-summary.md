# Agent 结构化输出优化记录

日期：2026-09-18。结论：当前 `qwen3.7-flash` 默认继续使用 **function_calling**，
配合关闭 thinking、Pydantic 结构/业务校验和现有有限纠错。
原生 JSON Schema 已接入为显式可选项，未作为默认开启。
这不是所有模型、所有任务的优劣结论，也不是生产质量验收。

## 选择依据

按[百炼文档](https://help.aliyun.com/zh/model-studio/qwen-structured-output)接入
`response_format={type: json_schema, json_schema: {strict: true, ...}}`。
实际 Schema 由 Pydantic 生成；字段关系、来源事实与 OCR 完整性仍需独立检查。

两个协议使用相同模型、提示词、输入、4096 Token 上限、60 秒超时、关闭 thinking、
并发 2；答案、题库元数据、学习报告、分组文档、OCR 各重复 2 次。
检查包括 Pydantic 校验、已知选项答案、文档题数/分组/答案存在、OCR 关键文字。
复测增加描述至少 10 字、标签至少 2 字的样例可用性检查（不是通用业务限制）。

| 样本检查 | function_calling | json_schema |
|---|---:|---:|
| 初轮 | 10/10 | 8/10 |
| 修正元数据 Schema 后复测 | 9/10 | 6/10 |

初轮虽通过结构检查，两协议的元数据都出现单字输出，因此不能将 10/10 当成内容质量达标。
将生成结果中 `\S` 改为 `[\s\S]*\S[\s\S]*` 后，描述和标签恢复完整文本。
复测中 function_calling 有一次文档漏答案；原生模式两次文档分别出现答案类型不匹配、
分组索引非法，两次 OCR 只读标题。原生模式的格式约束不能阻止这些语义问题。
复测还发现元数据会推断题库范围/适用考试；后续为元数据提示词补充了保守描述示例。
这不改变协议选择依据，但建议仍需人工编辑确认。

证据：[初轮工具调用](protocol-function_calling.json)、[初轮原生 Schema](protocol-json_schema.json)、
[复测工具调用](protocol-final-function_calling.json)、[复测原生 Schema](protocol-final-json_schema.json)。
这些小样本不是统计显著的完整基准，且不含应用纠错，不能等同最终接口成功率。

## 实现

- 六个业务提示词：文档解析、OCR、图片描述、答案生成、学习报告、题库元数据；
  来源内容与任务指令分离，明确缺失信息、字段类型、来源答案与分组规则，并加入示例。
- 答案按请求题型使用单一 Schema，校验选择题标签；不足以作答时拒绝保存虚构答案。
- 学习报告验证输入标签覆盖和薄弱点来源，依据真实练习次数计算 score/evidence。
- 题库建议标签限 3～6 个且唯一，修正非空白正则在约束解码中的单字问题。
- 两条模型调用路径复用协议选择，保留逐次用量；截断、未闭合 JSON 不做宽松补全。
- 保留纠错预算（文档最多 4 次总调用，产品生成最多一次输出纠错），不增加无限重试。

配置：`AI_STRUCTURED_OUTPUT_METHOD=function_calling` 为默认；可显式设置 `json_schema`，
不支持的模型会报错；`auto` 仅为文档支持的百炼系列启用原生 Schema。
Qwen3.7 使用 `enable_thinking=false`。未改写本地密钥文件，未更换模型，未提交或推送。

## 工程验证和生成实测

- `make test-server`：295 passed；Pyright：0 errors；改动文件 Ruff 与 `git diff --check` 通过。
- 实际运行环境 Python 3.13.15；仓库声明 Python 3.14，未安装新环境，不能声称已验证锁定的 3.14 环境。
- HTTP Mock 检查真实请求参数、原生响应、截断/语法/字段错误后的有限纠错，及两条路径的失败用量。
- [生成冒烟](prompt-generation-final.json)（保守元数据示例加入前）：四题型简单算术、报告统计、元数据检查 6/6。
  仅涵盖基础问题；没有证明关闭 thinking 对复杂推理无损。
- [最终缺失信息检查](prompt-abstention-final.json)：缺图且缺尺寸，2 次调用后返回 502，没有可采用的虚构答案。

- [元数据示例补充后的复测](prompt-metadata-final.json)：3/3，描述完整、标签非单字，
  当前样本未出现无依据的考研/期末标签或既有题目覆盖断言。相关 24 项离线测试复跑通过。

## 文档评测证据的边界

旧代码[基线](prompt-optimization-baseline.md)为 FAILED；
初版优化[候选](prompt-optimization-candidate.md)亦为 FAILED，
[正式比较](prompt-optimization-comparison.md)为 BLOCKED，不能宣称已通过无回归门禁。
中间的分组及文本复测继续保留为失败定位依据，不冒充最终提示词结果。

[最终文档评测](prompt-optimization-final.md)已完成 19 案例 × 3 次（57 次），
使用默认 function_calling、thinking=false、16384 Token 上限、180 秒请求超时。
状态仍为 **FAILED**；[最终正式比较](prompt-optimization-final-comparison.md)为 **BLOCKED**，
因基线本身未通过。以下仅描述观察值，不能宣称质量门禁通过或所有任务均无回归：

| 指标 | 旧代码基线 | 最终文档候选 |
|---|---:|---:|
| 题目精确率 | 81.90% | 93.00% |
| 题目召回率 | 81.90% | 88.57% |
| 题型准确率 | 77.14% | 88.57% |
| 选项准确率 | 83.33% | 95.83% |
| 原文答案准确率 | 53.33% | 70.48% |
| 分组 F1 | 66.67% | 100.00% |
| 视觉 F1 | 66.67% | 72.73% |
| 单案例耗时中位数 | 28.06 秒 | 3.50 秒 |

长文本跨分片耗时分别为 304.49、111.47、3.50 秒，存在明显长尾，不能用中位数掩盖。
87 次模型响应均有用量记录（输入 228278、输出 85177 Token）。
仍存在漏答案、长题干/重复题/跨分片差异、一次双栏 OCR 空输出、一次普通文本解析失败，
以及两次无题目文档返回的错误码不符合预期。不能将 SUCCEEDED 当成提取字段正确。
本轮未修改金标或降低门禁来换取通过；后续应针对这些失败样本独立改进提取质量。
最终文档评测运行中只补充了产品元数据提示词示例及离线测试，文档/OCR 提示词和协议保持不变。
