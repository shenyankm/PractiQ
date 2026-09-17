# PractiQ server 运维手册

## 本机开发（默认）

仓库 `compose.yaml` 仅启动独立的个人 PostgreSQL（54322），不启动 AI 容器或 AI 专用 PostgreSQL。
激活本机 Miniconda 的 `langgragh`（Python 3.14）环境后执行 `make server-install`、`make server-dev`（仓库根目录）。
已有环境直接复用；新机器才执行 `conda create -n langgragh python=3.14`。不要创建项目 `.venv`。
`langgraph dev` 不使用 `DATABASE_URI`/`REDIS_URI` 提供生产级持久化，不承诺 PostgreSQL 任务与 checkpoint 恢复。
下述生产部署、许可证和恢复要求不适用于该开发模式。

## 生产基线

- 单应用容器：8 vCPU / 16 GB；外部 PostgreSQL 和 Redis。
- `N_JOBS_PER_WORKER=8`，graph `max_concurrency=2`，模型理论并发上限 16。
- 单 run 内 本地文件存储 并发 4；源文档最大 25 MiB、100 页。
- 同时提交 100 个任务，可短时积压 300 个；不是 100 个同时执行。
- run 使用 `durability=sync`、`multitask_strategy=enqueue`。
- 单机部署只承诺应用进程重启恢复，不承诺主机级高可用。

