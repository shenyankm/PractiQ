# 开源 LangGraph 运行时迁移验收（2026-09-19）

已用 FastAPI + 开源 LangGraph + PostgreSQL 替换官方 Agent Server。仅文档业务 API，单实例单进程；无需商业 Agent Server 运行包、Redis 或许可证。未部署、提交或推送。

## 实现

- 保留上传、素材、任务控制与结果契约；新增 `/ok`、`/ready` 及本服务队列指标，移除官方原生 HTTP/SDK 路由。
- 使用 AsyncPostgresSaver / AsyncPostgresStore；任务、run、幂等回执三张业务表，事务入队、容量门禁、同任务排他执行。
- 会话锁保证单实例；数据库锁失联立即退出进程。异常重启沿用 run ID、截止、预算和调用记录，人工暂停、中断、审核保持等待。
- 控制回执持久化，补跑保留成功单元，人工接受不清除质量标记。模型请求与数据库不能实现跨系统恰好一次；响应未持久化时可能重发，未知用量不退款。
- 新数据库须显式初始化，非空库拒绝初始化。清理仅显式维护执行；独占锁监控保护状态清理与文件隔离，历史 checkpoint 与 Store 参与引用盘点。
- Python 3.14 镜像保留 LibreOffice Writer/Calc 和中文字体；CI、运维说明及脚本改用新运行时。

## 当前版本证据

- `make verify AI_PYTHON=/Users/sheny/.local/share/uv/python/cpython-3.14-macos-aarch64-none/bin/python3.14`：**449 passed，94% 覆盖率**；Ruff / Pyright、25 个 fixture 校验、故障探针和源码/wheel 构建通过。
- [最终验证日志](checks/oss-migration/verify.log)、[JUnit](checks/oss-migration/tests.xml)、[源码 SHA-256 清单](checks/oss-migration/source-manifest.json)。
- [最终故障探针](evaluations/61522fef-1c59-457d-b585-e3981ff0af38/report.json) 为 PASSED。其 `durableCrashRecovery=NOT_ASSESSED` 仅描述原离线探针子集；下面的独立进程测试单独证明本轮恢复行为。
- `tests/test_agent_server.py`：10 个真实 HTTP / 独立进程 / PostgreSQL 检查，覆盖入队后、模型调用中、成功单元保存后、最终状态回写前的强杀重启，审核决定应用前后强杀、人工中断/暂停保持，以及数据库锁失联退出。
- `tests/test_runtime.py`：9 项 PostgreSQL 检查覆盖初始化拒绝、单实例排他、就绪、幂等清理、并发容量、过期任务、截止和未知用量在重启后保留。
- `tests/test_task_api.py`：12 项任务 API 回归，包括重复请求、冲突、暂停恢复、补跑、接受部分结果、来源审核、截断与重试上限。
- Linux **ARM64** 镜像构建及实际启动通过；隔离 PostgreSQL 初始化成功，容器 `/ok`、`/ready` 和鉴权指标返回成功，运行槽为 8。镜像内确认无 `langgraph_api`、`langgraph_cli`、`redis` 包；LibreOffice 7.4.7.2 可执行。未在本机验证 AMD64 镜像运行。
- 本地镜像：`practiq-ai:oss-migration-check`，ID `sha256:5b499402c4d3e2b7a5e6b3cf860ffdb3b78773a566ff4270651c31cded81c39b`。见 [构建日志](checks/oss-migration/docker-build.log)。
- 与迁移前快照逐字节核对，14 个解析图、提取器、模型调用和契约文件不变，包括已有 Excel 改动。快照位于 `/var/folders/1b/b19xbzjx7xqc4kl0k9x_y4y80000gp/T/practiq-before-oss-69czcfvx/workspace.tar.gz`。

## 启动与边界

现有 `.env`、旧数据库、卷和文件未改动。正式启动前，在本地配置新的 `DATABASE_URI` 与独立 `AI_STORAGE_DIR`（或独立 OSS Bucket），运行 `make init-db`，再运行 `make server-dev`；已有旧任务继续留在原环境。

本轮模型均为替身，未调用付费模型、未访问真实 OSS。此次验收证明运行时迁移和已覆盖的恢复行为，不证明真实模型质量、正式容量或高可用；原有质量失败报告保持原样。
