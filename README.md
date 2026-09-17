# PractiQ

本机运行的单用户题库与学习工具：管理题目、导入资料、练习判分、查看学习分析和 AI 报告。无需登录，没有会员、积分或支付功能。

## 架构

| 目录 | 职责 |
| --- | --- |
| `web/` | React 19 + Vite + TypeScript + HeroUI v3，移动与桌面 Web |
| `backend/` | Python FastAPI 产品 API 与 PostgreSQL worker |
| `server/` | 私有 LangGraph AI 解析、答案生成及报告服务 |
| `db/` | 全新个人数据库结构与验证脚本 |

产品后端不需要 Java、Maven、Redis 或微信配置。内部 AI 服务的原生部署要求见 `server/README.md`。

## 本地启动

使用已有 Conda Python 环境；不要创建 `.venv`。产品后端支持 Python 3.13+，AI 包声明 Python 3.14+。`PYTHON` 与 `AI_PYTHON` 可分别指定现有解释器。Web 使用 Node 22.12+。

```bash
cp .env.example .env.local  # 仅首次；已有配置不要覆盖
make install
# AI 的 Python 3.14 环境已具备时：make server-install AI_PYTHON=/path/to/python
# 创建独立 personal-postgres-data 卷，旧 postgres-data / redis-data 保持不动
docker compose up -d personal-postgres
make backend-dev
make backend-worker  # 另一个终端
make web-dev         # 另一个终端
make server-dev AI_PYTHON=/path/to/python  # 使用 AI 功能时，另一个终端
```

打开 `http://127.0.0.1:5173`。无 AI 配置也可管理题库与练习；AI 操作会说明服务尚未配置。`AI_SERVICE_TOKEN` 必须在两个 Python 服务中一致，根目录 `.env.local` 仅配置产品后端和 worker；将 `server/.env.example` 复制为 `server/.env`（已有文件不要覆盖），配置 AI 模型与本地存储。`make server-dev` 会通过 LangGraph 加载 `server/.env`。

构建后也可运行 `make web-build`，将 `APP_ORIGIN` 设为 `http://127.0.0.1:8080`，由产品 API 托管 Web 页面。默认只监听本机，不开放局域网或公网。

## 数据边界

默认数据库为 `practiq_personal`。`db/00_schema.sql` 仅初始化空库，故意不包含删表或覆盖逻辑。旧版 SQL 归档于 `db/legacy/`，不自动升级或合并旧数据。不要执行 `docker compose down -v`。应用媒体默认存于 `.local/media`。

导入文件最大 25 MiB，媒体最大 10 MiB。成功/取消导入由 worker 清理源文件；失败文件保留 24 小时供重试。浏览器保留未完成导入的文件指纹和请求键，刷新后重新选择同一文件可恢复。放弃本地恢复不会取消服务端任务。

## 验证

```bash
make test          # HeroUI 样式约束、Web 单测、类型检查、构建
make backend-test # 创建一次性 PostgreSQL 容器，验证后移除该测试容器
make test-server  # AI 测试使用替身，不调用真实 LLM
make verify
# API / Vite 已在一次性数据库上运行时：
cd web && npx playwright test
```

产品 API 的交互文档位于 `http://127.0.0.1:8080/docs`；迁移契约见 `docs/P1-backend-contract.md`。
