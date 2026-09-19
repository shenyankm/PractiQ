# 文档任务 API 与 HITL

五个 Graph 共用开源 LangGraph 的 checkpoint、Store 和 PostgreSQL 持久队列，不再提供官方 Agent Server 原生 API。

## 创建与查询

先通过鉴权上传接口获得 `document` 引用，再提交：

```json
{
  "requestId": "11111111-1111-4111-8111-111111111111",
  "graphId": "document_parser",
  "document": "替换为上传返回的完整引用对象",
  "failurePolicy": "return_partial"
}
```

`POST /api/document-tasks` 返回 HTTP 202，字段为 `threadId`、`runId`、`requestId`、`accepted`。202 表示已持久入队，不代表解析完成。所有业务接口要求 `Authorization: Bearer <AI_SERVICE_TOKEN>`。

`graphId` 可选 `document_parser`（默认，全部格式）、`text_csv_parser`、`pdf_parser`、`docx_parser`、`excel_parser`。可选 `parentThreadId` 仅关联已存在的新运行时任务，不覆盖父任务。未知字段、原始 state、URL、Base64、服务器文件路径和用户提交的模型结果均拒绝。

`GET /api/document-tasks/{threadId}` 返回 `state`、`phase`、`progress`、`failures`、`blocking`、`allowedActions`、`checkpointId`、`expiresAt`、`updatedAt`、`status`、`result`、`processing`、`usage`、`unknownUsageCalls` 和 `modelBudget`。初始无 checkpoint 时返回不透明的 `pending:<runId>` 令牌，仅用于该任务控制，不是 LangGraph checkpoint。调用方不得解析或构造令牌。

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

`POST /api/document-tasks/{threadId}/control`：

```json
{
  "requestId": "22222222-2222-4222-8222-222222222222",
  "action": "resume",
  "checkpointId": "从最近一次 GET 原样取得"
}
```

每个变更使用 UUID `requestId`。同一请求重放返回原回执；同 ID 不同内容返回 `REQUEST_CONFLICT`。旧 run 返回 `STALE_RUN`，旧 checkpoint 返回 `STALE_CHECKPOINT`，任务仍忙返回 `TASK_BUSY`。请求受理与实际停止分开查询。

`pause` 为协作暂停：已派发转换/模型调用可能先完成，后续批次停止。`interrupt` 先保存取消意图，再取消执行，不保证撤回远端模型请求或终止底层同步线程。立即中断产生的未知调用保留。

`retry_failed` 可以省略 `units` 或传 `[]`，表示所有仍可补跑单元；也可传 `[{"stage":"vision_parse","index":1}]`。索引从零开始；stage 为 `vision_parse`、`vision_describe` 或 `document_parse`。每单元最多两轮额外补跑，剩余次数见 `retriesRemaining`；成功单元不重算。耗尽、输入超限、转换准备失败、输出重复截断等不可补跑错误必须遵循 `allowedActions`。普通 resume 不会重试已经完成的 PARTIAL。

## 人工审核

默认 `failurePolicy="return_partial"`；选择 `"review"` 后，阶段失败或结果来源问题触发 `interrupt`。来源问题包括 `SOURCE_TEXT_NOT_FOUND`、`AMBIGUOUS_OVERLAP`、`OVERLAP_CONFLICT`。

审核载荷包含 `kind=review`、`stage`、`failures`、`qualityIssues`、`canAccept`。可重试失败允许 `retry_failed`；存在可用结果才允许 `accept_partial`。纯来源质量审核仅允许接受，不自动重跑成功单元。

`MISSING_FIELDS`、一般 `NEEDS_REVIEW` 和缺少原文答案只标记草稿，不单独触发暂停。人工接受保留结果、缺失字段和质量标记，不改写为“质量合格”；没有结果编辑接口或审核前端。

## 恢复与期限

意外重启自动继续未完成 run，使用原 run ID、截止时间和剩余预算；暂停、主动中断、待审核任务保持等待。新人工恢复 run 可获得新的运行截止，任务总预算不重置。

控制回执与队列在同一事务持久化，运行根据 checkpoint 判断控制是否已经应用。模型外部调用和数据库不能实现跨系统恰好一次：响应未持久保存时可能重发，未知用量和已消耗预算必须保留。

任务有效期从创建起 180 天，到期返回 `TASK_EXPIRED`。代码、锁定依赖、Python 补丁版本、模型与存储语义改变后返回 `EXECUTION_VERSION_MISMATCH`；必须使用原版本或创建新任务。升级不迁移旧 Agent Server checkpoint。

## 格式边界

TXT/CSV 用文本模型；PDF/DOCX/图片直接视觉提题。页面携带相邻页上下文，只输出起始于本页的题目；超过窗口的续文保留缺失字段，不猜测。DOCX 内嵌原图独立保留。

XLSX 以工作表为持久化单元，联合单元格、锚点图片与 Calc 图表/形状渲染。来源记录为 `excelSource`，未知关联为 `[]`，不伪造页码；真实重复题保留。不支持旧 `.xls`、单表超过 10,000 行或超出已有视觉/文本预算；公式无缓存时警告，不生成计算答案。

部署、独占锁、恢复验收与清理见 [运维说明](operations.md)。
