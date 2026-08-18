# PractiQ PRD

## 1. Product Overview

PractiQ 是一个面向教师、学习者和教育机构的题库管理与智能练习平台。用户可创建和管理学科题库、手动或 AI 批量导入试题、组织练习与考试会话，并获取多维度的学习分析报告。当前产品由 Taro 微信小程序前端基线、Java 产品 API 与内部 Python AI 服务组成；Java 承载 REST API、认证和产品数据，Python 仅承载 AI 文档处理。前端业务流程正按 `docs/taro-migration.md` 恢复。

## 2. 目标用户

| 角色 | 描述 | 核心需求 |
| ------ | ------ | ---------- |
| 教师 / 内容创建者 | 创建维护题库、编辑试题、导入文档 | 题库 CRUD、批量导入、媒体管理、题组编排 |
| 学生 / 练习者 | 通过题库进行练习或考试 | 练习/考试会话、自动判分、答题反馈、学习统计 |
| 管理员 | 管理系统用户、知识点体系 | 用户管理、知识树维护、系统概览 |

## 3. 核心功能

### F1: 用户认证与管理

| 功能 | 需求 |
| ------ | ------ |
| F1.1 注册 | 用户名、邮箱、密码和单次邮箱验证码注册，bcrypt 哈希存储 |
| F1.2 登录 | 用户名或邮箱 + 密码，签发短效 access JWT 和轮换 refresh token |
| F1.3 登出 | 撤销 PostgreSQL 设备会话并清除 cookie 或小程序令牌 |
| F1.4 个人信息 | 查看/更新用户名、邮箱、密码 |
| F1.5 会员体系 | RevenueCat 管理 free / pro / organization 三级，新用户享 3 天 Pro 试用；pro 免广告、可用自有 Key 调用云端 AI、可下载公共题库；organization 另含学习小组（详见 docs/membership-design.md） |
| F1.6 管理员操作 | 停用/启用用户与修改系统角色；系统角色不绕过付费权益 |

### F2: 题库管理

| 功能 | 需求 |
| ------ | ------ |
| F2.1 题库 CRUD | 按学科创建、编辑、删除题库（公开/私有） |
| F2.2 题库列表 | 我的/收藏/公开 三个维度的题库列表，支持筛选排序 |
| F2.3 题库收藏 | 用户收藏/取消收藏题库 |
| F2.4 权限模型 | 所有者可编辑/删除；公开题库所有活跃用户可读 |
| F2.5 公共题库下载 | PRO 会员可将公开题库克隆为我的私有题库副本（`POST /api/v1/banks/{bankId}/clone`） |

### F3: 试题管理

| 功能 | 需求 |
| ------ | ------ |
| F3.1 题型支持 | 选择题（单选/多选）、判断题、填空题、简答题 |
| F3.2 试题 CRUD | 维护题干、解析、答案、选项、内容块 |
| F3.3 题组（Group） | 组合题支持（如阅读理解、实验题），题内多子题 |
| F3.4 科目与知识点 | 试题挂载学科、知识点体系、题型分类 |
| F3.5 状态生命周期 | draft → active → archived 三态流转，发布前校验答案完整性 |
| F3.6 富内容 | 支持文本、公式、图片、表格、Markdown、HTML、图表、QR 码 |
| F3.7 版本化答案 | 多版本答案 keys，仅一个 primary 用于判分 |

### F4: 批量导入

| 功能 | 需求 |
| ------ | ------ |
| F4.1 文件上传 | 支持 TXT、DOCX、PDF、XLSX 源文件上传 |
| F4.2 AI 解析 | PRO 用户使用自有 DashScope、DeepSeek 或 Moonshot Key，通过 LangGraph 将文档解析为结构化试题 |
| F4.3 未配置降级 | FREE 或未配置 Key 时明确拒绝，不产出占位数据 |
| F4.4 进度与事件 | PostgreSQL 持久化事件，客户端通过认证 SSE 实时接收并以轮询降级 |
| F4.5 产物管理 | 追踪导入产出的试题及其 confidence、review 标记 |
| F4.6 重试与取消 | AI 阶段失败任务可断点重试（指数退避），进入数据库持久化前可取消 |
| F4.7 DOCX 智能提取 | 公式、表格、图表元数据、化学符号等提示提取 |

