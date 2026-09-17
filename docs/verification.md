# 重构验证记录

2026-09-17，本机 Python 3.13.15 / Node 22.23.2 / PostgreSQL 16 一次性数据库验证。

- `make verify`：通过。产品 API 15 项真实 PostgreSQL 集成测试、AI 服务 281 项测试、Web 4 项单元测试、严格 TypeScript、Vite 构建、HeroUI 样式规则、schema 边界检查与 Ruff。
- `npm --prefix web exec -- playwright test --config web/playwright.config.ts`：2 项浏览器测试通过。覆盖建题库、添加/发布题目、练习提交、结果展示；375/768/1440px 首页、题库、题库分析、导入、分析与设置无页面横向溢出；失败重试、文件上传及刷新恢复通过。
- `git diff --check`、`docker compose config --quiet`：通过。
- 未调用真实 LLM；AI 请求、用量和异常流程用替身验证。保留内部 AI 包的 Python 3.14+ 声明；本机测试通过不等于重新定义其支持矩阵。
- Vite 提示主 JS 块约 574 kB（gzip 179 kB），属于非阻塞体积提示，未添加额外拆包框架。

测试仅使用新建容器和独立测试 schema；现有数据库、卷及 `.env.local` 未改动。重构前的源码与工作区差异备份位于 `/tmp/practiq-rewrite.CKVj9v/`，未提交任何 commit 或推送远端。

## 本地存储替换

AI 源文件与派生产物使用 `AI_STORAGE_DIR`；已移除 OSS SDK、访问密钥要求及外部上传调用。
存储回归使用临时目录进行真实磁盘读写，覆盖鉴权上传、大小与 SHA-256、并发原子写入、重建实例后读取、路径与符号链接边界、写入失败保留原文件和临时文件清理。
旧云端文件和现有数据库未修改；历史评测结果不能作为本地存储版本的新评测证据。

本次复验：AI 服务 272 项测试通过，分支覆盖率汇总 96%；Ruff、Pyright 和离线锁文件一致性检查通过。测试使用现有 Conda 环境，未新建 `.venv`。
