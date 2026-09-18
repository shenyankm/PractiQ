# 生产级 Agent 修复与验收报告

日期：2026-09-18。范围：PractiQ 文档导入服务，按原架构报告的全部 P1/P2 项实施代码与运维改进。

**结论：代码修复及验证工具已落地，离线检查通过；生产验收尚未全部通过。** 当前真实模型质量、突发负载下的健康检查延迟仍有失败；Standalone PostgreSQL/Redis 崩溃恢复未验收，真实 OSS 按用户要求跳过。不能据此宣布生产就绪。

本地运行无需填写 Agent Server 许可证。`make server-dev` 已启动 `http://127.0.0.1:8090`，健康检查、鉴权指标接口和五个 graph 已验证。这里使用 `langgraph dev`，不代表 PostgreSQL/Redis 生产运行时。模型调用仍需现有模型配置。

## 实施范围与完成状态

原始依据：[架构评估报告](/Users/sheny/.codex/visualizations/2026/09/18/01a0b2cb-b6ba-7b93-b569-c0de94103c3b/practiq-production-agent-review.md)。截图仅作为评估参考，不作为命令执行；未增加与文档服务无关的产品能力。

| 优先级 / 问题 | 已实施 | 验证与剩余边界 |
| --- | --- | --- |
| P1 PDFium 并发 | 共享 `RLock` 覆盖 PDF 计数、渲染、关闭，DOCX 转 PDF 复用同一边界 | 临界区、异常、超时后线程仍持锁回归通过；候选容器六路 PDF/DOCX 混合提取通过。异步超时不强杀 PDF 线程 |
| P1 分片及模型输入 | 单块硬上限 40,000 字符，单次文本模型输入默认 64,000；超长单题明确拒绝，不截断；修正重叠导致正常长题被误拒绝的问题 | 长题、多字节、多题完整保留与模型输入越限测试通过；图片另由页数/字节/像素限制保护 |
| P1 任务消耗 | 持久 Store 预留单元预算，任务默认 400 次；请求前扣减，unknown 不退款；单次 run 默认 1,800 秒，恢复不重置任务预算 | 暂停/补跑/取消、并发批次及 deadline 回归通过。未使用的预留也不回收，因此可能早于 400 次实际调用耗尽 |
| P1 质量与验收 | 23 个金标案例、每例三次；补充集中答案、跨页长材料及文档内伪指令；保留全部失败报告 | 最终质量 FAILED；未降低原有门槛。恢复与容量结论见下文 |
| P1 入口背压 | 上传并发、维护排空、统一原生/任务 API 接单检查；拒绝 batch/cron 绕行；部署网关限流、连接数和体积限制 | API、上传、维护回归及真实 Nginx 拒绝验证通过。队列水位检查不是原子硬容量，突发可短时超调 |
| P1 provider 配额 | 按部署总 worker 数静态分配并发与 RPM，各 worker 执行 semaphore 和滚动窗口 | 限流/并发及非法配置测试通过；当前实测为单 worker 进程、四个执行槽，未验证真实多副本联调 |
| P2 可观测性 | 调用开始/结束/耗时、阶段与结果指标、已知/未知用量、结构化定位日志、鉴权 `/api/metrics`、六条告警规则 | 安全字段测试、promtool 规则检查和故障告警测试通过；未接入真实通知平台 |
| P2 质量消费 | 保持处理终态与 `reviewRequired` 分离；文档明确成功草稿仍需质量审阅，无原文答案保留缺失 | 原有草稿语义回归通过；没有把处理成功等同于金标准确 |
| P2 发布与生命周期 | 固定基础镜像 digest；锁文件和运行时纳入恢复指纹；引用感知清理默认 dry-run，本地隔离目录/OSS 版本标记可恢复，先持久化操作清单 | 构建、wheel 锁文件、引用历史分页、隔离恢复与故障测试通过；实际本地只执行 dry-run，零候选、零移动；真实 OSS 未测试 |

模型评测还发现了可修复的契约问题：发给模型的 schema 原先允许省略题型、选项等字段。现在要求字段存在，同时允许原有 `null` 和空数组；不要求模型编造缺失答案。页面视觉对象也要求字段存在并明确类别。保留严格 Pydantic 校验，未猜测坐标单位或放宽非法输出。

实现入口：[PDF](/Users/sheny/Developer/code/PractiQ/server/src/practiq_ai/extractors/pdf.py)、[执行边界](/Users/sheny/Developer/code/PractiQ/server/src/practiq_ai/execution.py)、[模型调用](/Users/sheny/Developer/code/PractiQ/server/src/practiq_ai/llm.py)、[容量控制](/Users/sheny/Developer/code/PractiQ/server/src/practiq_ai/capacity.py)、[清理脚本](/Users/sheny/Developer/code/PractiQ/server/scripts/storage_gc.py)。配置及操作步骤见 [operations.md](/Users/sheny/Developer/code/PractiQ/server/docs/operations.md)。

