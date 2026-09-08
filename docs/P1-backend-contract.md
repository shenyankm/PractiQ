# 第一优先级后端安全契约

后端范围为答案隐藏、当前内容权限与在线写入幂等；小程序安全接入与仍待平台验收的限制见 [P1 前端安全说明](P1-frontend-security.md)。支付订单的 30 分钟缓存和按商户单号永久履约语义不变。

## 学习读取与管理读取

- `GET /api/v1/questions/{questionId}` 是无会话学习读取：包括 owner 在内，不返回 `answer_keys`，`analysis` 为 null/省略。列表、题库 items（即使 `includeAnswers=true`）、题组子题与搜索也不披露答案/解析。
- 新增 `GET /api/v1/questions/{questionId}/management`：独立验证题目 owner，返回题目字段、完整 `analysis`、`options`、`content_blocks`、按版本排序的全部 `answer_keys`（包括 `answer_payload`、`explanation_payload`、`is_primary`）。现有编辑写入路由不变，发布/归档响应使用管理读取。
- 会话学习使用现有 `/practice-sessions/{id}/questions`、`question-page`、`answers`、`results`。all/wrong/by_type 提交该题后解锁；exam 只有 `status=completed` 解锁，active 和 abandoned 的提交、重复提交、导航进度、会话列表/汇总及结果均隐藏参考答案、解析、正确性及评分。原始作答和已答数量仍可见。
- 隐藏字段可能为 null 或被当前 Jackson 配置省略；客户端不能将隐藏评分当作 0 分/答错。

## 即时撤权

- 显式 bank/session 上下文必须仍可访问该 bank。旧会话的任一入队题目失去当前 active 题目/题库关联/题组路径时，整个会话入口返回 404；不能借另一个可访问题库继续读取原会话。
- 退出、移除、解除小组题库关联、封禁、软删除及归档后，旧会话读写、收藏列表、薄弱题目、搜索、媒体和相关分析重新检查当前权限。薄弱题目增加 `bank_id`，供客户端定向清理。
- 独立 question/group/media 路径可沿另一个合法未封禁题库授权；仅关联 banned/deleted 题库的资源不允许 owner 绕过。owner 的未关联草稿仍可管理。题库 owner 无权解禁；管理员专用状态路由不变。
- 敏感 API 和媒体内容使用 `Cache-Control: no-store`，禁止依赖浏览器/网络层缓存绕过在线鉴权。
- AI 结果仅修权限旁路：Java `ai_tasks.source_question_id` 保存答案任务来源；`ai_report_sources` 保存报告实际作答证据的 `(bank_id,question_id)` 来源。它们不进入 Python DTO。保留来源 ID 而不随源资源删除置空，缺失/撤权来源或旧无来源敏感结果一律拒绝。报告统计不包含未完成/放弃考试及不可访问内容；导入读取与 SSE 每轮重新鉴权。本轮不改 AI 计费、模型或文件生命周期。

## 一般写入重试

