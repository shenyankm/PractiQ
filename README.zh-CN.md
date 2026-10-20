<p align="center">
  <img src="app/src-tauri/icons/icon.png" width="160" alt="PractiQ logo">
</p>

# PractiQ

[English](README.md) | 简体中文 | [繁體中文（台灣）](README.zh-TW.md)

把文档变成题库，在 macOS、Windows 或 Android 上离线练习、自测和模考。

- **导入与复核**：用 AI 提取文档中的题目，检查质量提示，整理题库。
- **练习与组卷**：跨题库按题型、错题、收藏或未做题筛选，进行练习、自测或限时模考。
- **查看评分**：客观题本地判分，简答题可主动请求 AI 评分，也可人工改分。
- **保存与分享**：断点续练、备份个人记录，将题库连同图片和音频导出为 ZIP 分享。

应用支持简体中文和英文、明暗主题、七种基础题型，以及英语听力、阅读、完形填空、翻译和写作等题型。离线练习数据保存在本机，无需账号，不提供云同步。独立 Web 导入服务使用个人自托管服务的访问令牌，不提供用户管理或内置计费。

首次启动按系统语言偏好选择支持的语言，也可从侧边栏切换。语言选择保存在本机并包含在完整备份中，保存失败后可重试；日期和数字使用与界面语言匹配的系统区域偏好。切换语言会保留题目原文和作答，有可靠语言信息的材料会声明自身语言，供辅助工具使用。AI 评分在开始时记录反馈语言，继续同一次请求会保留该语言。

