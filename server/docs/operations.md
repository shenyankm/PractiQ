# PractiQ server 运维手册

## 本机开发（默认）

本地仅启动 AI Agent Server，不需要产品数据库或 Compose。
激活已有 Python 3.14+ 环境后执行 `make server-install`、`make server-dev`（仓库根目录）。
已有环境直接复用。不要创建项目 `.venv`。
`langgraph dev` 不使用 `DATABASE_URI`/`REDIS_URI` 提供生产级持久化，不承诺 PostgreSQL 任务与 checkpoint 恢复。
下述生产部署和恢复要求不适用于该开发模式。

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
2. 从仓库根目录执行 `docker build -f Dockerfile.server -t practiq-ai:候选版本 .`，通过验收后按镜像 digest 部署。生产独立部署使用受管数据服务，运行时部署要求以官方说明为准，不使用本机 `langgraph dev` 替代。
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

## 资源边界与本地验收

本地运行使用 `make server-dev`，不需要 PostgreSQL/Redis，状态保存在开发目录。
开发模式的文件落盘与生产 PostgreSQL 恢复分别验收。
隔离数据库演练配置为 `deploy/recovery.compose.yml`，使用独立 Compose project，
端口只绑定 `127.0.0.1`；其中的测试口令只用于该隔离环境。不得连接生产数据库或
复用生产卷。启动数据库：

```sh
docker compose -p practiq-review -f server/deploy/recovery.compose.yml up -d postgres redis
```

以下应用设置均在 `server/.env.example` 中列出：

| 设置 | 默认 | 约束 |
| --- | ---: | --- |
| `AI_TASK_MAX_MODEL_CALLS` | 400 | 整个任务含补跑、暂停恢复和未知结果重放的调用槽预算 |
| `AI_RUN_TIMEOUT_SECONDS` | 1800 | 每个 run 从执行阶段开始计时；新 run 可重新计时，任务预算不刷新 |
| `AI_MODEL_MAX_INPUT_CHARS` | 64000 | 每次模型尝试的全部文本消息，含纠错上下文；不含图像 Base64 |
| `AI_DEPLOYMENT_WORKERS` | 1 | 整个部署中实际调用同一 provider 的 worker 总数，含所有副本 |
| `AI_PROVIDER_CONCURRENCY` | 16 | 部署分配到的 provider 并发预算 |
| `AI_PROVIDER_RPM` | 120 | 部署分配到的每分钟请求预算 |
| `AI_UPLOAD_CONCURRENCY` | 4 | 每个进程的同时上传处理上限；超出返回 429 |
| `AI_MAX_BUSY_THREADS` | 300 | 原生 busy thread 接单水位；超出返回 503 |
| `AI_MAINTENANCE_MODE` | false | 排空维护：禁止上传、新 run、原生状态/Store 写入，保留查询和取消 |

任务 gate 在并发派发前为每个单元/补跑轮次预留最多 4 个槽，真实尝试前在 Store
写入消耗。未用槽、失败写入和未知调用不返还，故 400 是上限，可能在少于 400 次
实际调用时停止；查询响应的 `modelBudget.reserved` 不是实际调用次数。此保守策略
避免新增全局计数器的并发事务。单元唯一写者依赖原生 thread 排他运行；原生调用须用
`multitask_strategy=reject`，不可绕过任务控制更改内部状态或预算。

文本分片目标 30,000 字符，硬上限 40,000 字符；不可安全保留题目边界的超长题返回
`DOCUMENT_CHUNK_TOO_LARGE`。每次模型输入独立检查，超限为 `MODEL_INPUT_TOO_LARGE`。
任务预算耗尽为 `MODEL_BUDGET_EXCEEDED`，不允许补跑；已有成功单元保留为 PARTIAL，
全部失败按既有失败语义处理。run 截止为 `RUN_DEADLINE_EXCEEDED`。

provider 配额按 worker 数向下取整静态分配；并发有 semaphore，RPM 用进程内滚动
60 秒窗口。另有 `N_JOBS_PER_WORKER × AI_GRAPH_MAX_CONCURRENCY × AI_DEPLOYMENT_WORKERS`
配置检查。不能让部署外的服务再使用同一份配额；滚动发布重叠实例也必须计入总数。
RPM 窗口不跨重启保留；严格的跨重启账户级限额应由已有 provider 网关承担。
队列水位检查不是原子队列容量，并发接单可能超调，须同时使用 `deploy/nginx.conf`
的入口速率、连接数、请求体和超时限制。禁止公开绕开网关的后端端口；原生 batch
和 cron 提交也被拦截，不引入另一套队列。

