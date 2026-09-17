# 题目完整性

题目缺字段时仍返回 JSON 并保存草稿。`missingFields` 是服务端计算的只读、有序、去重的顶层字段名数组；空数组表示内容完整，不表示答案正确，也不替代人工审核。客户端不能提交该字段。

必查：`stem`、`questionTypeId`、`answerMode`、`answerPayload`、`analysis`、`sourceText`。选择题另查 `choiceVariant`、`options`；排序题查 `items`；匹配题查 `matchingVariant`、`items`。模型报告的 `media`、`material` 缺失依赖会保存，实际附图或材料补齐后重新计算，移除后再次标为缺失。知识点、目录、分组归属和审核状态不影响完整性。

AI 输出的业务标量为空时使用 `null`，列表使用 `[]`，不能补造题目或答案。可识别的缺字段题保留；完全没有题目的文档继续返回 `NO_QUESTIONS_FOUND`，不生成空白题目。答案生成已知缺题干、作答方式、必要选项／条目或依赖时不调用模型；模型无法作答也可正常成功返回 `answerPayload: null` 和缺失项。原生 `function_calling` 默认不变；非法 JSON、类型、枚举、矛盾内容仍有限纠错，服务故障仍报错，每次实际调用保留用量。

示例（AI 题目结构的业务字段，其他元数据照常返回）：

```json
{"stem":"计算 2 + 3","questionTypeId":"short_answer","answerMode":"short_answer","choiceVariant":null,"matchingVariant":null,"options":[],"items":[],"answerPayload":null,"analysis":null,"sourceText":"计算 2 + 3","missingFields":["answerPayload","analysis"]}
```

产品管理接口继续使用既有数据库字段命名（如 `answer_mode`），并完整返回 `sourceText`、`missingFields`、`answerPayload`、`draftAnswerPayload` 与历史 `answer_keys`。草稿排序／匹配答案使用从 0 开始的条目位置（匹配在各侧内计数），正式答案版本使用持久化条目 ID。未完成答案只存草稿；通过题型校验后才能成为正式版本。练习接口不返回来源原文、草稿答案或解析，避免提前泄露答案。

`POST /banks/{id}/questions` 和 `PATCH /questions/{id}` 支持空业务字段，缺字段可以保存。`GET /banks/{id}/items?incomplete=true` 筛选待补全题。发布时缺字段返回 HTTP 409：

```json
{"error":{"code":"QUESTION_INCOMPLETE","message":"Complete the missing question fields before continuing","details":{"missingFields":["analysis","sourceText"]}}}
```

修改、选项／条目、答案、图片及材料变更在同一数据库事务中重算；已发布题变得不完整会转为草稿，补齐后由用户手动发布。新练习／考试只选已发布且完整的题；已开始的会话遇到不完整题返回上述错误。已完成历史成绩和引用的答案版本保留。

## 现有库迁移

新库使用 `db/00_schema.sql`。现有库按版本顺序、停止写入并完成备份后执行 `db/migrations/003_question_completeness.sql`，脚本自带事务。不要对现有库重复执行新库 Schema。迁移仅从可追溯的导入任务结果恢复 `sourceText`；无来源证据的字段保留为空，重新计算所有题目，并将缺字段的已发布题降为草稿。不清库、不删除历史答案或作答。此次开发只对一次性 PostgreSQL 执行迁移测试，没有修改个人数据库。

## 验证

`make verify` 覆盖 AI、真实临时 PostgreSQL、Web 样式／单测／类型／构建、数据库边界及后端 Ruff。`backend/tests/test_completeness_migration.py` 从冻结的旧 Schema 建库，验证来源恢复、状态调整和历史引用保留。真实模型缺失内容检查记录在 `server/reports/evaluations/question-completeness-smoke*.json`；它不替代文档语义质量门禁，既有未达标评测仍然保留。

## 本地 JSON Repair

文档解析与答案生成共用本地语法修复入口，先尝试原始 JSON 校验，语法错误时修复缺失的闭合括号、已有闭括号前的尾逗号，以及完整 Markdown JSON 代码围栏。修复结果重新经过 Pydantic Schema 和现有内容校验，允许缺业务字段并重新计算 `missingFields`；不补造字段值、不转换错误类型、不改变答案引用规则。修复成功不额外调用模型，原调用用量照常记录。

无法确定缺失值、未闭合字符串、错误的括号配对或供应商明确标记 `finish_reason=length` 的截断结果不直接接受，仍进入原有有限模型纠错流程。该修复器仅处理上述确定的标点错误，不使用会猜测题目内容的宽松修复。
