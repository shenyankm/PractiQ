<p align="center">
  <img src="app/src-tauri/icons/icon.png" width="160" alt="PractiQ logo">
</p>

# PractiQ

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md)

把文档变成题库，在 macOS、Windows 或 Android 上离线练习和模拟考试。

- **导入与复核**：用 AI 从文档中提取题目，检查需要复核的内容，整理自己的题库。
- **练习与组卷**：跨题库按题型、错题、收藏或未做题挑选题目，进行练习、自测或限时模考。
- **查看评分**：客观题立即在本机判分，简答题可交给 AI 评分，也可以自己改分。
- **保存与分享**：下次接着上次的进度练习，备份个人记录，把题库连同图片和音频导出为 ZIP 分享。

应用提供简体中文、繁体中文和英文界面，支持明暗主题、七种基础题型，以及英语听力、阅读、完形填空、翻译和写作。练习数据只保存在你的设备上，不需要账号，也不会同步到云端。文档导入使用你自己搭建的服务，只需填写该服务的访问令牌，不提供用户管理或内置计费。

首次启动时，应用按系统语言选择界面语言，并记住你的选择；之后也可以随时从侧边栏切换。语言选择会包含在完整备份中，日期和数字跟随界面语言对应的地区格式。切换语言不会改变题目原文，也不会影响你的作答。