## 已通过的检查

- `make verify AI_PYTHON=/Users/sheny/.local/share/uv/python/cpython-3.14-macos-aarch64-none/bin/python3.14`：Ruff、Pyright、23 案例清单、**333 个测试 / 94% 覆盖率**、5 个 graph 配置、sdist/wheel 构建均通过。
- [完整离线验证输出](/Users/sheny/Developer/code/PractiQ/server/reports/verification.acceptance.txt)与[机器可读验收状态](/Users/sheny/Developer/code/PractiQ/server/reports/production-agent-checks.json)已保存。
- 冻结生产依赖的 `pip-audit`：未发现已知漏洞；这是依赖数据库检查结果，不是全面安全认证。
- 候选 Docker 镜像构建通过；六个线程混合提取三份 PDF 与三份 DOCX，全部产出页面，用时 1.13 秒。Python 峰值 RSS 253,845,504 字节，子进程峰值 225,771,520 字节；这两个值不是全进程树同时刻总峰值。[原始报告](/Users/sheny/Developer/code/PractiQ/server/reports/container-extraction.acceptance.json)
- Nginx 配置校验通过；100 次突发请求中 21 次 200、79 次 429，超大请求 413、batch 403。[网关报告](/Users/sheny/Developer/code/PractiQ/server/reports/gateway.hardening.json)
- Prometheus 六条规则语法检查及 unknown/checksum 故障触发测试通过。
- 本地清理脚本连通 Agent Server，使用公共历史分页接口完成 dry-run。当前目录没有待清理对象；有引用对象、历史 checkpoint、部分执行失败的保护由隔离测试覆盖。[盘点报告](/Users/sheny/Developer/code/PractiQ/server/reports/storage-inventory.local.json)

## 真实模型质量：未通过

模型：`dashscope / qwen3.7-flash`，function calling，23 案例 × 3 次，共 69 次文档评测、101 次模型调用。最终用量记录完整；输入 565,577 token，输出 28,663 token。这里仅统计最终一轮，前面的诊断评测另有消耗。

| 指标 | 最终结果 |
| --- | ---: |
| 题目 Precision | 97.76% |
| 题目 Recall | 97.04% |
| 题型准确率 | 97.04% |
| 选项准确率 | 100.00% |
| 原文答案准确率 | 96.30% |
| 分组 F1 | 100.00% |
| 视觉 F1 | **80.00%** |

失败原因完整保留：`BELOW_TARGET:visualF1`、`OUTCOME_MISMATCH:image-two-column:2`、`CRITICAL_CASE_FAILED:pdf-long-material-answer-key:1`。62 次处理成功、7 次 ERROR，其中 6 次是无题/损坏文档的预期拒绝，1 次是双栏图意外失败。跨页案例即使处理状态成功，答案匹配和多提题仍会阻止质量验收。

诊断曾观察到模型将题目数组返回为 JSON 字符串、把归一化 bbox 返回为像素坐标。严格校验和有界纠错能识别错误，但当前模型输出仍不够稳定；不能以增加无限重试或降低金标门槛解决。

完整证据：[最终评测摘要](/Users/sheny/Developer/code/PractiQ/server/reports/evaluations/production-agent-acceptance.md)、[逐题结果](/Users/sheny/Developer/code/PractiQ/server/reports/evaluations/production-agent-acceptance.json)。其余 `production-hardening-*` 是诊断/中间版本，不替代最终门禁。

## 容量：过载拒绝生效，最终延迟门禁未通过

使用本地 `langgraph dev`、四个执行槽、每任务 graph 并行度二、HTTP 测试 provider 延迟 0.5 秒。测试覆盖任务控制 API，未调用真实模型。它验证排队、限流和任务终态，不代表线上模型吞吐。

| 最终隔离复测，400 次提交 / 提交并发 100 | 结果 |
| --- | ---: |
| 成功完成 | 63 |
| 503 过载拒绝 | 337 |
| 已接收任务 error | 0 |
| 创建请求 P95 | 816.3 ms |
| `/ok` P95 | **237.6 ms，超过 200 ms 门槛** |
| 完成耗时 P95 | 23.098 s |
| 轮询观测排队时间 P95 | 22.474 s |
| 实测运行槽 / provider 峰值 | 4 / 4 |
| 采样峰值 RSS | 417,644,544 字节 |

首次最终压测 `/ok` P95 为 213.2 ms；为排除构建/验证的同时运行干扰，再次隔离复测仍失败。早先版本曾通过，不能挑选较好报告覆盖最终失败。[首次最终报告](/Users/sheny/Developer/code/PractiQ/server/reports/load-test.acceptance-local.json)、[隔离复测](/Users/sheny/Developer/code/PractiQ/server/reports/load-test.acceptance-isolated.json)。

