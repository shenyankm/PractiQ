# PractiQ server 运维手册

## 本机开发（默认）

本地仅启动 AI Agent Server，不需要产品数据库或 Compose。
激活已有 Python 3.14+ 环境后执行 `make server-install`、`make server-dev`（仓库根目录）。
已有环境直接复用。不要创建项目 `.venv`。
`langgraph dev` 不使用 `DATABASE_URI`/`REDIS_URI` 提供生产级持久化，不承诺 PostgreSQL 任务与 checkpoint 恢复。
下述生产部署、许可证和恢复要求不适用于该开发模式。

## 生产基线

- 单应用容器：8 vCPU / 16 GB；外部 PostgreSQL 和 Redis。
- `N_JOBS_PER_WORKER=8`，每批模型单元上限 `AI_GRAPH_MAX_CONCURRENCY=2`，模型理论并发上限 16。
- 单 run 内文件存储并发 4；源文档最大 25 MiB、100 页。
- 同时提交 100 个任务，可短时积压 300 个；不是 100 个同时执行。
- 任务控制创建 run 使用 `durability=sync`、`multitask_strategy=reject`；原生调用也应使用同样设置。底层 `max_concurrency` 为单元批量上限的两倍，为原生持久 task 留出执行槽位，不会增加模型并发。
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
| `LLM_API_KEY` / `LLM_VISION_MODEL` | 必填 | 所有格式共用同一视觉模型；删除 `LLM_TEXT_MODEL`。页面直接结构化提题，无独立 OCR/文本模型串联 |
| `AI_STORAGE_BACKEND` | `local` | `local` 或 `oss` |
| `AI_OSS_REGION` / `AI_OSS_BUCKET` | OSS 必填 | 地域与已有私有 Bucket |
| `AI_OSS_ACCESS_KEY_ID` / `AI_OSS_ACCESS_KEY_SECRET` | OSS 必填 | 服务端访问凭证 |
| `AI_OSS_SECURITY_TOKEN` | 空 | 可选 STS token；过期前更新并重启 |
| `AI_OSS_ENDPOINT` / `AI_OSS_USE_CNAME` | 空 / `false` | 可选 HTTPS 端点及自定义域名开关 |
| `AI_STORAGE_DIR` | `.local/ai` | AI 文件目录；相对 `server/` 目录解析，生产使用持久挂载的绝对路径 |
| `N_JOBS_PER_WORKER` | 8 | Agent Server 活跃 run 上限 |
| `AI_GRAPH_MAX_CONCURRENCY` | 2 | 单 run graph 并行度 |
| `AI_STORAGE_CONCURRENCY` | 4 | 单 run 文件存储并发 |
| `AI_SOURCE_MAX_BYTES` | 26214400 | 源文档字节上限 |
| `AI_MAX_DOCUMENT_PAGES` | 100 | PDF 及 DOCX 转换后页数上限 |
| `AI_SOFFICE_PATH` | `soffice` | LibreOffice 可执行路径；DOCX 转换超时固定 60 秒 |
| `AI_MAX_VISION_BYTES` | 52428800 | 派生视觉内容累计字节上限 |
| `AI_MAX_VISION_PAGE_PIXELS` | 25000000 | 单页渲染像素上限 |
| `AI_MAX_TOTAL_INPUT_CHARS` | 2000000 | 模型输入文本上限 |
| `AI_AGENT_MAX_TOKENS` | 16384 | 单次模型最大输出 token |
| `AI_AGENT_TIMEOUT_SECONDS` | 180 | 单次模型超时 |
| `AI_STORAGE_TIMEOUT_SECONDS` | 30 | 文件存储操作超时 |

所有 `AI_*` 应用配置在启动时校验；非法数字、未知 provider 或缺失模型密钥 会阻止启动。密钥只通过部署平台 secret 注入，不写入镜像或仓库。

## 部署

1. 运行 CI 的 lock、Ruff、Pyright、分支覆盖率和构建门禁。
2. 从仓库根目录执行 `docker build -f Dockerfile.server -t practiq-ai:候选版本 .`，通过验收后按镜像 digest 部署。生产独立部署使用受管数据服务和注入的许可密钥，不使用本机 `langgraph dev` 替代。
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

本地先激活 Python 3.14+ 环境。先上传一份代表性五页文档，把 graph 输入保存为 `/tmp/document-input.json`：

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
12.8 GiB。保留测试期的 provider 并发图，确认真实模型请求峰值不超过 16。

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
2. 依次注入 LLM 429、连接超时和单页视觉提题非法输出；确认每个单元最多四次模型调用。
3. 确认单页/单 chunk 故障返回 PARTIAL，全部 chunk 失败进入 error。
4. 上传错误大小和 SHA-256 引用；确认模型未被调用且 run 进入 error。
5. 暂停 Redis 后恢复；确认流暂时中断但 PostgreSQL 中的 run 未丢失。

## 数据生命周期与恢复

以下目录与挂载要求适用于 `local` 模式。`oss` 模式使用已有私有 Bucket，源文件和素材均写入 OSS；按 `practiq-agent/sources/` 与 `practiq-agent/artifacts/` 前缀授予读写权限，并确保对象备份与任务数据库恢复时间匹配。切换模式不迁移数据；迁移前按原 objectKey 复制并验证对象；新版快照不允许更改存储位置继续旧任务，须原部署恢复或新建任务。不自动回退到本地或删除云端对象。两种模式均经服务鉴权 API 上传，不向客户端返回凭证。


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
2. 停止新版任务调度并隔离其 checkpoint；旧镜像只接管对应旧版本任务与数据库备份，不得读取新版 checkpoint。
3. 保留失败 run、日志和文件存储对象用于复盘；确认队列稳定后再开放流量。

只有容量实测证明单机不足或需要主机级高可用时，才按
[官方扩展指南](https://docs.langchain.com/langsmith/agent-server-scale)
切换 Agent Server 的
split API/queue 或分布式运行形态；不引入 Celery、Kafka 或自建队列。

## DOCX 渲染

DOCX 全页渲染需要 LibreOffice Writer 与中文字体；`Dockerfile.server` 安装 `libreoffice-writer` 和 `fonts-noto-cjk`。本地安装后可用 `AI_SOFFICE_PATH` 指定执行路径。服务按渲染页序识别，不回退纯文本；分页可能与 Microsoft Word 不同。临时转换文件自动清理，持久页图写入所选本地或 OSS 存储。

## 长任务版本发布与恢复验收

状态、代码/提示词/契约、模型参数、存储位置均写入执行快照。不迁移历史无版本 checkpoint。发布前停止旧版本新任务，等待旧非终态任务在原镜像完成；仍有待保留的暂停任务则延期切换。保留旧镜像、数据库备份及对应文件。

任务期限固定为创建后 180 天；Store 调用记录、暂停记录和控制记录按剩余期限写入。查询不刷新 Store TTL，也不延长应用级恢复期限；过期返回 `TASK_EXPIRED`。原生 checkpoint TTL 扫描负责清理，文件不自动删除。

先运行 `make test` 和 `make verify`。随后按 [任务说明中的生产故障演练](document-tasks.md#production-crash-drill) 在独立 PostgreSQL、Redis、持久文件卷及真实测试 OSS Bucket 执行。仅通过内存 checkpoint、假 OSS 或 `langgraph dev` 测试不能声明生产恢复保证。
