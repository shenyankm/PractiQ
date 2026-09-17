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

## 2026-09-18 题目缺失字段与完整性

实现和迁移约定见 [题目完整性](question-completeness.md)。未执行个人库迁移、提交或推送；仅使用一次性 PostgreSQL 容器及独立测试 Schema，保留现有库与历史数据。

- `make verify` 通过；后续草稿条目引用边界修改又单独通过全部后端测试。最终 AI 308 项、真实 PostgreSQL 27 项、Web 单元测试 4 项；样式规则、TypeScript、Vite 构建、Schema 边界、Ruff、Pyright 通过。运行时仍是本机 Python 3.13.15，不等于完成 Python 3.14 锁定环境验收。
- 浏览器 10 个用例均通过（首轮 9 项，修正旧用例的 HeroUI 选择器后复验剩余 1 项）。覆盖空草稿保存、空题干占位、不完整题发布禁用、`false` 保留，以及完整题发布／练习／历史结果和移动端布局。新完整性 UI 用例拦截 API，产品流程用例连接真实临时 PostgreSQL。
- 迁移测试从冻结的旧 Schema 建库，验证可追溯来源恢复、缺字段题降为草稿、历史答案与作答引用保留；后端还覆盖导入部分缺失、图片／材料依赖、答案版本、伪造数组、任务成功与用量及原有幂等／fencing 用例。
- 真实 `qwen3.7-flash`、默认 `function_calling` 的[答案样本](../server/reports/evaluations/question-completeness-smoke.json)：已知缺字段 0 次调用，缺图片、缺材料各 1 次调用正常返回待补全。正常判断题对照仍输出 JSON 字符串答案，有限纠错后拒绝，两次用量保留，整体报告不标通过。
- [文档样本](../server/reports/evaluations/question-completeness-parse-smoke.json) 2 项通过：不完整选项保留已知题型和选项，纯材料返回空题目列表。首轮丢失选项的失败证据另存 `question-completeness-parse-smoke-before.json`；补充提示词后通过，未改变判定标准。
- 历史全量文档语义门禁未达标的记录保留；这些小样本不是全量质量通过声明。Vite 的单块体积提示仍为非阻塞提示。

## 本地 JSON Repair 补充

文档解析和答案生成均在有限模型纠错前尝试本地标点修复，并重新校验 Schema／内容。AI 全套 327 项通过；随后新增字符串、`false`、`0`、`null` 保真用例，结构化输出专项 27 项通过。覆盖普通响应和工具参数、解析器失败后修复、缺字段通过且仅记录一次调用，以及截断／缺值／错误类型不被放行。Ruff、Pyright 和 `git diff --check` 通过。本次没有更改数据库或调用真实模型。