PractiQ 仍在开发中。请按[安装](#安装)说明从源码安装，或查看 [GitHub Releases](https://github.com/shenyankm/PractiQ/releases) 了解已发布的安装包及其已知限制。构建检查通过，并不代表已经完成签名发布或在全新系统上试用过。

## 截图

以下截图取自英文界面的桌面开发预览，题库和练习记录均为人工编写的示例。所有数据只保存在内存中，没有输入凭据、上传文件或调用模型。点击图片可查看原图。

| 题库 | 答题 |
| :---: | :---: |
| [![英文题库首页，包含示例题库名称和描述](docs/assets/screenshots/banks-en.png)](docs/assets/screenshots/banks-en.png) | [![英文答题页面，包含选项和答题卡](docs/assets/screenshots/practice-en.png)](docs/assets/screenshots/practice-en.png) |
| **错题** | **练习记录** |
| [![英文错题列表，包含得分和所属题库](docs/assets/screenshots/mistakes-en.png)](docs/assets/screenshots/mistakes-en.png) | [![英文练习记录，包含进度和成绩](docs/assets/screenshots/history-en.png)](docs/assets/screenshots/history-en.png) |

## 先体验：无需配置模型

[安装 PractiQ](#安装)后：

1. “我的题库”为空时，点击**添加示例题库**；也可以依次打开**设置 → 导入与恢复 → 导入题库 ZIP**，导入 [sample.zip](app/fixtures/sample.zip)。更多示例：[复合题](app/fixtures/composite.zip)、[全题型](app/fixtures/all-types.zip)。
2. 打开题库并点击**开始练习**，体验即时反馈练习、不限时自测或限时模考。
3. 提交作答，查看评分和解析。

全程不需要 API Key。这些示例由人工编写，用于展示题型和待复核标记，不代表模型效果。

在题库卡片的菜单中选择导出，即可生成不含个人作答和评分的 ZIP 用于分享。导入题库会把内容追加到现有题库；恢复完整的学习数据备份则会在你确认后替换个人数据。作答、草稿保护、语言设置和主动调用 AI 评分的详细规则见[练习指南（英文）](docs/guides/practice-guide.md)，导入与备份的范围见[题库包指南](docs/guides/question-bank-package.md)。

## 用 AI 导入文档

文档导入在自建 AI 服务的网页中完成：

1. [启动 AI 服务](#自建导入服务)，打开网页并填写服务访问令牌（`AI_SERVICE_TOKEN`）。模型配置和供应商密钥保存在服务端。
2. 一次最多选择 10 份文件，然后点击**开始导入**。只选择文件不会上传或解析。
3. 查看导入进度，检查题目、图片、原文答案和需要复核的内容，然后下载题库 ZIP。
4. 在桌面应用中依次打开**设置 → 导入与恢复 → 导入题库 ZIP**，新建题库或把内容追加到已有题库。

服务通过腾讯云的[异步多模态文档解析](https://cloud.tencent.com/document/product/866/139312)读取 **PDF、TXT、Markdown、PNG/JPEG、DOC、DOCX、PPT、PPTX、XLS 和 XLSX**，再由 AI 整理成题目。腾讯云的凭据请在服务端配置。新导入不再支持 CSV，已保存的数据和题库不受影响。桌面安装包不包含 Python 服务或 LibreOffice。

腾讯云在首次开通时一次性赠送 **1,000 页免费额度，有效期一年**，实际条件以[官方额度说明](https://cloud.tencent.com/document/api/866/35945)为准。每种格式的大小上限、超大文件的切分方式和可选的私有 COS 中转，见[腾讯解析配置](server/docs/tencent-document-parser.md)。

查看历史、暂停、中止、继续、重试失败部分、复核部分结果和重新解析，都在网页中操作。查看、复核和下载结果不会调用模型；继续、重试和重新解析需要你主动触发，可能产生模型供应商费用。详见[导入任务指南](docs/guides/import-tasks.md)和[个人自托管指南](server/docs/personal-use.md)。

解析只提取文档中已有的答案和评分细则，不会替没有答案的题目作答；缺失的内容会保留待复核标记。请在 **180 天**内下载需要保留的结果；任务过期不影响已经导入应用的题库。

## 用 AI 批改主观题

练习和本地判分完全离线可用。需要用 AI 批改简答题时，依次打开**设置 → AI 服务**，选择**直连模型 API**，填写兼容 OpenAI 的 API 地址（包含 `/v1` 或供应商要求的基础路径）、模型 ID 和你自己的 API Key。macOS、Windows 和 Android 都由应用直接请求模型供应商，不需要另外部署评分服务。已经在使用自建服务的用户，可以选择**独立 AI 服务**，继续使用原来的服务地址和令牌。

批改必须有参考答案或评分细则。批改会把当前题目、相关材料、图片和你的作答发送给你选择的供应商，可能产生费用。该 API 需要支持 JSON 模式和输出长度上限；含图片的题目需要视觉模型。每次主动批改最多请求一次，超时 120 秒，输出上限 4,096 token。结果无效、被拒绝或被截断时保持未判定，已有分数和人工改分不受影响。结果不明时不会自动重发：查看只读取本地记录，只有明确重新批改才会产生新的付费请求。测试连接只读取可用模型列表，不验证批改效果。此功能供个人练习使用，不作为正式考试阅卷依据。

API Key 和服务令牌保存在系统凭据存储中，不会进入备份。连接设置不含密钥，与练习数据分开存放，因此练习记录和旧备份仍然兼容。旧版本应用无法读取新版本保存的设置，启用后请继续使用当前版本。旧的模型设置和密钥会原样保留，不会被自动启用。

限时模考在关闭应用或电脑休眠后仍会继续计时；回到已经超时的考试时，会按最后保存的作答交卷。批改和考试规则的细节见[练习指南（英文）](docs/guides/practice-guide.md)，备份与恢复的限制见[数据格式说明](docs/reference/question-model.md#versions-and-directories)。

开发模式默认使用内存中的示例数据；预览面板可以切换场景，或改用真实本地数据，详见[开发预览](app/docs/development-preview.md)。

## 安装

PractiQ 目前需要从源码安装。你不需要自己敲命令：打开仓库根目录，让 AI 编程助手按下面的提示安装。

> 阅读 `docs/guides/installation.md`，在这台电脑上安装 PractiQ。先检查环境要求，只执行适合我系统的步骤，完成后告诉我执行了哪些命令、安装包在哪里，以及哪些步骤失败。安装系统软件前先问我。

[安装指南（英文）](docs/guides/installation.md)同时面向用户和 AI 助手，包含 macOS、Windows 和 Android 的环境要求与命令、如何确认应用能正常启动，以及可选的 AI 服务安装。

应用支持 macOS 14+（Apple Silicon）、Windows 10/11（x64）和 Android 8+（API 26+，arm64 APK）。不提供 Linux 安装包，Linux 仅用于运行 AI 服务和 CI。构建检查覆盖 macOS/Windows 安装包、Android APK 和 API 35 模拟器；实体设备、最低系统版本和签名发布另行验收。

桌面数据保存在新的 `v4/` 目录中，使用 SQLite schema 11。旧目录（包括 `v3/`）原样保留，旧版完整备份不再接受，当前格式的题库 ZIP 仍可导入。详见[数据格式说明](docs/reference/question-model.md#versions-and-directories)。

## 自建导入服务

文档导入需要自建 AI 服务，离线练习不需要。服务需要 Python 3.14+、uv、Node.js 22.12+、一个空的 PostgreSQL 数据库、专用的 RabbitMQ vhost，以及支持文字和图片输入的模型。可以让 AI 助手按[安装指南（英文）](docs/guides/installation.md)中的服务部分完成配置和启动。

服务的部署、升级、存储与恢复见[服务指南](server/docs/service-guide.md)、[投递与恢复指南](server/docs/rabbitmq.md)和[个人自托管指南](server/docs/personal-use.md)。现有服务的数据库版本 1–4 需要停服备份后手动升级到 5；保存过客户任务的旧库请另建个人数据库和存储目录。模型配置由你自己提供，费用直接支付给模型供应商，PractiQ 不提供计费或用户管理。

## 文档与开发

[文档索引（英文）](docs/README.md)按使用指南、技术参考、验收记录和历史证据分类。[题型模型](docs/reference/question-model.md)说明题型和复合题规则，[文档任务 API](server/docs/document-tasks.md)说明任务请求和操作，[部署与运维](server/docs/operations.md)说明部署、存储和恢复。

桌面端的检查在 macOS/Windows 上运行 `make app-check`；Android 各开发主机上的共享检查、APK 构建和模拟器检查见 [Android 指南](app/docs/android.md)。导入网页的检查运行 `make web-check`，AI 服务的检查运行 `make verify`。Playwright Test 覆盖双语交互、浏览器预览和富内容显示，使用模拟的原生命令，不调用模型：

```sh
cd app
npx playwright install chromium --only-shell
npm run test:browser
```

测试运行器会自行启动本机 Vite 服务。测试失败时，执行轨迹和截图保存在 `app/test-results/browser/`；可用 `npx playwright show-trace /path/to/trace.zip` 查看轨迹。

## 获取帮助与参与贡献

请通过 [GitHub Issues](https://github.com/shenyankm/PractiQ/issues/new/choose) 报告可复现的问题或提出改进建议。代码和文档贡献请阅读[贡献指南](CONTRIBUTING.md)，安全漏洞请按[安全策略](SECURITY.md)私下报告。质量、发布、试用和贡献流程中尚未完成的验收项目记录在[路线图证据记录](docs/maintainers/roadmap-evidence.md)，以 GitHub 上的路线图和子议题为准。

项目源码使用 [MIT 许可证](LICENSE)，内置依赖保留各自的[上游许可声明](app/licenses/README.md)。
