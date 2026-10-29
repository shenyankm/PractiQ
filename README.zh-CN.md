<p align="center">
  <img src="app/src-tauri/icons/icon.png" width="160" alt="PractiQ logo">
</p>

# PractiQ

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md)

把文档变成题库，在 macOS 上离线练习和模拟考试。

- **导入与复核**：用 AI 从文档中提取题目，检查需要复核的内容，整理自己的题库。
- **练习与组卷**：跨题库按题型、错题、收藏或未做题挑选题目，进行练习、自测或限时模考。
- **查看评分**：客观题立即在本机判分，简答题可交给 AI 评分，也可以自己改分。
- **保存与分享**：下次接着上次的进度练习，备份个人记录，把题库连同图片和音频导出为 ZIP 分享。

应用提供简体中文、繁体中文和英文界面，支持明暗主题、七种基础题型，以及英语听力、阅读、完形填空、翻译和写作。数据只保存在你的设备上，不需要账号，也不会同步到云端。

## 截图

以下截图于 **2026-10-29** 基于源码 [`0099f594`](https://github.com/shenyankm/PractiQ/commit/0099f5949b8b1b72c25f7939659b8cb1ce9d6041) 的桌面界面浏览器预览拍摄，界面为英文，题库和练习记录均为人工编写的示例。所有数据只保存在内存中，没有输入凭据、上传文件或调用模型。点击图片可查看原图。

| 题库 | 答题 |
| :---: | :---: |
| [![英文题库首页，包含示例题库名称和描述](docs/assets/screenshots/banks-en.png)](docs/assets/screenshots/banks-en.png) | [![英文答题页面，包含选项和答题卡](docs/assets/screenshots/practice-en.png)](docs/assets/screenshots/practice-en.png) |
| **错题** | **练习记录** |
| [![英文错题列表，包含所属题库和收藏操作](docs/assets/screenshots/mistakes-en.png)](docs/assets/screenshots/mistakes-en.png) | [![英文练习记录，包含进度和成绩](docs/assets/screenshots/history-en.png)](docs/assets/screenshots/history-en.png) |

## 先体验：无需配置模型

[安装 PractiQ](#安装)后：

1. “我的题库”为空时，点击**添加示例题库**；也可以依次打开**设置 → 导入与恢复 → 导入题库 ZIP**，导入 [sample.zip](app/fixtures/sample.zip)。更多示例：[复合题](app/fixtures/composite.zip)、[全题型](app/fixtures/all-types.zip)。
2. 打开题库并点击**开始练习**，体验即时反馈练习、不限时自测或限时模考。
3. 提交作答，查看评分和解析。

全程不需要 API Key；示例只用于展示题型和待复核标记。

在题库卡片的菜单中选择导出，即可分享题目而不包含你的作答和评分。导入题库 ZIP 会把内容追加到现有题库，恢复完整备份则会在确认后替换个人数据。详见[练习指南（英文）](docs/guides/practice-guide.md)和[题库包指南](docs/guides/question-bank-package.md)。

## 用 AI 导入文档

文档导入在自建 AI 服务的网页中完成：

1. [启动服务](#自建导入服务)，打开网页并填写服务访问令牌（`AI_SERVICE_TOKEN`）。
2. 一次最多选择 10 份文件，点击**开始导入**。只选择文件不会上传或解析。
3. 检查题目、图片和需要复核的内容，然后下载题库 ZIP。
4. 在桌面应用中打开**设置 → 导入与恢复 → 导入题库 ZIP**。

服务通过腾讯云的[异步多模态文档解析](https://cloud.tencent.com/document/product/866/139312)读取 **PDF、TXT、Markdown、PNG/JPEG、DOC、DOCX、PPT、PPTX、XLS 和 XLSX**。腾讯云在首次开通时赠送 **1,000 页免费额度，有效期一年**。

查看和下载结果不会调用模型；继续、重试或重新解析可能产生供应商费用。请在 **180 天**内下载需要保留的结果，任务过期不影响已导入的题库。详见[导入任务指南](docs/guides/import-tasks.md)。

## 用 AI 批改主观题

打开**设置 → AI 服务**，选择**直连模型 API**，填写兼容 OpenAI 的 API 地址（包含 `/v1` 或供应商要求的基础路径）、模型 ID 和自己的 API Key。离线练习和本地判分不需要这些设置。

批改需要参考答案或评分细则，可能产生费用，并会把当前题目、材料、图片和你的作答发送给所选供应商。每次操作最多请求一次，结果不明时不会自动重发。密钥保存在系统凭据存储中，不会进入备份。详见[练习指南（英文）](docs/guides/practice-guide.md)中的批改限制与重试规则。

## 安装

PractiQ 目前需要从源码安装。你不需要自己敲命令：打开仓库根目录，让 AI 编程助手按下面的提示安装。

> 阅读 `docs/guides/installation.md`，在这台电脑上安装 PractiQ。先检查环境要求，只执行适合我系统的步骤，完成后告诉我执行了哪些命令、安装包在哪里，以及哪些步骤失败。安装系统软件前先问我。

[安装指南（英文）](docs/guides/installation.md)包含环境要求、命令和检查步骤。应用支持 macOS 14+（Apple Silicon）；Linux 仅用于运行 AI 服务和 CI。

PractiQ 仍在开发中：这些步骤只在本机构建，构建通过也不代表已经完成签名发布。已发布的安装包（如有）见 [GitHub Releases](https://github.com/shenyankm/PractiQ/releases)。

桌面数据保存在新的 `v4/` 目录中。旧目录原样保留，旧版完整备份不再接受，当前格式的题库 ZIP 仍可导入。详见[数据格式说明](docs/reference/question-model.md#versions-and-directories)。

## 自建导入服务

文档导入需要自建 AI 服务，需要 Python 3.14+、uv、Node.js 22.12+、PostgreSQL、RabbitMQ，以及支持文字和图片输入的模型。[安装指南（英文）](docs/guides/installation.md)和[个人自托管指南](server/docs/personal-use.md)说明部署与升级；模型配置由你提供，费用直接支付给供应商，PractiQ 不提供计费。

## 文档与开发

先看[文档索引（英文）](docs/README.md)，其中有[题型模型](docs/reference/question-model.md)、[文档任务 API](server/docs/document-tasks.md)、[部署与运维](server/docs/operations.md)和贡献指南。按改动的部分运行 `make app-check`、`make web-check` 或 `make verify`；Playwright 覆盖应用的双语交互，使用模拟原生命令，不调用模型：

```sh
cd app
npx playwright install chromium --only-shell
npm run test:browser
```

## 获取帮助与参与贡献

请通过 [GitHub Issues](https://github.com/shenyankm/PractiQ/issues/new/choose) 报告可复现的问题或提出改进建议。代码和文档贡献请阅读[贡献指南](CONTRIBUTING.md)，安全漏洞请按[安全策略](SECURITY.md)私下报告。

项目源码使用 [MIT 许可证](LICENSE)，内置依赖保留各自的[上游许可声明](app/licenses/README.md)。
