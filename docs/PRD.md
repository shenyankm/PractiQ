# OpenWook PRD

## 1. Product Overview

OpenWook 是一个面向教师和教育机构的题库管理与智能练习平台。用户可创建和管理学科题库、手动或 AI 批量导入试题、组织练习与考试会话，并获取多维度的学习分析报告。系统采用分栈架构，Go 提供 REST API，Python 提供 AI 文档解析服务，React 提供 Web 前端，PractiQ/Expo 提供 Android 与 iOS 客户端。

## 2. 目标用户

| 角色 | 描述 | 核心需求 |
|------|------|----------|
| 教师 / 内容创建者 | 创建维护题库、编辑试题、导入文档 | 题库 CRUD、批量导入、媒体管理、题组编排 |
| 学生 / 练习者 | 通过题库进行练习或考试 | 练习/考试会话、自动判分、答题反馈、学习统计 |
| 管理员 | 管理系统用户、知识点体系 | 用户管理、知识树维护、系统概览 |
| 访客 | 未登录浏览者 | 定价页可见 |

## 3. 核心功能

### F1: 用户认证与管理

| 功能 | 需求 |
|------|------|
| F1.1 注册 | 用户名/邮箱/密码注册，bcrypt 哈希存储 |
| F1.2 登录 | 用户名或邮箱 + 密码，HMAC 签名 session cookie |
| F1.3 登出 | Redis 撤销 JTI，清除 cookie |
| F1.4 个人信息 | 查看/更新用户名、邮箱、密码 |
| F1.5 会员体系 | free / plus / enterprise 三级；plus 含 3 天试用期 |
| F1.6 管理员操作 | 停用/启用用户，修改角色与会员等级 |

### F2: 题库管理

| 功能 | 需求 |
|------|------|
| F2.1 题库 CRUD | 按学科创建、编辑、删除题库（公开/私有） |
| F2.2 题库列表 | 我的/收藏/公开 三个维度的题库列表，支持筛选排序 |
| F2.3 题库收藏 | 用户收藏/取消收藏题库 |
| F2.4 权限模型 | 所有者可编辑/删除；公开题库所有活跃用户可读 |

### F3: 试题管理

| 功能 | 需求 |
|------|------|
| F3.1 题型支持 | 选择题（单选/多选）、判断题、填空题、简答题 |
| F3.2 试题 CRUD | 维护题干、解析、答案、选项、内容块 |
| F3.3 题组（Group） | 组合题支持（如阅读理解、实验题），题内多子题 |
| F3.4 科目与知识点 | 试题挂载学科、知识点体系、题型分类 |
| F3.5 状态生命周期 | draft → active → archived 三态流转，发布前校验答案完整性 |
| F3.6 富内容 | 支持文本、公式、图片、表格、Markdown、HTML、图表、QR 码 |
| F3.7 版本化答案 | 多版本答案 keys，仅一个 primary 用于判分 |

### F4: 批量导入

| 功能 | 需求 |
|------|------|
| F4.1 文件上传 | 支持 TXT、DOCX 源文件上传 |
| F4.2 AI 解析 | Python 服务通过 OpenAI 兼容 API 解析文档为结构化试题 |
| F4.3 本地解析 | 无 AI 配置时走确定性 fallback 解析 |
| F4.4 进度与事件 | PostgreSQL 持久化事件，Web/移动端轮询任务与事件接口 |
| F4.5 产物管理 | 追踪导入产出的试题及其 confidence、review 标记 |
| F4.6 重试与取消 | 失败任务可重试（指数退避），可取消进行中的任务 |
| F4.7 DOCX 智能提取 | 公式、表格、图表元数据、化学符号等提示提取 |

### F5: 练习与会话

| 功能 | 需求 |
|------|------|
| F5.1 启动会话 | 支持四种模式：全部练习、错题重练、按题型、考试模式 |
| F5.2 答题导航 | 题号侧边栏，支持跳转，标记已答/未答 |
| F5.3 自动判分 | 选择/判断/填空即时判分，简答输出参考答案 |
| F5.4 答题反馈 | 正确/错误结果，解析、得分、下一题引导 |
| F5.5 会话完结 | 完成/放弃会话，统计答卷数、正确/错误数、得分 |
| F5.6 结果查看 | 详细结果页含各题答案校对与解析 |

### F6: 学习分析

| 功能 | 需求 |
|------|------|
| F6.1 用户概览 | 练习量、正确率趋势、薄弱知识点、活跃题库 |
| F6.2 题库分析 | 每题库练习统计、排行榜 |
| F6.3 导入质量 | 导入任务的质量评分、风险统计 |
| F6.4 AI 学习报告 | 高级会员可生成学习报告（掌握度、薄弱点、建议） |

### F7: 媒体管理

| 功能 | 需求 |
|------|------|
| F7.1 上传 | 当前支持 PNG/JPEG/GIF/WebP 图片上传（最大 10 MiB） |
| F7.2 关联 | 媒体可链接至试题、选项、题组，支持排序 |
| F7.3 内容块 | 结构化内容块编排，支持多渲染格式（LaTeX, MathML, HTML, Markdown） |

### F8: 搜索

| 功能 | 需求 |
|------|------|
| F8.1 题库搜索 | 按名称、学科、可见性检索 |
| F8.2 试题搜索 | 基于 stem 的全文本搜索（PostgreSQL tsvector + 拼音/trigram） |
| F8.3 知识点搜索 | 按名称或学科检索知识树节点 |

### F9: 移动端与离线

