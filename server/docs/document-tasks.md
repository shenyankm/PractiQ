# 创建、控制和复核文档任务

本文说明文档任务的创建、轮询、暂停、恢复与人工审核。三个 Graph 共用 LangGraph 检查点（checkpoint）、Store 和 SQLite 持久队列。主观题评分使用独立接口，见[评分接入说明](service-guide.md#主动请求主观题评分)。

## 创建与查询

先通过[鉴权上传接口](service-guide.md#导入流程)获得 `document` 引用，再提交。以下示意省略了引用字段；发送前将 `document` 字符串替换为上传返回的完整对象：

```json
{
  "requestId": "11111111-1111-4111-8111-111111111111",
  "graphId": "document_parser",
  "document": "替换为上传返回的完整引用对象",
  "failurePolicy": "return_partial"
}
```

`POST /api/document-tasks` 返回 HTTP 202，字段为 `threadId`、`runId`、`requestId`、`accepted`。202 表示已持久入队，不代表解析完成。所有业务接口要求 `Authorization: Bearer your_service_token_here`，令牌取自 `AI_SERVICE_TOKEN`。

`graphId` 可选 `document_parser`（默认，全部格式）、`text_csv_parser`、`pdf_parser`。可选 `parentThreadId` 仅关联已存在的新运行时任务，不覆盖父任务。未知字段、原始 state、URL、Base64、服务器文件路径和用户提交的模型结果均拒绝。

`GET /api/document-tasks/{threadId}` 返回 `state`、`phase`、`progress`、`failures`、`blocking`、`allowedActions`、`checkpointId`、`expiresAt`、`updatedAt`、`status`、`result`、`processing`、`usage`、`unknownUsageCalls` 和 `modelBudget`。初始无 checkpoint 时返回不透明的 `pending:<runId>` 令牌，仅用于该任务控制，不是 LangGraph checkpoint。调用方不得解析或构造令牌。

按 `state` 和 `allowedActions` 选择操作：

| state | 可用控制 |
|---|---|
| PENDING / RUNNING | pause、interrupt，携带目标 runId |
| PAUSING | interrupt |
| PAUSED / INTERRUPTED | resume，携带最新 checkpointId |
| WAITING_REVIEW | 按 allowedActions 选择 retry_failed / accept_partial |
| FAILED | 未完成节点可 resume，符合条件的失败单元可 retry_failed |
| COMPLETED | PARTIAL 中可补跑的失败单元允许 retry_failed |

状态与质量独立：`COMPLETED` 可以对应 `PARTIAL`；`SUCCEEDED` 也可能需要内容复核。进度只查询已持久保存的数据，客户端使用 GET 轮询，不再调用原生 SSE、线程、运行或 Store 接口。

## 控制与幂等

向 `POST /api/document-tasks/{threadId}/control` 提交控制请求，例如恢复任务：

```json
{
  "requestId": "22222222-2222-4222-8222-222222222222",
  "action": "resume",
  "checkpointId": "从最近一次 GET 原样取得"
}
```

每个变更使用 UUID `requestId`。同一请求重放（包括并发提交）返回原回执，即使该请求已启动运行或推进 checkpoint；同 ID 不同内容返回 `REQUEST_CONFLICT`。旧 run 返回 `STALE_RUN`，旧 checkpoint 返回 `STALE_CHECKPOINT`，任务仍忙返回 `TASK_BUSY`。请求受理与实际停止分开查询。

`pause` 为协作暂停：已派发转换/模型调用可能先完成，后续批次停止。`interrupt` 先保存取消意图，再取消执行，不保证撤回远端模型请求或终止底层同步线程。立即中断产生的未知调用保留。

`retry_failed` 可以省略 `units` 或传 `[]`，表示所有仍可补跑单元；也可传 `[{"stage":"vision_parse","index":1}]`。索引从零开始；stage 为 `vision_parse`、`vision_describe` 或 `document_parse`。每单元最多两轮额外补跑，剩余次数见 `retriesRemaining`；成功单元不重算。耗尽、输入超限、转换准备失败、输出重复截断等不可补跑错误必须遵循 `allowedActions`。普通 resume 不会重试已经完成的 PARTIAL。

## 人工审核

默认 `failurePolicy="return_partial"`；选择 `"review"` 后，阶段失败或结果来源问题触发 `interrupt`。来源问题包括 `SOURCE_TEXT_NOT_FOUND`、`AMBIGUOUS_OVERLAP`、`OVERLAP_CONFLICT`。

审核载荷包含 `kind=review`、`stage`、`failures`、`qualityIssues`、`canAccept`。可重试失败允许 `retry_failed`；存在可用结果才允许 `accept_partial`。纯来源质量审核仅允许接受，不自动重跑成功单元。

`MISSING_FIELDS`、一般 `NEEDS_REVIEW` 和缺少原文答案只标记草稿，不单独触发暂停。人工接受保留结果、缺失字段和质量标记，不改写为“质量合格”；服务不提供结果编辑接口；桌面可预览并接受部分结果，导入后在本地编辑题目。

## 恢复与期限

独立服务意外重启后自动继续未完成 run，使用原 run ID、截止时间和剩余预算；暂停、主动中断、待审核任务保持等待。新人工恢复 run 可获得新的运行截止，任务总预算不重置。桌面模式重启后保留为中断状态，只有点击“继续”才重新调用模型。

控制回执与队列在同一事务持久化，运行根据 checkpoint 判断控制是否已经应用。模型外部调用和数据库不能实现跨系统恰好一次：响应未持久保存时可能重发，未知用量和已消耗预算必须保留。

任务有效期从创建起 180 天，到期返回 `TASK_EXPIRED`。代码、锁定依赖、Python 补丁版本、模型与存储语义改变后返回 `EXECUTION_VERSION_MISMATCH`；必须使用原版本或创建新任务。升级不迁移旧 Agent Server checkpoint。

## 格式边界

所有格式统一使用 `LLM_MODEL`；TXT/CSV 发送文本，PDF/图片直接通过图片输入提题。页面携带相邻页上下文，只输出起始于本页的题目；超过窗口的续文保留缺失字段，不猜测。

部署、独占锁、恢复验收与清理见 [运维说明](operations.md)。

## 任务列表

`GET /api/document-tasks?limit=20&offset=0` 使用相同 Bearer 鉴权，返回 `items`（threadId、fileName、createdAt、expiresAt、state、status、checkpointId、questionCount、reviewCount）及 `hasMore`。limit 为 1–100，按创建时间与任务 ID 降序排列。摘要只读取已保存的 checkpoint，不读取全部调用日志；过期任务标记 EXPIRED。完整状态通过单任务查询获取。

## 只读审核预览

`GET /api/document-tasks/{threadId}/preview` 使用相同鉴权和期限检查，返回 threadId、checkpointId、state、phase、units、failures、quality 和 questionSources。例如 `units` 的一项为：

```json
{
  "stage": "document_parse",
  "index": 0,
  "questions": [],
  "groups": [],
  "visualElements": [],
  "sourceRef": null
}
```

阶段审核返回保存的成功单元和对应来源引用；结果审核返回合并结果。失败范围见 failures，质量与题目来源见 quality / questionSources。此接口不执行 merge、裁剪或模型，不接受结果、不写题库。来源内容仍通过校验过的 artifact 接口读取。接受时必须携带预览的 checkpointId，过期预览不能接受新版本。

## 恢复错误与桌面回执

启动时先检查最终 checkpoint 的 run 归属和合法结果：已结束的运行修正为完成，审核中断保留待审核，不执行节点。桌面模式下其余未完成任务仍等待主动继续。执行签名校验不变，不迁移跨版本 checkpoint。

模型 401/403 保存为 `AI_PROVIDER_AUTH_ERROR`，不自动重试。修正密钥后显式 retry_failed 开启新的失败单元轮次，成功单元、历史用量和剩余预算保留。永久提供方错误保存为不可重试失败，不允许通过普通 resume 重放缓存错误。

桌面在创建或控制 POST 前将 requestId 和原始请求持久保存到 `ai/requests/`。连接中断、无效回执或服务端不确定错误保留待确认状态；明确拒绝的 4xx（408 除外）终止该操作。用户显式重试使用同一 ID 和内容；修正输入后新操作使用新 ID。Rust 保留 code、message、httpStatus 和 requestId。HTTP 请求和图片下载不持有服务进程锁。

桌面批次使用 prepare_batch、run_batch、batches、cancel_batch 命令。run_batch 的 titles 仅在首次确认时传入，继续传 null。`ai/import-batches/` 清单保存任务、结果摘要、checkpoint、名称和逐项状态；数据库 schema 6 的 ai_imports 保存 `(thread_id,digest)` 唯一回执，与题库同事务提交。继续时以数据库回执为准。清单与待确认请求不进入题库备份，已提交回执随题库保存；仍可恢复 schema 1–5 的备份并迁移至 6。

## 已移除的 Word 输入

`sourceType` 仅接受 `text`、`csv`、`pdf`、`image`。Word 上传及 `docx_parser` 新任务返回 422；旧 Word 任务的继续、重试和接受部分结果返回 409 / `WORD_FORMAT_REMOVED`，请转 PDF 后新建任务。历史记录与已有题库不删除，已完成结果仍可作为 JSON 导入。