PractiQ 仍处于开发阶段，请按下方步骤从源码运行；已发布安装包及其限制以 [GitHub Releases](https://github.com/shenyankm/PractiQ/releases) 为准。平台构建检查不代表已完成签名发布或干净系统验收。

## 截图

以下截图均为英文环境下的桌面开发预览，题库名称、描述、题目和练习记录使用人工编写的英文示例。所有数据仅保存在内存中，未输入凭据、上传文件或调用模型。点击图片可查看原图。

| 题库 | 答题 |
| :---: | :---: |
| [![英文题库首页，包含示例题库名称和描述](docs/assets/screenshots/banks-en.png)](docs/assets/screenshots/banks-en.png) | [![英文答题页面，包含选项和答题卡](docs/assets/screenshots/practice-en.png)](docs/assets/screenshots/practice-en.png) |
| **错题** | **练习记录** |
| [![英文错题列表，包含得分和所属题库](docs/assets/screenshots/mistakes-en.png)](docs/assets/screenshots/mistakes-en.png) | [![英文练习记录，包含进度和成绩](docs/assets/screenshots/history-en.png)](docs/assets/screenshots/history-en.png) |

## 先体验：无需配置模型

[运行桌面应用](#运行桌面应用)后：

1. “我的题库”为空时，点击**添加示例题库**；也可通过**设置 → 导入与恢复 → 导入题库 ZIP** 导入 [sample.zip](app/fixtures/sample.zip)。更多样例：[复合题](app/fixtures/composite.zip)、[全题型](app/fixtures/all-types.zip)。
2. 打开题库，选择**开始练习**，体验即时反馈练习、不限时自测或限时模考。
3. 提交作答，查看评分和解析。

全程无需 API Key。人工编写的样例用于展示题型和待复核标记，不代表模型效果。

从题库卡片菜单导出 ZIP，可分享题目而不包含个人作答和评分。导入题库会追加内容；恢复完整学习数据备份会在确认后替换个人数据。作答、自评、草稿保护、失败重试、语言设置和主动 AI 评分的详细规则见[练习指南（英文）](docs/guides/practice-guide.md)，导入与备份边界见[题库包指南](docs/guides/question-bank-package.md)。

## 用 AI 导入文档

文档导入在独立 AI 服务的 Web 前端完成：

1. [启动独立 AI 服务](#独立运行-ai-服务)，打开 Web 前端，填写自托管服务的访问令牌（`AI_SERVICE_TOKEN`）。模型配置及供应商密钥留在服务端。
2. 一次选择最多 10 份源文件，主动点击**开始导入**。只选择文件不会上传或调用模型。
3. 查看任务进度、保存的题目、图片、原文答案与待复核提示，下载题库 ZIP。
4. 在桌面 app 中通过**设置 → 导入与恢复 → 导入题库 ZIP**新建题库或追加到已有题库。

服务支持 **PDF、TXT、Markdown、PNG/JPEG、DOC、DOCX、PPT、PPTX、XLS 和 XLSX**，统一使用腾讯云[异步多模态文档解析 `SubmitMultimodalDocParseJob`](https://cloud.tencent.com/document/product/866/139312)，再由 AI 整理题库。腾讯云目前在首次开通时一次性赠送 **1,000 页免费额度，有效期一年**，以[官方额度说明](https://cloud.tencent.com/document/api/866/35945)为准。新导入不再支持 CSV，已保存的数据和题库保留。桌面安装包不内置 Python 服务或 LibreOffice。

默认保留本地目录，通过 Base64 提交，每份输入上限 8 MiB，超限由服务切分；XLS 和大型 Office 切分需要部署 LibreOffice；XLSX 会生成显示隐藏工作表的副本，保留原文件。高级功能私有 COS 中转默认关闭，设置 `AI_TENCENT_COS_ENABLED=true` 并填写 Bucket、地域后，全部输入使用短期签名 URL，本地源文件与结果仍保留。凭据仅配置在服务端；模型端点必须支持 Responses API。详见[腾讯解析配置](server/docs/tencent-document-parser.md)。

任务历史、暂停、中断、恢复、失败单元重试、部分结果复核与重新解析均在 Web 前端处理。读取结果、复核和下载 ZIP 不调用模型；恢复、重试及重新解析须主动触发，可能产生模型供应商费用。项目不再提供账号、积分或充值，模型费用由你直接向供应商支付。详见[导入任务指南](docs/guides/import-tasks.md)及[个人自托管指南](server/docs/personal-use.md)。

解析只提取原文已有答案与评分细则，不替缺答案的题目解题；缺失内容保留待复核标记。请在 **180 天**内下载需要保留的结果，任务到期不影响已导入 app 的题库。

练习和本地判分可离线使用。需要主观题 AI 评分时，在 **设置 → AI 服务** 中选择 **直连模型 API**，填写兼容 OpenAI 的 API 地址（包含 `/v1` 或供应商要求的基础路径）、模型 ID 和自己的 API Key。macOS、Windows 和 Android 共用 Rust `reqwest` 调用 `/chat/completions`，无需部署评分服务，也不依赖 SDK 或 curl。已有部署仍可选择 **独立 AI 服务**，使用原服务地址及令牌。

评分必须有参考答案或细则，会把当前题目快照、相关材料、图片和作答发送给所选模型供应商，可能产生费用。接口须支持 JSON 模式（`response_format: json_object`）和 `max_tokens`；含图题需要视觉模型。每次明确评分最多调用一次，超时 120 秒，输出上限 4,096 token；无效、拒绝或截断结果保持未判定，已有分数与人工改分保留。结果未知时不会自动重发；核对仅返回本地记录，明确重新评分才会创建新的付费请求。测试连接仅读取 `/models`，不验证评分能力。此功能用于个人练习，不作为正式考试阅卷依据。

App API Key 与服务令牌保存在 macOS Keychain、Windows Credential Manager 或 Android Keystore 保护的私有存储中，Web 服务令牌只保存在浏览器内存中。非敏感连接配置沿用 `v4/service-settings-v1.sqlite` 和完整备份恢复机制，不包含凭据，练习数据库仍为 schema 11；旧 schema-11 备份继续支持。保存新模型配置后，旧版本会拒绝读取对应配置文件及备份，请继续使用当前版本。旧模型配置与密钥原样保留，不会自动启用。

限时模考在关闭应用或电脑休眠后仍继续计时，重新进入超时考试时按最后保存的答案交卷。恢复和兼容边界见[数据模型](docs/reference/question-model.md#versions-and-directories)。

开发模式默认使用内存示例数据；预览面板可切换场景或选择真实本地数据，详见[开发预览](app/docs/development-preview.md)。

## 运行桌面应用

桌面数据使用新的 `v4/` 目录和 SQLite schema 11。旧目录（包括 `v3/`）原样保留，旧版完整备份不再接受；当前题库 ZIP 仍可导入。详见[数据格式边界](docs/reference/question-model.md#versions-and-directories)。

app 支持 macOS 14+（Apple Silicon）、Windows 10/11（x64）和 Android 8+（API 26+，arm64 APK）。Linux app 安装包已移除；Linux 仍可作为 AI 服务和 CI 主机。CI 检查 macOS/Windows 安装包、Android APK 与 API 35 模拟器；实体设备、最低系统版本和签名发布仍需分别验收。

开发需要 Node.js 22.12+ 和 Rust。打包准备及共享契约检查还需要 uv 与已有 Python 3.14+ 解释器；Python 仅作为构建工具，不随桌面包分发。请安装 [Tauri 平台前置依赖](https://v2.tauri.app/start/prerequisites/)：macOS 使用 Xcode，Windows 使用 MSVC 构建工具和 WebView2。Android 还需要 JDK 21、SDK 36 和 NDK 28.2.13676358，详见 [Android 指南](app/docs/android.md)。不创建项目 `.venv`。

克隆仓库并进入根目录：

```sh
git clone https://github.com/shenyankm/PractiQ.git
cd PractiQ
```

macOS 从仓库根目录执行，并替换 Python 路径：

```sh
make install-locked AI_PYTHON=/path/to/python3.14
make app-install
cargo fetch --locked --manifest-path app/src-tauri/Cargo.toml
make app-dev AI_PYTHON=/path/to/python3.14
# 构建本地应用安装包：
make app-build AI_PYTHON=/path/to/python3.14
```

Windows 使用 PowerShell：

```powershell
npm --prefix app ci
cargo fetch --locked --manifest-path app/src-tauri/Cargo.toml
python app/scripts/prepare-package.py
cd app
npm run desktop
# 构建 Windows 安装包：
npm run tauri -- build
```

`prepare-package.py` 使用 Python 3.14+，生成构建元数据与 Cargo/npm 许可声明，不下载或复制文档处理运行时。产物位于 `app/src-tauri/target/release/bundle`：macOS 为 `.app`/`.dmg`，Windows 为 NSIS `.exe`。Android APK 使用单独的[构建与模拟器命令](app/docs/android.md)。打包检查验证版本、许可声明及没有内置引擎；它不代表已验证签名或桌面音频播放。

## 独立运行 AI 服务

独立服务通过 Web 前端及 API 提供文档导入，也为桌面 app 提供显式评分。需要 Python 3.14+、uv、用于 Web 构建的 Node.js 22.12+，以及支持文本和图片输入的模型。复制配置模板，保留已有设置：

```sh
cp -n .env.example .env
```

在 `.env` 中设置服务令牌、模型凭据、`LLM_MODEL`、PostgreSQL 连接地址 `DATABASE_URI`、RabbitMQ 专用 vhost 地址 `RABBITMQ_URI` 和文件存储。先创建空的专用 PostgreSQL 数据库，再初始化服务表并启动：

```sh
make install-locked AI_PYTHON=/path/to/python3.14
make init-db AI_PYTHON=/path/to/python3.14
make web-install
make web-build
make server-dev AI_PYTHON=/path/to/python3.14
```

FastAPI/LangGraph 服务监听 `127.0.0.1:8090`，使用 RabbitMQ 投递、PostgreSQL 状态和本地文件存储，每个数据库只运行一个进程。上传、任务、素材和评分接口均需鉴权。打开 `http://127.0.0.1:8090/` 使用已构建的 Web 前端；开发时可另外运行 `make web-dev`，其本机 Vite 服务将 API 请求代理到独立服务。需要 Office 支持时，仅在服务部署端配置 `AI_OFFICE_EXECUTABLE` 与 `AI_OFFICE_VERSION`。详见[服务指南](server/docs/service-guide.md)。

AI 服务 RabbitMQ 部署及升级见[投递与恢复指南](server/docs/rabbitmq.md)。现有服务 schema 1–4 必须停服备份后显式升级到 schema 5；含客户任务或上传记录的旧库须归档后另建个人数据库与存储。

个人自托管服务共用一个访问令牌，不提供账号、积分、充值或支付系统。模型配置与供应商密钥留在服务端，费用直接由模型供应商收取。服务 schema 1–4 须显式离线升级为 5；含客户任务的旧库需完整归档，另建个人数据库与存储目录，避免将客户数据开放给个人令牌。详见[个人自托管与升级指南](server/docs/personal-use.md)。

## 文档与开发

[文档索引（英文）](docs/README.md)区分使用指南、技术参考、验收工作表和历史证据。[题型模型](docs/reference/question-model.md)说明题型与复合题规则，[文档任务 API](server/docs/document-tasks.md)说明任务请求与操作，[部署与运维](server/docs/operations.md)说明部署、存储与恢复。

桌面检查运行 `make app-check`；Android 各开发主机上的共享检查、APK 构建与原生模拟器检查见 [Android 指南](app/docs/android.md)。导入 Web 前端检查运行 `make web-check`，AI 服务检查运行 `make verify`。Playwright Test 覆盖双语交互、浏览器预览和富内容渲染，模拟原生命令，不调用模型：

```sh
cd app
npx playwright install chromium --only-shell
npm run test:browser
```

测试运行器自动启动本机回环地址上的 Vite 服务。失败时，执行轨迹和截图保存在 `app/test-results/browser/`；用 `npx playwright show-trace /path/to/trace.zip` 查看轨迹。

## 获取帮助与参与贡献

通过 [GitHub Issues](https://github.com/shenyankm/PractiQ/issues/new/choose) 报告可复现问题或提出改进建议。代码和文档贡献见[贡献指南](CONTRIBUTING.md)；漏洞请按[安全策略](SECURITY.md)私密报告。质量、发布、用户试用和贡献者工作流的未完成验收要求见[路线图证据记录](docs/maintainers/roadmap-evidence.md)；GitHub 原生路线图与子议题为准。

项目源码使用 [MIT 许可证](LICENSE)，内置依赖保留各自的[上游许可声明](app/licenses/README.md)。