### F5: 练习与会话

| 功能 | 需求 |
| ------ | ------ |
| F5.1 启动会话 | 支持四种模式：全部练习、错题重练、按题型、考试模式 |
| F5.2 答题导航 | 题号侧边栏，支持跳转，标记已答/未答 |
| F5.3 自动判分 | 选择/判断/填空即时判分，简答输出参考答案 |
| F5.4 答题反馈 | 正确/错误结果，解析、得分、下一题引导 |
| F5.5 会话完结 | 完成/放弃会话，统计答卷数、正确/错误数、得分 |
| F5.6 结果查看 | 详细结果页含各题答案校对与解析 |

### F6: 学习分析

| 功能 | 需求 |
| ------ | ------ |
| F6.1 用户概览 | 练习量、正确率趋势、薄弱知识点、活跃题库 |
| F6.2 题库分析 | 每题库练习统计、排行榜 |
| F6.3 导入质量 | 导入任务的质量评分、风险统计 |
| F6.4 AI 学习报告 | PRO 用户可生成学习报告（掌握度、薄弱点、建议） |

### F7: 媒体管理

| 功能 | 需求 |
| ------ | ------ |
| F7.1 上传 | 当前支持 PNG/JPEG/GIF/WebP 图片上传（最大 10 MiB） |
| F7.2 关联 | 媒体可链接至试题、选项、题组，支持排序 |
| F7.3 内容块 | 结构化内容块编排，支持多渲染格式（LaTeX, MathML, HTML, Markdown） |

### F8: 搜索

| 功能 | 需求 |
| ------ | ------ |
| F8.1 题库搜索 | 按名称、学科、可见性检索 |
| F8.2 试题搜索 | 基于 stem 的全文本搜索（PostgreSQL tsvector + ILIKE 回退） |
| F8.3 知识点搜索 | 按名称或学科检索知识树节点 |

### F9: 微信小程序与离线

| 功能 | 需求 |
| ------ | ------ |
| F9.1 权威数据 | 小程序缓存与离线操作最终同步到 PostgreSQL 权威数据 |
| F9.2 离线读取 | 小程序缓存最近访问的题库、试题、练习与分析 |
| F9.3 离线写入 | 待同步操作按创建顺序重放，并使用幂等键去重 |
| F9.4 离线练习 | 缓存题库可完成离线练习，联网后一次性上传 |
| F9.5 冲突规则 | 服务端按请求接收顺序处理，后到写入覆盖先到写入 |

### F10: 学习小组

| 功能 | 需求 |
| ------ | ------ |
| F10.1 创建小组 | organization 会员创建学习小组并成为 owner |
| F10.2 成员管理 | owner 按用户名添加/移除小组成员 |
| F10.3 关联题库 | owner 关联/解关联自己拥有的多个题库 |
| F10.4 成员学情 | owner 查看任一成员的学情快照 |
| F10.5 小组题库 | 小组成员获得关联题库的只读权限（视同公开题库） |

## 4. Taro 目标页面与路由

### 公开页面

| 路由 | 页面 | 状态 |
|------|------|------|
| `/sign-in` | 登录与注册 | 待迁移 |

### 受保护页面

| 路由 | 页面 | 状态 |
| ------ | ------ | ------ |
| `/` | 学习概览 | 待迁移 |
| `/banks` | 我的、收藏和公开题库 | 待迁移 |
| `/analytics` | 学习分析 | 待迁移 |
| `/settings` | 账号、会员、同步与语言设置 | 待迁移 |
| `/banks/new` | 创建题库 | 待迁移 |
| `/banks/:bankId` | 题库详情 | 待迁移 |
| `/banks/:bankId/manage` | 题库与题目管理 | 待迁移 |
| `/banks/:bankId/practice` | 练习配置 | 待迁移 |
| `/practice/:sessionId` | 在线或离线练习 | 待迁移 |
| `/imports` | 导入任务列表 | 待迁移 |
| `/imports/:jobId` | 导入详情 | 待迁移 |
| `/questions/:questionId` | 题目详情 | 待迁移 |
| `/search` | 题目搜索 | 待迁移 |
| `/settings/ai` | LLM 配置 | 待迁移 |
| `/settings/data` | 本地数据设置 | 待迁移 |
| `/privacy` | 隐私政策 | 待迁移 |