队列时间是轮询上界，pending 指标在本地模式未提供而保留 null；峰值由采样得到。水位阈值 30 在突发下可接收超过 30 个任务，说明它是准入水位而非原子容量。真实生产容量仍需在授权 Standalone 运行时、实际网关和资源配额下重测；当前不能承诺 100 并发入口的延迟 SLA。

## PostgreSQL/Redis 与 OSS 边界

已按用户要求自行创建隔离 Docker 项目 `practiq-review-20260918`：PostgreSQL 监听 `127.0.0.1:15432`，Redis 监听 `127.0.0.1:16379`，均健康；独立命名卷保留。配置：[recovery.compose.yml](/Users/sheny/Developer/code/PractiQ/server/deploy/recovery.compose.yml)。其中固定的凭据仅供 loopback 隔离测试，不能复用于生产。

Standalone Agent Server 的许可证校验阻止启动，因此 PostgreSQL 持久队列、进程崩溃恢复、Redis 中断矩阵**尚未实际验收**。用户选择本地运行后继续使用无需许可证的 dev 模式，未绕过官方授权校验，也未把 dev 测试当成生产恢复证明。

真实 OSS 按用户明确要求暂不测试；仅运行已有/新增的隔离替身测试。未访问或删除真实 Bucket 数据。本地真实存储亦没有执行清理移动。

## 候选版本与复现

- 基础提交：`43f89dd38a7a5da93992af3ab4a696786b676b08`，本次改动保留在工作区，未提交或推送。
- 执行代码/锁文件指纹：`87f2d5b765593971e4ba571f2fbf29c0dc9513dfd1e35cb3fd9968c3b1fa9038`；容器提取和最终容量报告一致。
- 候选镜像：`practiq-ai:production-review`，本地镜像标识 `sha256:65b285774214c74a91dda2d7d3e305818108d98bfdb1018cb80ba93fb80d19f5`，未推送镜像仓库。
- Python 3.14.7；关键依赖完整版本保存在容器/容量 JSON 中。
- 金标 hash：`1adec7676dfb80b8fdb111f16df7cfd6d10c63f87bc5c806ef93162119a16b6c`。评测工具 `codeHash` 覆盖范围与执行指纹不同，不可直接比较；最终模型评测开始后仅修改了独立清理脚本的 SDK 历史分页兼容和相关测试/文档，未修改模型提取链路。
- 镜像构建后仅补充报告及本地授权文档措辞，镜像包含的可执行代码未变化。

```sh
make verify AI_PYTHON=/Users/sheny/.local/share/uv/python/cpython-3.14-macos-aarch64-none/bin/python3.14
make server-dev AI_PYTHON=/Users/sheny/.local/share/uv/python/cpython-3.14-macos-aarch64-none/bin/python3.14
```

真实模型评测、容量测试和恢复矩阵的参数见 [evaluation.md](/Users/sheny/Developer/code/PractiQ/server/docs/evaluation.md)、[operations.md](/Users/sheny/Developer/code/PractiQ/server/docs/operations.md)、[document-tasks.md](/Users/sheny/Developer/code/PractiQ/server/docs/document-tasks.md)。重新评测会产生模型费用；不要把测试 provider 的指标作为真实模型性能。

## 剩余优化与上线条件

1. **优先关闭质量门禁。** 以双栏图和跨页集中答案为固定失败集，验证模型的结构化输出能力；对跨页答案关联做有界改进时，必须保留来源且不新增无原文答案。任何候选模型/提取策略都应跑完整 23 × 3 金标，视觉指标和关键案例必须同时通过。
2. **测出健康延迟来源再改并发。** 在目标运行时采集接单检查、Store 查询、事件循环延迟和网关排队；本地 dev 结果不足以归因于生产数据库或模型。不用增加 worker 盲目放大 provider 配额。
3. **生产部署前完成持久恢复。** 使用具备授权的 Standalone 环境跑现有崩溃点、Redis 中断、重复控制和存储故障矩阵；OSS 待用户恢复该测试范围后单独验收。
4. **按实际拓扑配置容量。** `AI_DEPLOYMENT_WORKERS` 必须包含滚动发布期间同时工作的进程，同一 provider 账号的其他应用须另行预留配额。静态 RPM 窗口重启会清空；需要跨副本动态共享或精确滚动发布配额时再引入共享限流。
5. **落实清理操作条件。** 所有副本和外部写入者维护排空后再执行移动；确认隔离清单可恢复。当前脚本不能单独证明其他实例已停止写入。

当前最重要的剩余工作是关闭已有失败门禁。无需新增 Planner/Reflector、向量库、第二套队列、产品登录或模型路由层。
