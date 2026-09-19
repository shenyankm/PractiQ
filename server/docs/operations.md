# 开源 LangGraph 服务运维

运行时为 FastAPI / Uvicorn 单进程、开源 LangGraph 和 PostgreSQL。无需 Agent Server、Redis 或 LangSmith 运行授权。解析模型和云资源费用独立计算。

## 初始化与启动

使用已有 Python 3.14+，不创建项目 `.venv`。根目录 `.env` 由启动命令读取；进程环境优先。`DATABASE_URI` 必须指向新建的独立 PostgreSQL 数据库（16+）。不要复用 Agent Server 数据库；初始化命令发现 public schema 已有表就拒绝，不修改已有数据。

```sh
make install AI_PYTHON=/path/to/python3.14
make init-db AI_PYTHON=/path/to/python3.14
make server-dev AI_PYTHON=/path/to/python3.14
```

`make server-dev` 使用单 Uvicorn 进程，监听 `127.0.0.1:8090`；本地也必须有 PostgreSQL，数据库缺失或版本不符时启动失败，不回退内存。Graph 注册直接由 Python 完成，不再使用 `langgraph.json` 或 CLI 服务。

生产镜像由 `Dockerfile.server` 构建，包含 Python 3.14、LibreOffice Writer/Calc 和中文字体。Linux ECS 上使用 host 网络，容器默认监听 `127.0.0.1:8000`，通过主机 HTTPS 反向代理访问；不要公开数据库或应用后端端口。`deploy/nginx.conf` 是主机 loopback HTTP 代理示例，上游可信入口负责 TLS。

推荐部署基线仍为 8 vCPU / 16 GB，须通过实际容量验收后调整。不要在多个 Uvicorn worker、自动缩容到零的函数计算实例或滚动重叠副本中运行。

## 数据与迁移

- PostgreSQL 使用业务任务、运行、幂等回执三张表；checkpoint 和 Store 表由官方开源持久化组件管理。
- 新服务使用新文件根目录（示例 `.local/ai-oss`，生产必须为持久挂载的绝对路径）或独立 OSS Bucket。旧任务、旧 checkpoint 和文件保留在原环境；不自动迁移、不删除、不复用旧状态库。
- local/OSS 上传和素材读取继续进行鉴权、大小与 SHA-256 校验。OSS 凭证只保留在服务器；新 Bucket 仍由运维预先创建。
- 切换存储、代码、模型或语义配置后，旧任务须在原版本完成；不尝试绕过执行指纹。数据库凭证不写入图状态或日志。
- 备份 PostgreSQL 与对应文件存储，恢复时保持同一版本和配套数据；单实例不承诺主机级高可用。

## 队列、暂停和恢复

`N_JOBS_PER_WORKER=8` 控制进程内活跃任务上限，`AI_GRAPH_MAX_CONCURRENCY=2` 控制单任务单元并行；`AI_DEPLOYMENT_WORKERS` 必须为 1。请求在任务与队列事务提交后返回 202，数据库唯一约束保证同一 thread 只有一个待执行/运行中的 run。重复请求返回原回执；新请求超出 `AI_MAX_BUSY_THREADS=300` 返回 503。

进程独占 PostgreSQL 会话锁；第二实例拒绝启动。锁连接异常时立即停止进程，包括未结束的转换线程；监督程序负责重启。数据库不可用时不继续接单或偷偷改用内存队列。

异常重启自动继续未完成 run，保留原 run ID、截止时间、任务预算和未知用量。已有完成 checkpoint 只修正任务终态。人工暂停、主动中断和 `WAITING_REVIEW` 不自动继续。进程停机停止接单，最多等待 60 秒；未完成任务保存为可恢复状态。服务管理器须留至少 65 秒终止窗口。

每个 run 默认 1,800 秒；人工恢复创建新 run，崩溃恢复不重置该 run 截止。任务默认最多预留 400 次模型调用，未使用预留、失败和未知调用均不退款。单单元最多四次模型尝试、最多两轮人工补跑，沿用原有错误分类。

checkpoint 保存的成功单元会复用；外部模型请求已执行但结果未持久化时可能重发，未知用量保留，不承诺供应商调用恰好一次。暂停不强制终止已接收的远端请求；取消本地等待也不等于终止底层同步线程。

## 配置与观测

完整变量见根目录 `.env.example`。保留源文件 25 MiB、100 页、视觉/文本预算、输入严格校验、转换超时、PDFium 互斥及供应商并发/RPM 限流。

- `GET /ok`：公开活性检查，仅返回 `{"ok":true}`。
- `GET /ready`：数据库、独占锁监控和调度器可用返回 200，否则 503；无敏感详情。
- `GET /api/metrics`：Bearer 鉴权，保留阶段、调用与结果指标；新增 `practiq_pending_runs`、`practiq_running_runs`、`practiq_workers_max`、`practiq_workers_available`。不再提供原生 `/metrics`。
- `GET /api/maintenance`：查询维护配置。`AI_MAINTENANCE_MODE=true` 拒绝上传和新 run，保留查询与暂停/取消，已入队任务继续排空。
- `provider_concurrency_wait`、`provider_rate_wait`、`provider_request` 区分本地等待和 SDK 请求耗时；SDK 时间不是纯模型推理时间。
- 日志与指标不保存正文、图片、密钥或原始错误详情。用量未知时不能推断零成本；账单与持久调用记录单独核对。

`deploy/alerts.rules.yml` 保留部分结果、未知用量、预算、校验和、队列和延迟告警。`SUCCEEDED` 不代表语义质量通过；调用方仍检查 `processing.quality`。

## 保留期限与清理

任务有效期 180 天。过期状态不会在启动时自动删除。排空并停止服务后，设置 `AI_MAINTENANCE_MODE=true`，使用同一配置执行：

```sh
cd server
python -m practiq_ai.manage cleanup-state
```

命令获得与服务相同的独占锁，仅删除过期且无活跃 run 的任务；通过官方 API 清理 checkpoint 与 Store，最后删除业务记录。中断后可以重入。维护时禁止其他程序直接写同一数据库/存储。

文件脚本直接连接新 PostgreSQL，默认只读盘点：

```sh
python scripts/storage_gc.py --output /absolute/new-inventory.json
```

shell 须预先加载配置。盘点所有保留任务、完整 checkpoint 历史和 Store；任一读取失败立即停止。默认保留至少 187 天。`--quarantine` 必须在维护模式、排空、停止服务后执行；独占锁阻止服务同时启动，先保存可恢复清单再移动。local 隔离至同根 `.quarantine/<runId>/`；OSS 必须启用版本控制且仅创建 delete marker。未执行真实 OSS 清理。

## 验证

`make verify` 使用真实隔离 PostgreSQL和模型替身，不调用外部模型。本地未提供 `TEST_DATABASE_URI` 时，测试创建并销毁专属 Docker PostgreSQL；CI 使用专属 PostgreSQL service。不要将测试连接指向生产实例，测试账号需要创建/删除测试数据库权限。

```sh
cd server
python scripts/load_test.py --base-url http://127.0.0.1:8090 --text '1. What is 2 + 2? A. 3 B. 4 Answer: B' --total 20 --submit-concurrency 5 --output reports/new-load.json
```

压测只支持文档业务 API。连接真实模型的压测与评测会产生费用，需另行安排。历史 `Agent Server`/Redis/许可证和旧容量报告保留作为历史证据，不代表新运行时验收。