- 普通 POST/PUT/PATCH/DELETE 必须携带 1–128 字符稳定 `Idempotency-Key`；包括资料修改、内容修改、答题、媒体和小组写入。
- 入口在所有路径策略（含认证/支付豁免）及 MVC 匹配前拒绝非规范 URI，返回 `400 INVALID_PATH`，不接纳幂等记录：不允许 matrix 分号、反斜线、重复斜线、点路径段、控制字符及编码 ASCII 路径字符（包括 `%3B`、`%2F`、`%31`、`%25`）。现有 ASCII 路径参数仅为数字 ID、固定动作和 URL-safe 邀请 token；正常 UTF-8 非 ASCII 路径段编码仍可通过，query 编码原样保留。过滤器、幂等身份及回放授权因此共用无别名的路径，不在一处自行解码后让其他位置继续判断原始路径。
- PostgreSQL 已有 `request_idempotency` 表为唯一权威：以 user ID、HTTP method + path、key 为身份，接纳时即持久绑定请求指纹 24 小时；成功结果和确定业务 4xx 返回原结果，key 到期后可重新执行。JSON/普通请求要求原始 body、Content-Type、query 保持一致；multipart 按有序逻辑 part 的名称、文件名、MIME 与内容哈希比较，不受随机 boundary 影响；保留 Servlet part 顺序，不按名称/文件名重排，同名 `file` 换序也返回 409（单文件业务绑定取首个文件）。
- 每次回放前重新校验有效 access session、active 用户及当前资源权限。令牌轮换不改变幂等身份。成功删除/退组的原始空 204 可在有效用户鉴权后回放，不重新执行业务；其他撤权响应不会返回旧内容。
- 同 key 不同请求返回 `409 IDEMPOTENCY_KEY_REUSED`；并发处理中返回 `409 REQUEST_IN_PROGRESS`。Redis 故障返回 `503 IDEMPOTENCY_UNAVAILABLE`，不能换 key 绕过重试。
- 先用短 PostgreSQL 事务提交请求指纹占位，再以无 TTL 的事务级锁串行协调独立业务事务；业务修改和成功响应记录处于同一 Spring 事务，提交（包括延迟约束检查）成功前不发送响应。确定业务 4xx 在业务回滚后、仍持有协调锁时保存；5xx/事务失败仅保留指纹，允许同 body 同 key 恢复，不可换 body。进程中断后占位可重试；成功业务不会存在已提交但响应记录未提交的窗口。执行业务期间需要两条数据库连接；下面的单例接纳闸门在取得任何占位/协调连接前限制并发，避免协调者占满同一个池再相互等待业务连接。
- 接纳前鉴权/当前资源授权失败、缺失/非法 key、请求超限/无法完整读取、依赖故障不建立记录；之后仍每次重新鉴权。已接纳后的权限变化保留指纹但不缓存 401/403 为终态结果；业务 404（例如已完成会话重复完结）不能丢弃已绑定 key。Redis 仅作为必要依赖可用性门禁，不存权威响应、不使用短锁模拟严格幂等。
- 微信登录、refresh、logout 属于一次性认证协议，不套普通 24 小时缓存。支付创建、退款及微信通知继续专用持久化幂等流程，不套此缓存。

## 双连接接纳与失败恢复

- `IdempotencyAdmission` 是绑定应用实际 Hikari DataSource 的 Spring 单例，所有 `IdempotentWrites.execute` 共享它。在任何占位/协调事务前 `tryAcquire`，上限由启动时实际 `maximumPoolSize / 2` 向下取整派生，没有另一套手工并发参数。默认池 10 条连接意味着最多 5 个协调写入；池小于 2、未明确配置 Hikari 最大容量或无有限获取超时会启动失败。
- 闸门满立即 503，不插入新占位、不修改已有记录；任何异常、回滚、获取连接超时都经 finally 释放。拒绝在已有事务中进入协调写入，且同线程重复进入不会重复占许可。实际池运行中变更容量会拒绝新写入，改池大小需重启；不可绕过单例闸门手工构造生产协调服务。
- PostgreSQL 事务级锁仍负责跨实例同 key 一致性，不由 Semaphore 替代。业务和协调事务设置 5 秒 DB lock_timeout，Hikari 连接获取默认最多 30 秒；已有/外部事务暂占连接时可失败，已接纳指纹保持，依赖恢复后同 key/body 重试。这里保证没有本服务协调者自致的同池饥饿，不声称其他 DB 竞争无等待或所有语句有端到端延迟保证。
- `IdempotencyPoolSchemaTest` 用真实 Hikari 最大容量 2、连接超时 500ms 检查不同 key/相同 key 竞争、池内等待者为 0、拒绝时记录未改变、异常释放及原 key 恢复；另一个事务占用连接时有界失败后仍能恢复。需要超出半池写入吞吐时，应经专门设计/故障测试调整事务结构，而不是移除闸门或无限放大超时。

## 客户端接入契约

1. 编辑页改用 `/questions/{id}/management`；练习页只用会话 API，不能再通过 owner/includeAnswers 读取学习答案。
2. 写入请求创建一次 key，网络/令牌刷新/409 in-progress/503 重试沿用相同 key 与 body；真正的新用户操作生成新 key。
3. 未联网不展示非本人缓存；403/404 或成员变更立即按 bank 清除题目、媒体、分析和会话缓存；登录退出/换号清除全部用户业务缓存。
4. 处理 exam abandoned 永不解锁、隐藏评分字段及薄弱题目 `bank_id`。服务端 no-store 不替代应用缓存清理。

### 前端接入前的调用方交接记录（历史）

以下记录保留后端恢复时发现的问题，不再代表当前前端实现；稳定 key、management 读取、缓存删除与页面安全边界已接入，当前实现/限制以 [前端安全说明](P1-frontend-security.md) 为准。

`Taro` API 包装集中在 `taro/src/api/modules.ts`。当前 `mutation(..., true)` 每次调用重新生成 key，普通 `mutation(...)`、`replaceTags` 及 `upload()` 还没有 key；因此不能只修某一个答题按钮。

