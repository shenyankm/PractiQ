# 首版发布说明草案 / First-release draft

本文以当前仓库能力整理首版范围，不代表版本已经发布或完成验收。版本号、发布日期、下载入口和签名／公证状态应在实际发布时填写；当前不承诺发布时间。

This draft describes the current repository's first-release scope. It does not establish a published or accepted release. Confirm the version, date, download link, and signing/notarization status at publication; no release date is promised here.

## 首版范围 / Scope

| 范围 / Area | 交付内容 / Included capabilities |
| --- | --- |
| 桌面 / Desktop | Apple Silicon macOS 14+；简体中文与英文 / Simplified Chinese and English |
| 导入 / Import | 离线 PractiQ ZIP 题库包；主动解析 PDF、TXT、CSV、PNG/JPEG / Offline bank ZIP with images; explicit document parsing |
| 整理 / Organization | 预览复核、编辑、搜索、收藏、复制合并题库 / Review, edit, search, bookmark, and copy-merge banks |
| 练习 / Practice | 七种基础题型及英语听力、阅读、选词、完形、语法填空、七选五、段落匹配、翻译和写作；断点续练与历史 / Seven basic types and nine English question kinds; resume and history |
| 考试 / Exams | 跨题库组卷、自测、限时模考、配分与本地客观题判分 / Cross-bank tests, timed exams, point allocation, and local objective scoring |
| 主观题 / Short answers | 有参考答案或评分细则时主动请求 AI 评分；支持人工改分 / Explicit AI grading with evidence; manual overrides |
| 数据 / Data | 本地存储与含图片、音频、作答、评分的备份恢复；密钥不进入备份 / Local storage and backups including images, audio, answers, and scores; keys excluded |

## 首版变更摘要 / Initial release notes

- 串联资料导入、题目复核、离线练习、组卷考试与成绩复核。Connect document import and review to offline practice, exams, and score review.
- 导入页管理可暂停、继续、补跑的 AI 解析任务；已有题库 ZIP 从设置的“恢复备份”菜单导入。Manage controllable AI parsing tasks on the Import page; import bank ZIP through Settings → Restore backup.
- 保留题目审核标记与历史练习快照，支持备份恢复个人学习记录。Preserve review flags and historical practice snapshots, with backup and restore for personal records.

以上是首次交付的能力摘要，不是已发布版本之间的差异记录。These notes summarize the initial delivery, not changes between published versions.

## 演示与使用场景 / Walkthrough and use cases

从 [中文体验步骤](../README.zh-CN.md#-先体验无需配置模型)或 [English walkthrough](../README.md#-try-it-without-a-model) 开始，无需模型凭据即可用仓库样例导入题库并练习。

可演示两个场景：学生导入自己的复习资料并按错题重练；资料整理者分发已有题库 ZIP 与图片，让接收者各自离线练习。这些是可复现的使用场景，不是已收集的真实用户证言。文件共享不包含在线社区、分享链接；支持桌面单库 ZIP 导出；整库备份包含个人记录，不适合作为纯题目分发包。

Demonstrate personal revision and distribution of bank ZIP with images for independent offline practice. These are reproducible scenarios, not collected customer testimonials. File sharing does not include an online community, or sharing links; desktop export of individual banks as ZIP is supported. Full backups contain personal records.

## 发布前待确认 / Before publication

以下项目保持未勾选，直到最终发布候选版本有对应证据：

- [ ] 确定版本、日期、实际下载地址及签名／公证状态。Confirm version, date, download URL, and signing/notarization status.
- [ ] 对发布候选版本完成服务、桌面和安装包检查，记录版本与结果。Run and record service, desktop, and package checks for the release candidate; see [Contributing](../CONTRIBUTING.md#check-the-affected-code).
- [ ] 在干净的目标 Mac 环境完成安装、样例导入、练习、交卷和备份恢复验收。Verify installation, sample import, practice, submission, and backup restore on a clean target Mac.
- [ ] 从实际应用录制简短演示或截取导入、练习、成绩复核界面，随发布材料提供。Capture an actual app walkthrough or screenshots of import, practice, and score review.
- [ ] 记录真实模型的解析与评分样例及失败情况，并收集经用户同意的试用反馈。Record live-model examples and failures, and collect user feedback with consent.

工程检查和人工样例不证明真实模型准确率；历史检查不代替发布候选版本验收。AI 评分面向个人练习，缺少参考答案或评分细则时保持未判定。Word 请导出 PDF；Windows CI 不代表 Windows 运行支持。

Engineering checks and hand-written samples do not establish live-model accuracy; historical checks do not replace release-candidate acceptance. AI grading is for personal practice and requires a reference answer or rubric. Export Word to PDF. Windows CI does not establish Windows runtime support. The linked guides record installation constraints and existing grading evidence.
