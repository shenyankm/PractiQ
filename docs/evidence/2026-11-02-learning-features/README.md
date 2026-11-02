# 离线学习功能验收 · 2026-11-02

本轮补齐今日复习、学习统计与专项练习、个人笔记与错因、导入重复题预览与处理、备份提醒。练习数据库保持 schema 11；新增个人数据使用 `learning-v1.sqlite`，完整备份仍为 version 4。没有新增依赖或模型调用。

## 自动化检查

| 检查 | 结果与边界 |
| --- | --- |
| `make app-check AI_PYTHON=...` | 共享 AI 契约和 fixtures、TypeScript、ESLint、540 项前端测试、Rust 格式、273 项 Rust 测试、Clippy 均通过；前端既有 6 项测试跳过，Rust 既有 27 项忽略，没有把忽略项算作通过 |
| `npm --prefix app run build` | 生产前端构建通过 |
| `npx playwright test check-learning.mjs check-built-navigation.mjs check-i18n.mjs` | 25 项通过；这是选定用例，不是整个浏览器套件 |
| 界面静态与浏览器检查 | 新增/修改的四个界面文件静态检查为 0 FAIL / 0 WARN；学习概览在 1440、1024、960px 的实际渲染检查为 0 FAIL / 0 WARN，已查看截图 |

新增回归覆盖：未判定/跳过与各判定方式分列；历史题库/题型使用快照；材料题完整推荐、当天作答排除；夏令时切换时本地日期边界；笔记写入失败保留草稿、关闭确认、重启持久化、容量和未知数据库拒绝；旧备份清空笔记、非法笔记引用拒绝、恢复记录重放；清空笔记仍触发备份提醒；备份文件已发布而提醒元数据失败时仍返回成功文件；部分/完整快照重叠的精确跳过、保留选择、过期比较拒绝和诊断引用保留。

## 原生 macOS 验收

使用本机 Tauri 调试构建，独立标识 `com.practiq.acceptance.learning20261102`，数据目录为该标识下的 `v4/`。通过原生应用窗口和真实 macOS 文件选择器操作，仅使用仓库内置示例，未打开正式应用数据，未配置模型或密钥。

1. 空数据库启动后添加内置全题型题库，得到 1 个题库、20 道可作答题目。
2. 打开学习概览，空统计显示 0；备份提醒显示尚未导出。
3. 明确启动一题离线练习并提交错误答案。统计显示 1 次已提交、自动判定 0/1，未判定和跳过均为 0；今天已答题目未再次推荐。
4. 在原生笔记编辑器保存“原生验收：先检查条件，再计算。”与“审题失误”。退出并重新打开应用，继续练习后读取到同一正文与错因。
5. 用真实保存对话框导出完整备份，界面更新上次成功备份时间；只读检查 ZIP 确认 version 4/schema 11 和个人笔记字段。
6. 通过替换确认及真实打开对话框恢复先前备份。备份中的空正文/审题失误恢复成功；自动生成的恢复副本保留恢复前较新的正文。恢复后备份提醒的本机时间重置。
7. 选择仓库 `all-types.zip`，指定现有题库，原生预览识别 18 组／20 题完全相同内容。明确选择跳过并确认后，提示该完整结果已导入；题库仍为 20 题，原有一次错误作答保留。

只读数据库核对记录于 [evidence.json](evidence.json)。原生过程通过 Computer Use 的可访问性树和截图现场核验；以下存档图片来自 Chromium 界面测试，不能替代原生窗口截图。

## 界面截图

- [简体中文、浅色、1440px 学习概览](overview-zh-light.png)
- [英文、深色、1440px 学习概览](overview-en-dark.png)
- [笔记与错因](notes.png)
- [重复题预览与处理](duplicates.png)

截图中的题库、学习次数与笔记均为测试数据。语言覆盖简体中文、繁体中文、英文，主题覆盖浅色和深色，桌面窗口覆盖 1440×900 与 960×900。静态设计检查沿用现有章鱼品牌、配色、字体与组件，采用安静的列表和数字排版；参考方向为 `achromatic-ledger`，seed `1225574192`，无重新抽取。学习概览首先回答“接下来练什么”，统计表通过专项练习按钮进入现有选题流程。

## 限制

- 今日复习是可解释的规则排序，不是记忆曲线或掌握度预测；最多推荐 20 组，每次仍遵守 1,000 小题上限。错因筛选作用于当前推荐队列。
- 去重只比较目标题库中的完整题组，不合并相似题、不跨库合并、不覆盖用户修改。原生窗口验收的是完整结果收据跳过；部分结果到完整结果的精确跳过由 Rust 集成测试验证。
- 笔记不进入共享题库或历史快照。旧 schema-11 备份可恢复，但会清空当前笔记；含新笔记的备份应由更新后的应用恢复，旧版应用可能忽略新增字段。
- 本轮没有调用真实模型，也没有重新验收独立服务或 Web 文档解析。原生构建未签名、未公证，不构成正式发布验收。
- 工作区原有性能验收改动不属于本轮功能实现。

## PR preparation follow-up

The UI copy was subsequently shortened across the learning pages and existing practice, history, question review, image viewer, audio and connection settings screens. Necessary save, grading, cost, network and replacement guidance remains. The four browser screenshots above were refreshed after this cleanup; `screenshotsCapturedAt` and `screenshotsSourceSha256` identify that capture. The original `capturedAt`, `sourceSha256`, native binary hash and native observations remain the historical native acceptance record. All six feature-related Rust source hashes still match it. No further native binary or installer acceptance is claimed for the copy-only changes.

- TypeScript and ESLint passed.
- `npx vitest run --coverage --maxWorkers=4`: 540 passed, 6 existing skips; statements 89.24%, branches 85.09%, functions 86.82%, lines 92.97%.
- The production frontend build passed after the copy cleanup.
- `npm --prefix app run test:browser`: the complete initial run had 162 passes and 2 failures in an existing import-recovery fixture. It imported an identical snapshot into its source bank but still expected 9 new questions; the updated preview correctly skipped that receipt.
- The fixture now imports into an empty bank to retain its original committed-write/recovery purpose. `npx playwright test check-ux-recovery.mjs --grep 'overview and committed import recover without replay' --output=/tmp/practiq-learning-browser-rerun` in `app/` passed both widths (2/2) after that test-only change. The whole suite was not repeated afterward. Initial failure screenshots, contexts and traces remain in the original local browser output; the focused run used a separate output directory.