| 调用方 | 需要稳定 key 的方法 |
| --- | --- |
| `auth` | `updateProfile` |
| `banks` | `create/update/remove/favorite/clone/replaceTags/createSubset/updateSubset/removeSubset/resetPractice` |
| `questions` | `create/update/remove/publish/archive/answerKey/aiAnswer/contentBlocks` |
| `media` | `upload/linkQuestion/remove` |
| `practice` | `start/answer/complete/abandon` |
| `imports` | `create/action`（parse/retry/cancel）、`upload` |
| `analytics`、`aiTasks` | `report`、`cancel` |
| `groups` | `create/update/remove/invite/respond/leave/removeMember/linkBank` |
| `admin` | `updateUser/banBank/knowledgeCreate/knowledgeUpdate/knowledgeDelete/knowledgeImport` |

- `payments.create` 也需保留同一次尝试的 key，但继续遵循支付 30 分钟专用协议；`payments.refund`、login/refresh/logout 不套普通 24 小时结果策略。今后新增题组选项等写入包装也须遵守后端通用 key 检查。
- `taro/src/api/client.ts` 的 `requestEnvelope` 在 refresh 后复用同一 options，已有自动刷新重试可保留传入 key；用户手动重试/网络恢复不能重新调用包装后生成新 key。`modules.ts` 的 `upload()` 直接走 `Taro.uploadFile`，是绕开普通 transport 的独立补齐点，覆盖媒体、导入文件、管理员 CSV 三个调用方。
- `taro/src/packages/content/questions/edit/index.tsx` 当前调用 `api.questions.get`，应切换新的 owner management 包装；`questions/detail/index.tsx` 的无会话读取继续保持学习接口，不能一起切成管理读取。
- 会话页 `packages/practice/session/index.tsx`、结果页 `packages/practice/results/index.tsx` 需处理隐藏评分/解析、abandoned 不解锁及旧会话 404；题库 items/search 的 `includeAnswers` 不再作为可见性开关。
- 缓存入口是 `taro/src/cache/index.ts` 和 `keys.ts`；目前 `cachedForUser` 会先展示命中的缓存，只在实际 loader 报错后删除单 key。唯一已接入持久业务缓存的读取方是 `pages/home/index.tsx` 的 `analytics:me`，其中包含非本人题库题干，不能离线/未复检就展示。`packages/tools/settings/storage/index.tsx` 只有手动全用户清理入口。
- 退出/换号/refresh 失败/第二次 401：`api/client.ts` 的 `loginWithCode`、`invalidateSession`、`logout`，`auth/session.ts` 的 `replace/clear` 和 `api/index.ts` 的 `onUnauthenticated` 都需参与统一清理顺序；保留旧 user ID 到清理完成，并阻止在途请求在换号后回填旧缓存/页面状态。
- 403/404/成员退出移除/题库解绑封禁：除 storage 外，也清 `pages/home`、`pages/banks`、`packages/content/banks/detail`、`packages/content/questions/detail`、`packages/practice/session/results`、`packages/tools/analytics`、`packages/tools/search`、`packages/groups/detail` 等已加载内容及媒体/分析派生状态。按 bank 关联清除；无法可靠追溯 bank 的合并首页分析必须整体失效，而不是保留旧题干。当前这些页面即使没有落盘，也不能在错误时继续展示旧 React state。

## 验证与部署边界

- `env -u POSTGRES_URL make backend-test` 不连接用户数据库。
- `make schema-check` 与 `make api-schema-smoke` 只创建并删除各自一次性 PostgreSQL 16 容器；后者设置 `PRACTIQ_DISPOSABLE_DB=true` 运行 `P1HttpSchemaTest`，包括真实 JDBC、HTTP、Spring 事务代理、鉴权、回放、并发、回滚和权限矩阵。支付/微信/模型均不调用真实外部服务。
- 已有库升级使用 [db/migrations/README.md](../db/migrations/README.md) 和 `002_p1_result_provenance.sql`，沿用 001 的显式事务/条件 DDL/替换函数惯例，停止流量、确认目标和备份后由操作者执行；不清库、不自动接触用户数据库。002 可重复执行，旧数据不变、旧来源不猜测回填，旧敏感结果失败关闭。隔离脚本验证升级前旧数据、重复升级、来源不可变及升级后读取拒绝；新库继续使用权威 `db/00_schema.sql`。
- 小程序已加入行为回归，但未验证真实网络集成、生产负载或微信真机；文件系统副作用的恢复/清理仍属于未授权的文件生命周期阶段。