按照 [Standalone Agent Server 官方部署说明](https://docs.langchain.com/langsmith/deploy-standalone-server)，
`DATABASE_URI` 保存 assistant、thread、run、
checkpoint 和持久队列，使用 `REDIS_URI` 处理流、取消与 pub/sub。两者必须是
外部托管实例，不能依赖应用容器本地磁盘。

## 配置

| 变量 | 必填/默认 | 说明 |
| --- | ---: | --- |
| `AI_SERVICE_TOKEN` | 必填 | Agent Server 和自定义路由 Bearer token |
| `LANGSMITH_API_KEY` | 必填 | Agent Server 授权 |
| `LANGGRAPH_CLOUD_LICENSE_KEY` | 生产必填 | Standalone Server 许可证 |
| `DATABASE_URI` | 生产必填 | PostgreSQL URI |
| `REDIS_URI` | 生产必填 | Redis URI；每个部署使用独立 DB |
| `LLM_PROVIDER` | 必填 | `dashscope`、`deepseek`、兼容 `moonshot` |
| `LLM_API_KEY` / `LLM_TEXT_MODEL` | 必填 | 文本模型 |
| `LLM_VISION_MODEL` | 空 | 为空时视觉单元会被跳过并产生 PARTIAL；DeepSeek 可使用 `deepseek-v4-flash-vision-exp` |
| `AI_STORAGE_DIR` | `.local/ai` | AI 文件目录；相对仓库根目录解析，生产使用持久挂载的绝对路径 |
| `N_JOBS_PER_WORKER` | 8 | Agent Server 活跃 run 上限 |
| `AI_GRAPH_MAX_CONCURRENCY` | 2 | 单 run graph 并行度 |
| `AI_STORAGE_CONCURRENCY` | 4 | 单 run 本地文件存储 并发 |
| `AI_SOURCE_MAX_BYTES` | 26214400 | 源文档字节上限 |
| `AI_MAX_DOCUMENT_PAGES` | 100 | PDF 页数上限 |
| `AI_MAX_VISION_BYTES` | 52428800 | 派生视觉内容累计字节上限 |
| `AI_MAX_VISION_PAGE_PIXELS` | 25000000 | 单页渲染像素上限 |
| `AI_MAX_TOTAL_INPUT_CHARS` | 2000000 | 模型输入文本上限 |
| `AI_AGENT_MAX_TOKENS` | 16384 | 单次模型最大输出 token |
| `AI_AGENT_TIMEOUT_SECONDS` | 180 | 单次模型超时 |
| `AI_STORAGE_TIMEOUT_SECONDS` | 30 | 本地文件读写 超时 |

所有 `AI_*` 应用配置在启动时校验；非法数字、未知 provider 或缺失模型密钥 会阻止启动。密钥只通过部署平台 secret 注入，不写入镜像或仓库。

## 部署

1. 运行 CI 的 lock、Ruff、Pyright、分支覆盖率和构建门禁。
2. 从仓库根目录执行 `docker build -f Dockerfile.server -t practiq-ai:候选版本 .`，通过验收后按镜像 digest 部署。仓库 Compose 不再提供 AI profile；生产独立部署使用受管数据服务和注入的许可密钥，不使用本机 `langgraph dev` 替代。
3. 预发布按下节完成容量测试与故障演练。
4. 部署候选镜像，并观察 30 分钟后恢复正常发布节奏。

## 健康、指标与告警

- `GET /ok`：存活检查，P95 应小于 200 ms。
- [`GET /metrics`](https://docs.langchain.com/langsmith/agent-server-api/system/system-metrics)：
  Prometheus 指标。至少采集
  `lg_api_num_pending_runs`、`lg_api_num_running_runs`、
  `lg_api_workers_available` 和 HTTP latency。
- 应用日志按 run ID 检索；PARTIAL 的结构化原因直接来自 graph 输出。

告警：

| 条件 | 持续时间 |
| --- | ---: |
| pending runs > 300 | 5 分钟 |
| workers available = 0 | 5 分钟 |
| PARTIAL 比例 > 2% | 5 分钟窗口 |
| 重试耗尽 > 1% | 5 分钟窗口 |
| checksum mismatch > 0 | 立即 |
| 应用内存、主机磁盘或 PostgreSQL 磁盘 > 80% | 5 分钟 |

## 容量验收

本地先激活 `langgragh` Conda 环境。先上传一份代表性五页文档，把 graph 输入保存为 `/tmp/document-input.json`：

```bash
python scripts/load_test.py \
  --base-url http://127.0.0.1:8090 \
  --token "$AI_SERVICE_TOKEN" \
  --input /tmp/document-input.json \
  --pid "$(pgrep -n -f langgraph)"
```

默认创建 400 个独立 thread，以 100 个客户端并发提交。脚本要求 run ID 唯一、
全部成功进入终态、run 创建 P95 不超过 1 秒、`/ok` P95 不超过 200 ms、
活跃 run 不超过 8、配置模型并发上限不超过 16；提供 PID 时还要求 RSS 小于
12.8 GiB。保留测试期的 provider 并发图，确认真实 LLM/OCR 请求峰值不超过 16。

调优一次只改一个参数并重跑同一份输入：

| 现象 | 调整 |
| --- | --- |
| pending 持续增长且 CPU、内存有余量 | 提高 worker 数；同时降低 graph 并发，确保乘积不超过 16 |
| LLM 429 或重试耗尽上升 | 降低 `AI_GRAPH_MAX_CONCURRENCY` 或 `N_JOBS_PER_WORKER` |
| RSS 接近 12.8 GiB | 优先降低 `N_JOBS_PER_WORKER` |
| 本地文件存储 超时而模型空闲 | 检查 磁盘空间、权限和 I/O，再在压测后调整 `AI_STORAGE_CONCURRENCY` |

## 故障演练

每次发布候选镜像执行：

1. 处理中重启应用容器；确认同一 run 从 PostgreSQL checkpoint 恢复且没有重复终态。
2. 依次注入 LLM 429、连接超时和单页 OCR 非法输出；确认每个单元最多四次模型调用。
3. 确认单页/单 chunk 故障返回 PARTIAL，全部 chunk 失败进入 error。
4. 上传错误大小和 SHA-256 引用；确认模型未被调用且 run 进入 error。
5. 暂停 Redis 后恢复；确认流暂时中断但 PostgreSQL 中的 run 未丢失。

## 数据生命周期与恢复

- `AI_STORAGE_DIR` 必须持久保存并备份；当前不自动清理 AI 文件。清理前确认文件已超过任务重试和 checkpoint 恢复窗口，不得删除仍有引用的文件。
- 恢复数据库时同步恢复对应文件目录；多个进程必须使用同一目录。容器重建时复用持久挂载，不能依赖容器可写层。
- PostgreSQL 开启每日全量备份与持续 WAL/PITR，保留期至少覆盖业务恢复目标；每月
  在隔离环境执行恢复验证。
- Redis 不保存 run/checkpoint 的权威数据，不从 Redis 备份恢复任务。
- 恢复顺序：恢复 PostgreSQL → 验证 schema/连接 → 启动 Redis → 启动相同镜像
  digest 的应用容器 → 检查 `/ok`、pending/running runs 和抽样 checksum。

## 回滚

30 分钟观察期内若错误率、PARTIAL 或资源指标越过阈值：

1. 暂停新任务。
2. 回滚服务镜像和客户端镜像到上一 digest。
3. 保留失败 run、日志和 本地文件存储 对象用于复盘；确认队列稳定后再开放流量。

只有容量实测证明单机不足或需要主机级高可用时，才按
[官方扩展指南](https://docs.langchain.com/langsmith/agent-server-scale)
切换 Agent Server 的
split API/queue 或分布式运行形态；不引入 Celery、Kafka 或自建队列。

## Java compatibility traffic

The `/api/v1/ai/*` facade retains a 180-second total request deadline (including queueing and 本地文件存储). Java's worker read timeout is 185 seconds and its own task deadline remains authoritative. Failure usage reaches Java's existing ledger/refund rules. Native runs retain checkpoint/resumption; the synchronous facade intentionally has no independent durable product queue. Java retains source files for its existing failed-job retry window and deletes local sources after successful persistence. 本地文件存储 objects follow the independent lifecycle above.

`AI_AGENT_MAX_CONCURRENCY` (default 4) bounds simultaneous Java facade operations per process. Native graph calls also consume provider capacity; the original `N_JOBS_PER_WORKER * AI_GRAPH_MAX_CONCURRENCY <= 16` check bounds native traffic only, not aggregate mixed traffic. Capacity-test both channels before production. No real provider/load evaluation was performed during migration; historical reports remain historical failed evidence, not new baselines.