## 5. 非功能需求

| 属性 | 要求 |
| ------ | ------ |
| NFR1 性能 | 游标分页；题库/题目列表响应 < 200ms |
| NFR2 缓存 | Redis cache-aside 用户资料、题目队列、分析摘要 |
| NFR3 实时性 | 导入进度通过 PostgreSQL 持久事件和认证 SSE 展示，断线后按事件 ID 续传并可降级轮询 |
| NFR4 可用性 | SQL + Redis 双依赖健康检查 `/api/health` |
| NFR5 安全 | 短效 HMAC access JWT、轮换 refresh token、bcrypt 密码、CSRF SameOrigin 保护、速率限制 |
| NFR6 可扩展 | Java 产品 API 编排可重试的导入与私有 AI 服务调用 |
| NFR7 持久化 | PostgreSQL 为唯一权威存储；Redis 故障时普通读取降级至 SQL，幂等写入失败关闭 |
| NFR8 国际化 | Taro 客户端目标支持 English、简体中文、繁體中文和日本語回退 |
| NFR9 离线同步 | 计划按平台恢复缓存与 outbox；幂等重放避免响应丢失造成重复写入 |

## 6. 技术架构

```
PractiQ (Taro WeChat Mini Program) ── HTTP / JSON
                          ▼
Java product API; the private Python FastAPI/LangGraph AI integration is pending
        │              │
        ├── PostgreSQL ─┤ (schema: db/*/*.sql)
        │              │
        ├── Redis ─────┤ (email codes, cache, rate-limit, idempotency)
        │
        └── Internal AI service (LangGraph + DashScope/DeepSeek/Moonshot, pending Java integration)
                ├── POST /api/v1/ai/parse-document
                ├── POST /api/v1/ai/generate-answer
                └── POST /api/v1/ai/learning-report
```

### 数据流关键路径

- **练习答题**: 提交 → 加载答案 key → 判分 → 写入 `user_question_answers` → 触发器更新 `user_question_stats` / `user_bank_stats` / session 计数器
- **文档导入**: 上传 → Java 创建任务与存储 artifact → Java 编排 AI 服务调用并写入试题与组合题 → 客户端接收产品 API 状态
- **登录**: POST 凭证 → 验证密码 → 创建 PostgreSQL device session 和 refresh-token hash → 返回 10 分钟 access JWT 与单次 refresh token

## 7. 数据模型要点

| 领域 | 核心表 |
| ------ | -------- |
| 用户 | `users`（role, membership, bcrypt hash）与 `auth_sessions`/`refresh_tokens`（设备会话、轮换 refresh hash） |
| 分类 | `subjects`, `question_types`, `knowledge_points` |
| 题库 | `question_banks`, `user_bank_links`, `bank_question_links`, `bank_group_links` |
| 试题 | `questions`, `question_options`, `question_answer_keys`（版本化）, `question_groups`, `group_question_links` |
| 内容 | `question_content_blocks`（多态富内容）, `media_assets` + 关联表 |
| 导入 | `question_import_jobs`, `artifacts`, `events`, `outputs` |
| 练习 | `user_practice_sessions`, `user_question_answers`, `user_question_stats` |
| 学习小组 | `study_groups`, `study_group_members`, `study_group_banks` |

## 8. 当前开发阶段

- **已实现**: Java 产品 API、题库和试题 REST API、练习、导入、媒体、分析、搜索、SQL schema 与会员/学习小组能力；Python AI 服务保留文档解析与生成工作流，Java 客户端集成待完成
- **前端现状**: Taro 微信小程序编译与运行基线已建立；业务页面、认证、离线缓存/outbox 和购买待迁移。仓库不包含其他前端。

## 9. 后续重点

| 优先级 | 内容 |
| ------ | ------ |
| P0 | 恢复认证、概览、题库、题目与练习主链路 |
| P1 | 恢复题库管理、搜索、分析、导入与媒体 |
| P2 | 恢复离线同步、微信支付与小程序登录 |
| P3 | 为学习小组补充客户端页面 |
| P4 | 实现管理员入口、生产级版本化迁移与冲突提示 |
