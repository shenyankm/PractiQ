<p align="center">
  <img src="app/src-tauri/icons/icon.png" width="160" alt="PractiQ logo">
</p>

# PractiQ

[English](README.md) | 简体中文

把文档变成题库，在桌面端离线练习、自测和模考。

- **导入与复核**：用 AI 提取文档中的题目，检查质量提示，整理题库。
- **练习与组卷**：跨题库按题型、错题、收藏或未做题筛选，进行练习、自测或限时模考。
- **查看评分**：客观题本地判分，简答题可主动请求 AI 评分，也可人工改分。
- **保存与分享**：断点续练、备份个人记录，将题库连同图片和音频导出为 ZIP 分享。

应用支持简体中文和英文、明暗主题、七种基础题型，以及英语听力、阅读、完形填空、翻译和写作等题型。练习数据保存在本机，无需账号，不提供云同步。

## 先体验：无需配置模型

[运行桌面应用](#运行桌面应用)后：

1. “我的题库”为空时，点击**添加示例题库**；也可通过**设置 → 恢复备份 → 导入题库 ZIP** 导入 [sample.zip](app/fixtures/sample.zip)。
2. 打开题库，选择**开始练习**，体验即时反馈练习、不限时自测或限时模考。
3. 提交作答，查看评分和解析。

全程无需 API Key。人工编写的样例用于展示题型和待复核标记，不代表模型效果。更多样例：[复合题](app/fixtures/composite.zip)、[全题型](app/fixtures/all-types.zip)。

从题库卡片菜单导出 ZIP，可分享题目而不包含个人作答和评分。导入题库会追加内容；恢复完整学习数据备份会在确认后替换个人数据。详见[题库包指南](docs/question-bank-package.md)。

## 用 AI 导入文档

1. 在**设置**中填写支持文本及图片输入的模型服务地址、模型 ID 和 API Key，离开输入框时自动保存。
2. 打开**导入题库**，选择源文件并确认解析。
3. 检查题目、图片和警告，再新建题库或追加到已有题库。

支持 **PDF、TXT、CSV 和 PNG/JPEG**。Word 和 Excel 需要本机安装含 Writer、Calc 的 [LibreOffice](https://www.libreoffice.org/download/download-libreoffice/)，由桌面端默认转为 PDF；本地转换和导出无需模型。独立服务不接受 Office 文件。文本导出方式及限制见[转换指南](server/docs/desktop-office.md)。

解析只提取原文已有的答案和评分细则，不替缺答案的题目解题；缺失内容保留待复核标记。任务支持暂停、恢复、重试和接受部分结果。需要保留的结果请在 **180 天**内导入题库，任务到期不影响已导入题库。

练习和本地判分可离线使用。解析与 AI 评分需要主动触发，会将内容发送给你配置的模型提供方，可能产生费用；重新打开应用不会自动恢复模型调用。AI 评分须有参考答案或评分细则，缺少依据或调用失败时保持未判定，仅用于个人练习，不作为正式考试阅卷依据。

API Key 保存在系统凭据存储中，备份不含密钥和 AI 任务状态。限时模考在关闭应用或电脑休眠后仍继续计时，重新进入超时考试时按最后保存的答案交卷。

## 运行桌面应用

桌面构建目标包括 macOS 14+（Apple Silicon）、Windows 10/11（x64）和 Ubuntu 22.04+（x64，`.deb`）。macOS 已完成本地验证；Windows 和 Linux 已配置构建与内置服务 CI 检查，仍需在对应系统完成桌面交互验收。

开发需要 Node.js 22.12+、Rust、uv 和已有 Python 3.14+ 解释器。请安装 [Tauri 对应平台的前置依赖](https://v2.tauri.app/start/prerequisites/)：macOS 使用 Xcode，Windows 使用 MSVC 构建工具和 WebView2，Linux 使用 WebKitGTK 4.1、`libdbus-1-dev` 及构建库。Linux 保存 API Key 还需要已解锁的 Secret Service 服务（如 GNOME Keyring），听力播放需要 GStreamer 音频插件。不创建项目 `.venv`。请在目标系统上构建，以打包对应平台的 Python 服务。

在 macOS 或 Linux 上，从仓库根目录执行以下命令，并把 Python 路径替换为你的解释器：

```sh
make install-locked app-install-python AI_PYTHON=/path/to/python3.14
make app-install
make app-bundle AI_PYTHON=/path/to/python3.14
make app-dev
```

构建本地应用安装包：

```sh
make app-build AI_PYTHON=/path/to/python3.14
```

Windows 使用 PowerShell，从仓库根目录执行：

```powershell
uv export --project server --locked --extra dev --extra desktop --no-emit-project -o "$env:TEMP/practiq-requirements.txt"
uv pip install --python (Get-Command python).Source -r "$env:TEMP/practiq-requirements.txt"
uv pip install --python (Get-Command python).Source --no-deps -e server
python app/scripts/bundle-python.py
cd app
npm ci
npm run desktop
# 构建 Windows 安装包：
npm run tauri -- build
```

构建产物位于 `app/src-tauri/target/release/bundle`：macOS 为 `.app`/`.dmg`，Windows 为 NSIS `.exe`，Linux 为 `.deb`。CI 使用模拟模型响应和真实 PDF 渲染检查各平台打包后的 Python 服务，不代表已验证安装包签名或桌面音频播放。

## 独立运行 AI 服务

接入 API 需要 Python 3.14+、uv，以及支持文本及图片输入的模型。复制配置模板，保留已有设置：

```sh
cp -n .env.example .env
```

在 `.env` 中设置服务令牌、模型凭据、`LLM_MODEL`、数据库目录和文件存储，再初始化新数据库并启动：

```sh
make install-locked AI_PYTHON=/path/to/python3.14
make init-db AI_PYTHON=/path/to/python3.14
make server-dev AI_PYTHON=/path/to/python3.14
```

FastAPI/LangGraph 服务监听 `127.0.0.1:8090`，使用 SQLite 和本地文件存储，每个数据库只运行一个进程。上传、任务、素材和评分接口均需鉴权，详见[服务指南](server/docs/service-guide.md)。

## 文档与开发

- [文档任务 API](server/docs/document-tasks.md)：进度、暂停、恢复、重试与复核
- [部署与运维](server/docs/operations.md)：部署、存储与恢复
- [效果评测](server/docs/evaluation.md)：数据集、检查与证据边界
- [题型模型](docs/question-model.md)：题型与复合题规则
- [首版发布说明草案](docs/first-release.md)：范围与发布前待确认项
- [参与贡献](CONTRIBUTING.md)：开发检查与提交规范

桌面检查运行 `make app-check`，AI 服务检查运行 `make verify`。浏览器检查模拟原生命令，不调用模型：

```sh
cd app
npx playwright install chromium --only-shell
npm run test:browser
```
