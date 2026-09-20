# 练题、考试与评分验收（2026-09-20）

已实现：七种题型筛选、多题库/未做题筛选、总量/题型配额/手动组卷、0.01 分精确配分、不限时自测、限时模考、统一交卷、逐题 AI 主观题评分、人工部分得分与改分记录、错题重练、复制合并题库、SQLite v5 及备份兼容。

## 工程验证

| 检查 | 结果 |
|---|---|
| `make verify AI_PYTHON=...` | 424 项通过，覆盖率 91%；锁文件、Ruff、Pyright、评估夹具及 Python 构建通过 |
| `make app-check AI_PYTHON=...` | 前端 13 项、Rust 13 项通过，Clippy 通过；1 项 Keychain 测试默认跳过 |
| `make app-build AI_PYTHON=...` | Apple Silicon `.app`、`.dmg` 构建成功 |
| `app/scripts/check-bundle.py` | 实际安装包内的 TXT/CSV/图片/PDF 解析通过；评分鉴权、300/500 部分分、用量记录和相同请求复用通过（本机模型桩） |
| macOS 原生窗口 | 独立标识 `com.practiq.acceptance.exam`：JSON 导入、模考选题、10.01 分配分、总分冲突拦截、答案隐藏、保存/跳题、交卷确认、人工 1.5/2 分、重新进入记录、两库 9+9→18 题合并与原库保留已观察 |

超时/重启、迟到评分、人工覆盖、事务回滚、来源删除、备份恢复等边界由临时数据库集成测试验证。原生窗口验收使用隔离开发包；发布包内置服务另行验证。未将测试题库写入用户原有数据目录，原有数据库仍为 v4、1 个题库。未修改原有 `UIUX_DESIGN.md`。

## 真实模型证据与失败记录

使用配置中的 `qwen3.7-flash` 文本/视觉模型，仅发送规则构造的固定样本。以下生成报告保留在验收工作区，不纳入 Git；可用文末命令重新生成。

- 主观题评分：4 个文本案例各重复 2 次，加 1 个图片部分得分案例；最终 9/9 与预期分值一致，包括错误答案和提示注入答案得零分。首轮及仅加强必填字段后的两轮均为 0/9，保留在 `server/reports/grading/baseline.json`、`required-score.json`；最终结果为 `integer-wire.json`。
- 原因与修复：模型将 nullable 整数输出为字符串。评分字段改为必填，并只归一化精确 ASCII 整数字符串；小数、负数、NaN 和越界数仍拒绝，不舍入、不截断。
- 分值提取：接口最初拒绝带小数 `multipleOf` 的 schema。仅在模型 wire schema 中移除该约束，本地 Pydantic 和桌面导入 schema 仍保留精度校验。
- 5 题提取样本初次漏掉最后一题，失败保存在 `source-scores-baseline.json`。加强“分值缺失不能省略题目”的提示后，同一原文连续 2 次完整提取，分值均为 `[1.5, 1.5, 4, null, null]`，没有均摊未明确的大题分数；详见 `source-scores.json`。

这些是合成样本冒烟检查，**不是教师独立标注、广泛学科校准或正式阅卷准确率承诺**。可用于个人试运行；关键评分仍需复核。源图或题干自带答案不在首版防作弊保证内。

复现命令（会调用已配置模型、产生费用）：

```sh
cd server
/path/to/python3.14 scripts/evaluate_grading.py --live --repeats 2 --output reports/grading/recheck.json
/path/to/python3.14 scripts/evaluate_grading.py --live --source-scores-only --repeats 2 --output reports/grading/source-recheck.json
```

## 接口与保存规则

- 解析题目增加可空 `sourceScore`、`scoringRubric`、`scoreSourceText`；旧 JSON 不需补字段。
- Tauri 请求增加 `start_paper`、`submit_paper`、`complete_review`、`flag`、`manual_score`、`retry_wrong`、`merge_banks`；`questions` 增加可选 `bank_ids`，`ai_request` 增加 `grade`。前端只提交考试 ID、题号和是否明确重试；Rust 从本次快照构造模型请求。
- 鉴权 `POST /api/subjective-grades` 输入为 `requestId`（UUID）、`inputDigest`、`question`、`answer`、`maxCents`、可选 `materials` 与 `images`。`inputDigest` 是去掉 requestId/inputDigest 后按键排序、紧凑 UTF-8 JSON 的 SHA-256；图片仅接受有摘要的内联受限图片数据，不接受任意 URL 或文件路径。
- 输出 `status` 为 `graded` / `ungraded` / `unknown`，包含 `result`（得分、满分、理由、依据、复核原因）或错误，以及已知 `usage` 和逐调用 `calls`。分数使用整数百分单位，例如 300 表示 3 分。
- 没有参考答案及细则、结构或材料不足时，不自动评分；模型失败不当作零分。重评分失败保留已有分数，人工评分优先于迟到响应，记录旧 AI 结果和人工改分历史。
- 桌面备份保留最终评分与失败记录，排除未完成模型请求及服务请求缓存。服务结果未知后需要用户明确处理；供应商侧不保证恰好调用一次。

非阻断构建提示：前端主包超过 500 kB，PyInstaller 提示未安装的可选模块；实际包内功能检查通过。未执行开发者签名或公证发布。