PDFium 全部调用（PDF、DOCX 转 PDF、页计数、渲染、释放）共用进程内互斥。
取消 `to_thread` 的等待不等于终止底层线程；锁在底层调用结束时释放。若实测需要
硬 CPU/内存隔离，再把渲染迁移到可终止的有界子进程。

容量脚本默认压测 `/api/document-tasks`；`--api native` 覆盖原生入口；
`--allow-rejections` 用于过载演练，接受 429/503 但必须存在成功任务，PARTIAL 不算成功。
`--environment standalone --image-digest sha256:...` 才标为生产独立运行时证据。
报告区分配置模型并发与采样的实际 provider 槽数；200 ms 采样可能遗漏瞬间峰值，
`observedQueueWaitP95Seconds` 是轮询观察到的上界，不是原生精确排队时间。
本地 dev worker 数可能不同于生产配置，报告同时记录观察到的 worker 上限。

## 业务指标与安全日志

鉴权后的 `/api/metrics` 使用 Prometheus 文本格式，与原生 `/metrics` 分开采集。
`practiq_stage_seconds` 覆盖 prepare（含转换）、vision/chunk、model（含等待）、merge 等阶段；
`practiq_provider_inflight` 是进程内占用槽数；`practiq_model_calls_total` 区分 known、unknown
和 rejected；`practiq_document_results_total` 区分 SUCCEEDED/PARTIAL 及质量审核标记；
`practiq_failures_total` 按固定错误码计数。多个进程分别抓取再聚合，不能只采负载均衡地址。
重放可能重复计数，这些指标用于运维趋势，账单核验以持久调用记录和 provider 账单为准。

`practiq.events` 日志仅写阶段、单元、thread/run/call 标识、耗时和错误码；不写文档正文、
模型原始输出、原图或密钥。调用记录新增 `startedAt`、`finishedAt`、`durationMs`；进程在
响应前消失时保留 started/unknown，不伪造完成时间或零消耗。进程硬退出也可能丢失最后
一次指标增量，应同时核对任务查询的 `unknownUsageCalls`。

`deploy/alerts.rules.yml` 给出 PARTIAL、unknown、预算/截止、校验和、队列和模型延迟告警。
`deploy/alerts.test.yml` 可用 `promtool test rules` 验证告警实际触发。
`SUCCEEDED` 不代表题目完整；调用方必须检查 `processing.quality.reviewRequired` 和
`missingFields`，将无原文答案作为草稿。`failurePolicy=review` 仍仅处理执行失败，
不擅自改变为语义质量阻断。

## 引用感知文件盘点与可恢复清理

默认只盘点：在服务相同的配置/挂载下运行（shell 预先加载配置，不向日志打印密钥）：

```sh
python scripts/storage_gc.py --base-url http://127.0.0.1:8090 --output /tmp/storage-inventory.json
```

默认保留至少 187 天（任务 180 天加 7 天余量）。脚本遍历全部 thread 的历史 checkpoint
以及 document_tasks Store，任一 source hash 仍被引用时保留该源文件及其全部素材。
任一 API/存储盘点失败直接停止，不能把失败当作零引用。

需要清理时，在所有副本设 `AI_MAINTENANCE_MODE=true` 并排空原有任务，同时停止直写同一
目录/Bucket 的其他程序。运行相同命令加 `--quarantine` 和新的清单路径；脚本检查维护状态
及无 busy thread、重读引用和对象元数据，并先持久化恢复清单再移动文件。
只有在确认所有副本/外部写者停写后才可执行，单个 HTTP 端点无法替运维证明全局停写。

local 移入同一根目录的 `.quarantine/<runId>/<objectKey>`，不永久删除；恢复时按清单将
文件移回原 key，并通过正常 checksum API 复核。OSS 分支仅允许已启用版本控制的 Bucket，
不传 version_id 的删除形成可恢复 delete marker；恢复由运维删除对应 marker。
任一中断留下 `completed=false` 清单，核对已移动对象后恢复，不盲目重跑。此次没有执行
真实 OSS 清理或验收。符号链接目录、对象变化、未启用 OSS 版本控制均拒绝清理。

基础镜像已按 digest 固定；`uv.lock` 随 wheel 打包，并纳入执行指纹，运行时依赖版本和
Python 补丁版本也参与恢复兼容校验。旧任务须在原候选镜像完成/恢复，不迁移旧状态。
