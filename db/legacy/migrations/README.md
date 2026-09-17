# 手工增量升级

仓库没有 Flyway/Liquibase 或迁移版本表；沿用有序、显式 `psql` 执行的 SQL 文件。`db/00_schema.sql` 是新库权威结构，不是已有库的升级脚本。**不得为本次升级清空开发库，也不得在已有库运行 schema-check 的破坏性初始化。**

## P1：已有开发库升级到 002

1. 操作者确认目标库身份、已有备份及恢复能力。停止 Java API 和 AI worker，避免升级期间旧代码继续生成无来源任务；不需要删除任务、用户、题目或账本。
2. 使用自行配置的 libpq service（例如 `practiq-dev`，密码放受保护的 `.pgpass`，不写进仓库/命令历史），先检查目标：

   ```sh
   psql 'service=practiq-dev' -X -v ON_ERROR_STOP=1 \
     -c 'select current_database(),inet_server_addr(),inet_server_port(),current_user;' \
     -c "select to_regclass('public.ai_tasks'),to_regclass('public.request_idempotency');"
   pg_dump 'service=practiq-dev' --format=custom --file=/safe/backup/practiq-before-p1.dump
   ```

   `practiq-dev` 和备份位置是操作示例，不是本项目自动选定的目标。先确认 service 配置和备份目录权限，再执行。
3. `002` 要求已有 `001_ai_task_worker.sql` 的字段和结构。按序执行尚未应用的文件；若无法确认是否已执行 `001`，停止流量后可依次重放 `001`、`002`，两者使用条件加列/替换函数。**不要在 `002` 后单独重放 `001`**，它会恢复旧版验证函数。

   ```sh
   # 仅当需要补齐/确认 001 时执行：
   psql 'service=practiq-dev' -X -v ON_ERROR_STOP=1 -f db/migrations/001_ai_task_worker.sql
   psql 'service=practiq-dev' -X -v ON_ERROR_STOP=1 -f db/migrations/002_p1_result_provenance.sql
   ```

4. `002` 在一个事务内条件添加 `ai_tasks.source_question_id`、来源约束及 `ai_report_sources`，替换来源不可变检查函数。无 UPDATE/DELETE 业务数据、无来源猜测回填；已有题目、用户、幂等记录、结果和账本保持原值。旧答案任务来源仍为 null，旧报告无来源行，新 Java 读取会返回 404（包括旧成功结果），而不是当作无关联草稿授权。
5. `002` 可重复执行：加列/建表/加约束有存在检查，函数替换为同一实现。锁等待最多 5 秒、单语句最多 30 秒；遇到异常，`ON_ERROR_STOP` 退出且未提交事务回滚。保持服务停止，排查目标/锁竞争/异常 schema 后重新执行同一文件，不要绕过检查或清库。手工记录执行文件、时间和目标库；这些脚本不猜测修复任意手工漂移的 schema。
6. 确认新列、新表、`validate_ai_task_change` 含 `source_question_id IS DISTINCT FROM` 检查，再部署新 Java，完成应用健康/权限检查后恢复流量。保留备份；不提供通过删列/清表降级的路径。回退旧应用可能恢复已修复的权限漏洞，必须另行安全评估。

## 验证（无需用户数据库）

`env -u POSTGRES_URL make api-schema-smoke` 创建一次性 PostgreSQL 容器，在其中构造升级前结构和旧数据，执行 `002` 两次，逐值比较用户、题库、AI 任务和幂等记录，验证来源未被猜测、来源不可变及旧结果读取失败关闭，然后跑 HTTP/数据库回归。脚本中还原旧结构的 DROP **仅用于这个新建临时容器**，不属于迁移文件。`make schema-check` 单独验证新库权威 schema。

本次实现没有向用户库自动执行任何 SQL。
