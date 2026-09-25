# 开源 LangGraph 服务运维

运行时为 FastAPI / Uvicorn 单进程、开源 LangGraph 和本机 SQLite。无需 Agent Server、Redis 或 LangSmith 运行授权。解析、主观题评分和云资源费用独立计算。本文说明独立服务的启动、备份、恢复与维护；桌面数据管理见[项目说明](../../README.zh-CN.md)。

## 初始化与启动

使用已有 Python 3.14+，不创建项目 `.venv`。根目录 `.env` 由启动命令读取；进程环境优先。`AI_DATABASE_DIR` 指向专用本机磁盘目录，源码默认 `server/.local/database`，部署必须使用持久绝对路径。检测到旧 `DATABASE_URI` 时拒绝启动。旧 PostgreSQL 数据和卷不变；不自动迁移历史任务。未知非空 SQLite 库拒绝初始化。

准备 uv，并按[配置步骤](service-guide.md#本地运行)填写 `.env` 后，从仓库根目录执行：

```sh
make install-locked AI_PYTHON=/path/to/python3.14
make init-db AI_PYTHON=/path/to/python3.14
make server-dev AI_PYTHON=/path/to/python3.14
```

`make server-dev` 使用单 Uvicorn 进程，监听 `127.0.0.1:8090`；本地使用持久 SQLite 文件，数据库缺失或版本不符时启动失败，不回退内存。Graph 注册直接由 Python 完成，不再使用 `langgraph.json` 或 CLI 服务。

生产镜像由 `Dockerfile.server` 构建，包含 Python 3.14、PDFium 和中文字体。Linux ECS 上使用 host 网络，容器默认监听 `127.0.0.1:8000`，通过主机 HTTPS 反向代理访问；不要公开数据库或应用后端端口。`deploy/nginx.conf` 是主机 loopback HTTP 代理示例，上游可信入口负责 TLS。

资源配置需根据实际文档、模型延迟和并发测试确定；历史容量报告不能作为当前部署规格的保证。不要在多个 Uvicorn worker、自动缩容到零的函数计算实例或滚动重叠副本中运行。

## 数据与迁移

备份和升级时保留配套的数据库、文件与配置：

- `tasks.sqlite` 保存业务任务、运行、幂等回执；`checkpoints.sqlite` 与 `store.sqlite` 由官方 SQLite 持久化组件管理。启用 WAL、FULL 同步、外键和 5 秒忙等待；禁止网络文件系统和多服务进程。
- `subjective-grades.sqlite` 保存主观题评分请求的 ID、摘要及响应，按首次评分请求创建。独立服务备份需保留该文件，避免丢失请求复用记录；它不属于文档任务队列，也不由文档任务清理命令清理。
- 新服务使用新文件根目录（示例 `.local/ai-oss`，生产必须为持久挂载的绝对路径）或独立 OSS Bucket。旧任务、旧 checkpoint 和文件保留在原环境；不自动迁移、不删除、不复用旧状态库。
- local/OSS 上传和素材读取继续进行鉴权、大小与 SHA-256 校验。OSS 凭证只保留在服务器；新 Bucket 仍由运维预先创建。
- 切换存储、代码、模型或语义配置后，旧任务须在原版本完成；不尝试绕过执行指纹。数据库凭证不写入图状态或日志。
- 停止服务及维护进程后备份整个 SQLite 目录与对应文件存储（包括存在的 WAL 文件），恢复时保持同一版本和配套数据；不可只复制运行中的主数据库文件；单实例不承诺主机级高可用。

## 队列、暂停和恢复

`N_JOBS_PER_WORKER=8` 控制进程内活跃任务上限，`AI_GRAPH_MAX_CONCURRENCY=2` 控制单任务单元并行；`AI_DEPLOYMENT_WORKERS` 必须为 1。请求在任务与队列事务提交后返回 202，数据库唯一约束保证同一 thread 只有一个待执行/运行中的 run。重复请求返回原回执；新请求超出 `AI_MAX_BUSY_THREADS=300` 返回 503。

进程持有标准库 `flock` 文件锁，第二实例拒绝启动；锁文件不能删除或替换。崩溃由内核释放锁，锁文件被替换时进程停止。监督程序负责重启。数据库不可用时不继续接单或偷偷改用内存队列。

异常重启自动继续未完成 run，保留原 run ID、截止时间、任务预算和未知用量。已有完成 checkpoint 只修正任务终态。人工暂停、主动中断和 `WAITING_REVIEW` 不自动继续。进程停机停止接单，最多等待 60 秒；未完成任务保存为可恢复状态。服务管理器须留至少 65 秒终止窗口。

每个 run 默认 1,800 秒；人工恢复创建新 run，崩溃恢复不重置该 run 截止。任务默认最多预留 400 次模型调用，未使用预留、失败和未知调用均不退款。单单元最多四次模型尝试、最多两轮人工补跑，沿用原有错误分类。

checkpoint 保存的成功单元会复用；外部模型请求已执行但结果未持久化时可能重发，未知用量保留，不承诺供应商调用恰好一次。暂停不强制终止已接收的远端请求；取消本地等待也不等于终止底层同步线程。

## 配置与观测

完整变量见[配置模板](../../.env.example)。保留源文件 25 MiB、100 页、视觉/文本预算、输入严格校验、转换超时、PDFium 互斥及供应商并发和每分钟请求数（RPM）限流。监控入口与观测边界如下：

- `GET /ok`：公开活性检查，仅返回 `{"ok":true}`。
- `GET /ready`：数据库、独占锁监控和调度器可用返回 200，否则 503；无敏感详情。
- `GET /api/metrics`：Bearer 鉴权，保留阶段、调用与结果指标；新增 `practiq_pending_runs`、`practiq_running_runs`、`practiq_workers_max`、`practiq_workers_available`。不再提供原生 `/metrics`。
- `GET /api/maintenance`：查询维护配置。`AI_MAINTENANCE_MODE=true` 拒绝上传和新 run，保留查询与暂停/取消，已入队任务继续排空。
- `provider_concurrency_wait`、`provider_rate_wait`、`provider_request` 区分本地等待和 SDK 请求耗时；SDK 时间不是纯模型推理时间。
- 日志与指标不保存正文、图片、密钥或原始错误详情。用量未知时不能推断零成本；账单与持久调用记录单独核对。

`deploy/alerts.rules.yml` 保留部分结果、未知用量、预算、校验和、队列和延迟告警。`SUCCEEDED` 不代表语义质量通过；调用方仍检查 `processing.quality`。

## 评分请求的恢复边界

`POST /api/subjective-grades` 同步处理一题，不进入文档队列。维护模式拒绝评分；已经发往模型的调用可能继续完成。评分使用公共模型限流、重试和用量记录，但不受文档任务的 180 天期限、400 次总调用预算或 run 截止时间管理。

进程中断可能留下已登记但没有结果的评分请求。相同 ID 重放返回 `unknown`，服务不会自动再次调用模型；只有明确重新评分并使用新 ID 才开始新的请求。保留未知用量，并与供应商账单核对。服务不自动清理评分缓存，维护方案应单独考虑其保存期限。

桌面 ZIP 备份包含考试与已保存评分，但不含此服务缓存或 API Key。完整服务备份与桌面题库备份用途不同，不能互相替代。

## 保留期限与清理

文档任务有效期 180 天。过期状态不会在启动时自动删除。排空并停止服务后，设置 `AI_MAINTENANCE_MODE=true`，使用同一配置执行：

```sh
cd server
python -m practiq_ai.manage cleanup-state
```

命令获得与服务相同的独占锁，仅删除过期且无活跃 run 的任务；通过官方 API 清理 checkpoint 与 Store，最后删除业务记录。中断后可以重入。维护时禁止其他程序直接写同一数据库/存储。

文件脚本直接连接 SQLite，默认只读盘点：

```sh
python scripts/storage_gc.py --output /absolute/new-inventory.json
```

shell 须预先加载配置。盘点所有保留任务、完整 checkpoint 历史和 Store；任一读取失败立即停止。默认保留至少 187 天。`--quarantine` 必须在维护模式、排空、停止服务后执行；独占锁阻止服务同时启动，先保存可恢复清单再移动。local 隔离至同根 `.quarantine/<runId>/`；OSS 必须启用版本控制且仅创建 delete marker。未执行真实 OSS 清理。

## 验证恢复与容量

`make verify` 使用临时 SQLite 文件和模型替身，不调用外部模型，也不需要 PostgreSQL 或 Docker 数据库。独立进程测试覆盖强制终止、未知调用与人工审核恢复。

先启动服务，再从仓库根目录运行文档任务压测：

```sh
cd server
python -m dotenv -f ../.env run -- python scripts/load_test.py \
  --base-url http://127.0.0.1:8090 \
  --text '1. What is 2 + 2? A. 3 B. 4 Answer: B' \
  --total 20 --submit-concurrency 5 --output reports/new-load.json
```

压测只支持文档业务 API。连接真实模型的压测与评测会产生费用，需另行安排。历史 `Agent Server`/Redis/许可证和旧容量报告保留作为历史证据，不代表新运行时验收。

## 2026-09-19 恢复与资源边界修复

以下记录保留该次修复的行为与升级要求：

- 控制事务在取得连接前串行排队；恢复文件预检在全局锁外执行，并在入队前重新核对当前运行与 checkpoint。执行阶段的预检与图共享持久化运行期限。
- 暂停和人工审核使用独立 checkpoint 节点。失败审核和结果质量审核均需先恢复暂停，再提交审核决定。升级后旧执行签名不兼容，旧任务须使用原部署恢复或新建任务。
- 文档提取在独立进程组执行，超时或取消后终止并等待进程回收，转换器子进程也在此组内。临时目录由父进程清理。存储使用独立有界线程池；等待超时不释放仍在工作的 I/O 槽位，满载时有界等待，达到存储等待期限返回 `OBJECT_STORE_UNAVAILABLE`，底层工作结束后恢复容量。OSS 连接和读写仍各有 SDK 超时。
- 二进制上传总接收期限为 `AI_UPLOAD_TIMEOUT_SECONDS`（默认 120 秒），包括持续但过慢的传输；超时返回 408 / `UPLOAD_TIMEOUT` 并释放上传槽位。按实际网络和文件大小调整该值。
- `practiq.events` 在服务启动时配置 INFO 和 JSON handler；日志只允许既有白名单字段。队列告警比较同实例的 pending + running 与 `practiq_queue_capacity`，该指标取实际 `AI_MAX_BUSY_THREADS`。
- 初始化在空库先记录本服务标记，允许仅含已知初始化表的受控半初始化库重试；未知非空库及已完成的库仍被拒绝。业务 DDL 与标记删除原子提交。无标记的历史半初始化库不会自动接管。
- GC 完成状态通过同目录临时文件、fsync 和原子替换写入；最终更新失败时保留原恢复清单，`completed=false` 不表示对象尚未移动，应按清单核对隔离目录。

### 本地存储路径升级

源码运行时相对 `AI_STORAGE_DIR` 固定从 `server/` 解析，不随工作目录变化。wheel 安装必须设置绝对路径（Docker 镜像默认 `/var/lib/practiq`）。旧版本误从仓库根解析相对路径；若该旧目录非空，新版本明确报错，禁止静默切换数据根。

升级前记录原目录的绝对路径，将 `AI_STORAGE_DIR` 设为该路径即可保留原位置。需要迁移时，先停服务并备份，人工复制到新持久目录、核验对象和校验和，再切换绝对路径。保留原目录和配置用于回退；服务不会移动、删除或自动修改既有文件权限。

### 非特权容器部署

镜像使用 UID/GID `10001:10001`。`server/deploy/service.compose.yml` 提供 Linux 主机部署约束：2 CPU、2 GiB 内存、128 进程、只读根文件系统、禁用所有 capabilities、禁止提权，并由 init 回收孤儿进程。仅持久目录 `/var/lib/practiq`、有界 tmpfs `/tmp` 与 `/home/practiq` 可写；提取临时文件置于这些可写范围。

使用前设置 `PRACTIQ_STORAGE_DIR` 为已核验的宿主持久目录绝对路径，并确认 UID 10001 有读取和写入权限。不要对现有挂载自动递归改权限；可选择已有专用组/ACL，或人工复制到新的专用目录并保留回退数据。SQLite 目录固定为持久挂载内的 `/var/lib/practiq/database`，必须从 `.env` 移除旧 `DATABASE_URI`；服务通过 host 网络仅监听 `127.0.0.1:8000`。用 `docker compose -f server/deploy/service.compose.yml config --quiet` 检查配置，再在授权部署环境启动。资源额度是起始值，需按实际文档和并发容量验证。

桌面模式在重启时将未完成任务保留为中断状态，用户点击“继续”后才重新产生模型调用；独立 server 仍自动恢复原 run。桌面题库 ZIP 备份不包含 AI 任务目录。