| 功能 | 需求 |
|------|------|
| F9.1 多端数据 | Web 与移动端共用 PostgreSQL 权威数据 |
| F9.2 离线读取 | 移动端缓存最近访问的题库、试题、练习与分析 |
| F9.3 离线写入 | 待同步操作按创建顺序重放，并使用幂等键去重 |
| F9.4 离线练习 | 缓存题库可完成离线练习，联网后一次性上传 |
| F9.5 冲突规则 | 服务端按请求接收顺序处理，后到写入覆盖先到写入 |

## 4. 页面与路由

### 公开页
| 路由 | 页面 | 状态 |
|------|------|------|
| `/sign-in` | 登录 | 已实现 |
| `/sign-up` | 注册 | 已实现 |
| `/pricing` | 定价页 | 占位 |
| `/` | 重定向到 /dashboard | 已实现 |

### 受保护页（需登录）
| 路由 | 页面 | 状态 |
|------|------|------|
| `/dashboard` | 仪表板概览 | 已实现 |
| `/banks` | 题库列表 | 已实现 |
| `/banks/new` | 创建题库 | 已实现 |
| `/banks/:bankId` | 题库详情 | 已实现 |
| `/banks/:bankId/manage` | 题库管理（题目编辑） | 已实现 |
| `/banks/:bankId/practice` | 练习配置 | 已实现 |
| `/practice/:sessionId` | 正在练习 | 已实现 |
| `/imports` | 导入任务列表 | 已实现 |
| `/imports/:jobId` | 导入详情 | 已实现 |
| `/questions/:questionId` | 题目详情 | 已实现 |
| `/settings` | 用户设置 | 已实现 |

### 管理员页
| 路由 | 页面 | 状态 |
|------|------|------|
| `/admin` | 管理后台概览 | 已实现 |
| `/admin/users` | 用户管理 | 已实现 |
| `/admin/knowledge-points` | 知识点管理 | 已实现 |

## 5. 非功能需求

| 属性 | 要求 |
|------|------|
| NFR1 性能 | 游标分页；题库/题目列表响应 < 200ms |
| NFR2 缓存 | Redis cache-aside 用户资料、题目队列、分析摘要 |
| NFR3 实时性 | 导入进度通过持久化事件轮询展示；Redis Pub/Sub 仅作内部可选通知 |
| NFR4 可用性 | SQL + Redis 双依赖健康检查 `/api/health` |
| NFR5 安全 | HMAC session 签名、bcrypt 密码、CSRF SameOrigin 保护、速率限制 |
| NFR6 可扩展 | 导入 worker 独立进程，PostgreSQL `FOR UPDATE SKIP LOCKED` 任务竞争 |
| NFR7 持久化 | PostgreSQL 为唯一权威存储；Redis 故障时普通读取降级至 SQL，幂等写入失败关闭 |
| NFR8 国际化 | 前端保留 i18n 架构潜力，当前内容以中文为主 |
| NFR9 离线同步 | 移动端 SQLite 缓存与 outbox；幂等重放避免响应丢失造成重复写入 |

## 6. 技术架构

```
Browser (React + Vite) ─┐
PractiQ (Expo / RN) ────┴─ HTTP / JSON
                         ▼
Go API (net/http, pgxpool, go-redis)
        │              │
        ├── PostgreSQL ─┤ (schema: backend/db/*/*.sql)
        │              │
        ├── Redis ─────┤ (session, cache, rate-limit, idempotency)
        │
        ├── Serve SPA (frontend/dist)
        │
        └── Python AI service (FastAPI + Mammoth + OpenAI-compatible)
                ├── POST /internal/ai/parse-document
                ├── POST /internal/ai/generate-answer
                └── POST /internal/ai/learning-report
```

### 数据流关键路径

- **练习答题**: 提交 → 加载答案 key → 判分 → 写入 `user_question_answers` → 触发器更新 `user_question_stats` / `user_bank_stats` / session 计数器
- **文档导入**: 上传 → 创建 job(queued) → 存储 artifact → worker 用 `FOR UPDATE SKIP LOCKED` 领取 → 调用 AI 解析 → 写入试题与组合题 → 客户端轮询持久化事件
- **登录**: POST 凭证 → 验证密码 → 生成 HMAC session token（含 JTI）→ 设置 cookie → Redis 记录活跃

## 7. 数据模型要点

| 领域 | 核心表 |
|------|--------|
| 用户 | `users`（role, membership, bcrypt hash） |
| 分类 | `subjects`, `question_types`, `knowledge_points` |
| 题库 | `question_banks`, `user_bank_links`, `bank_question_links`, `bank_group_links` |
| 试题 | `questions`, `question_options`, `question_answer_keys`（版本化）, `question_groups`, `group_question_links` |
| 内容 | `question_content_blocks`（多态富内容）, `media_assets` + 关联表 |
| 导入 | `question_import_jobs`, `artifacts`, `events`, `outputs` |
| 练习 | `user_practice_sessions`, `user_question_answers`, `user_question_stats` |

## 8. 当前开发阶段

- **已实现**: 认证登录/注册、后端全部 REST API（参考、题库、试题、练习、导入、媒体、分析、搜索、AI、管理）、Web 核心学习页面与管理员页面、PractiQ Android/iOS 客户端、移动端离线缓存/outbox、数据层（7 个 SQL schema + 触发器）、AI 文档解析服务、导入 worker
- **待完成 - 功能**: 计费/结账的 webhook 未激活、未配置模型供应商时 AI 功能仍使用确定性 fallback、study-groups schema 目录预留未填充

## 9. 路线图

| 阶段 | 内容 |
|------|------|
| Phase 1 | Web 与移动端核心页面开发（已完成） |
| Phase 2 | 计费集成、会员权益实现 |
| Phase 3 | AI 全面接入（generate-answer 和 learning-report agent 集成） |
| Phase 4 | 国际化、学习小组（study-groups）、更多题型扩展 |
| Phase 5 | 协作功能与更细粒度的跨设备冲突提示 |
