# PractiQ AI Server 面试题

本目录按面试轮次和考察重点拆分。回答必须以当前仓库实现为准，不把设计设想说成已落地能力。

## 使用顺序

| 顺序 | 轮次 | 文件 | 重点 |
| ---: | --- | --- | --- |
| 1 | 一面 | [项目基础与工作流](01-first-round-project-and-workflows.md) | 项目介绍、文档解析主链路、技术选型 |
| 2 | 一面 | [Python 与 FastAPI 基础](02-first-round-python.md) | asyncio、typing、Pydantic、依赖管理、pytest |
| 3 | 一面 | [核心工程实现](03-first-round-engineering.md) | 并发、切分、结构化输出、存储与测试 |
| 4 | 二面 | [Python 并发与生产实践](04-second-round-python.md) | 取消、背压、事务、并发安全、性能定位 |
| 6 | 二面 | [生产工程与系统设计](06-second-round-production.md) | 容量、监控、故障、评测与扩展 |

一面建议准备到能在 1 分钟内回答每题；二面要能解释取舍、失败场景和未实现边界。

Python 专项题筛选自 [bcefghj/ai-agent-interview-guide](https://github.com/bcefghj/ai-agent-interview-guide)，并按当前项目实现改写；未照搬源仓库中的假设指标或未落地能力。

## 当前事实边界

- 只注册 `document_parser` 一个 Graph。
- 系统是确定性 Workflow 中嵌入 LLM 节点，不是开放式 ReAct Agent。
- 已实现结构化输出、内容寻址 OSS、部分失败降级、Checkpoint 和容量限制。
- 不提供独立答案生成、题库导入或数据库写入能力。
- 未实现 RAG、向量数据库、长期记忆、通用工具注册中心、MCP/A2A 或 Skills runtime。

## 推荐回答结构

1. 先给结论。
2. 指出具体 Graph、节点、状态或约束。
3. 说明解决的故障或风险。
4. 明确尚未实现或仍待生产验证的部分。

项目主线：**让模型处理语义，让 Graph 控制文档处理流程，让确定性代码守住输入与输出边界。**
