# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users: 学生、自学者、各类职业资格与学术考试的备战人群。
Situation & Job: 持有试卷、讲义、笔记、PPT、教材等非结构化或半结构化文档（PDF、Office、图片），需要将其快速解析归档为结构化题库，并在桌面端进行无干扰、高专注的离线刷题、即时评分、全真模拟考场自测、错题归因与长期学习追踪。

## Product Purpose

将杂乱的真实世界文档通过多模态 AI 智能提取转换为高质量结构化题目包，为 macOS 用户提供隐私第一、完全离线的桌面备考与刷题应用。
衡量成功的标志：用户能够以最低的心智负担完成复杂文档向精准题库的转化；核心练习、客观题判分与答题数据完全运行于本地设备，不依赖网络连接或外部账号即可稳定使用。

## Positioning

“文档直转题库 + 离线隐私优先的桌面备考神器”。
与在线刷题平台或普通笔记工具的核心差异：
- **隐私与离线优先**：核心练习、做题记录、答卷快照与错题归因全部持久化于本地 SQLite，无需注册登录，断网完全可用；
- **重器轻用、端云解耦**：繁重的多模态文档解析与 OCR 交由独立部署/自建的云端服务处理，客户端仅保留最轻量的导入与审阅控制；
- **全生命周期练习闭环**：覆盖文档解析、题目纠错审阅、多模式做题、本地/AI双轨判分、错题归因本到长期统计报告。

## Operating Context

- **运行平台**：macOS 14+ (Apple Silicon)，基于 Tauri 2 构建的桌面原生级视窗环境。
- **关键用户流程**：
  1. *导入流程*：在 App 的“文档导入”界面上传文档至独立的 AI 导入服务（基于腾讯云多模态解析），解析完成后核对有标记的题目，直接将后端结果及校验配图写入本地题库。
  2. *练习流程*：题库筛选 -> 选择练习模式（即时反馈练习、自由自测、严格限时模考） -> 快捷答题卡作答 -> 本地客观题快速判分 / 经配置的可选主观题 AI 评分 -> 错题与解析审阅。
  3. *复习流程*：按题型、错题原因、标记收藏等维度筛选复习，记录自拟笔记，追踪 7 天 / 30 天学习统计曲线。
  4. *数据流转*：题库 ZIP 分享导出、包含全量练习快照与配图的本地备份还原。
- **个人导入工作台**：App 内置导入、核对与下载流程，默认连接本机独立 Python 后端，无登录、用户管理、套餐或支付。服务由使用者独立部署。

## Capabilities and Constraints

- **前端架构**：Tauri 2 + React 19 + TypeScript + Vite + Tailwind CSS + shadcn/ui + Rust + SQLite (schema 11, 存储于 `v4/` 目录)。
- **服务端架构**：Python 3.14+ LangGraph / FastAPI / PostgreSQL / RabbitMQ / 腾讯云异步多模态解析接口。
- **离线边界**：本地做题、题库浏览、客观题判分与错题本严禁与外部服务强绑定，网络不可用时所有本地功能必须完整运行。
- **凭证安全约束**：所有 AI 功能由独立 Python 后端处理；模型与腾讯云凭证仅配置在后端。App 仅配置共用后端地址，旧钥匙串条目原样保留且不再读取。
- **媒体与资源不可变性**：题目关联图片采用 SHA-256 内容寻址命名并本地持久化，数据库仅引用已落盘校验的文件。
- **题型与内容覆盖**：原生支持 7 种基础题型（单选题、多选题、判断题、填空题、简答题、材料问答题、复合题），以及听力、完型、阅读理解、翻译、写作等复合场景。

## Brand Commitments

- **产品命名**：PractiQ
- **视觉符号**：章鱼（Octopus）品牌图标资产（`app/src-tauri/icons/icon.png`）。
- **Color and tone:** Calm, focused, and professional. Use Academic Cobalt (light `#1d4ed8`, dark `#60a5fa`) on cool paper (`#f8fafc`) or dark ink (`#090d16`), retaining the octopus mark. The App uses `shared/theme.css`; `DESIGN.md` defines typography and component rules.
- **图标与组件规范**：全局统一使用 `lucide-react`，界面控件使用 shadcn/ui 桌面风格组件，保持高度一致的桌面端排版与无障碍设计。
- **多语言适配**：原生支持简体中文、繁体中文、英文三语实时切换。

## Evidence on Hand

- **真实代码实现**：macOS 客户端位于 `app/`，AI 导入服务位于 `server/`，公共契约与组件位于 `shared/`。
- **视觉截屏与设计资产**：`docs/assets/screenshots/` 下的各模块真实截图，应用图标 `app/src-tauri/icons/icon.png`。
- **典型题库样本**：`app/fixtures/sample.zip`（标准题型）、`app/fixtures/composite.zip`（复合题型）、`app/fixtures/all-types.zip`（全题型套件）。
- **质量验证套件**：Playwright 浏览器交互测试与三语回归套件（`app/tests/`），Python 后端完整单元与集成测试（`server/tests/`）。

## Product Principles

- **隐私与离线优先（Privacy & Offline First）**：用户的题目、笔记、错题记录与模拟考成绩属于个人核心资产，默认完全保留在本地设备；任何云端交互均为显式触发且边界清晰。
- **沉浸克制的备考界面（Distraction-Free Focus）**：剔除无关社交与杂乱干扰信息，提供干净纯粹的阅读与作答视野，还原高效真实的考场与自习氛围。
- **可审阅、可信赖的 AI 辅助（Auditable & Honest AI）**：AI 生成的解析与补充答案必须带有明确的待审阅标记；主观题评分必须提供依据与引用片段；绝不假定或静默篡改用户的既有输入。
- **严谨考究的桌面工匠精神（Impeccable Desktop Craft）**：注重 macOS 原生快捷键响应、答题卡快速定位、长材料分栏阅读的顺畅度，确保每一次翻页与交互都精准灵动。

## Accessibility & Inclusion

- 完整的键盘交互支持（通过 Tab 快捷键浏览题肢、方向键切换、快捷键提交）。
- 色彩对比度达到 WCAG AA 级标准，确保暗黑模式与复杂公式、图表及长材料阅读时的清晰舒适度。
- 全界面多语言原生适配（简体中文 / 繁体中文 / 英文）。
