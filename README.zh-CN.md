<p align="center">
  <img src="server/assets/logo/practiq-octopus-a5.png" width="160" alt="PractiQ logo">
</p>

# PractiQ

[English](README.md) | 简体中文

**把文档转为可复核、可复用的结构化题目。**

PractiQ 是面向题库、教学内容工具和文档处理流程的 AI 文档导入服务。从文本、CSV、PDF、图片 中提取题目、材料题组、原文答案与视觉素材，帮助你核对内容，并接入自己的应用。

## 从原始文档到可用内容

试卷、扫描习题和文本题目清单，往往混合着文字、表格与配图。PractiQ 将这些内容整理为统一结构，保留可用的来源信息，并明确标记需要复核的部分。

| 核心能力 | 你能得到什么 |
| --- | --- |
| 结构化提题 | 提取题干、选项、作答形式，以及原文已有的答案和解析。 |
| 材料题组 | 将共用阅读材料或背景信息的题目组织在一起。 |
| 视觉素材 | 直接解析 PDF 页图及 PNG/JPEG 图片，保留裁剪出的配图、图表素材，供后续查看与使用。 |
| 来源追溯 | 提供可用的页码、文本或工作表来源，方便对照原文核查。 |
| 待复核标记 | 明确返回缺失字段、质量问题和部分结果；原文没有答案时保留缺失。 |
| 可控任务 | 支持暂停、恢复、补跑可重试的失败单元或接受部分结果，保留已成功的内容。 |
| 用量记录 | 按次记录模型调用用量，包含失败调用，并明确标识未知用量。 |

## 支持哪些文档

| 格式 | 典型内容 |
| --- | --- |
| TXT / CSV | 文本习题、导出的题目清单。 |
| PDF | 电子试卷、扫描试卷，以及包含插图的页面。 |
| 图片 | 题目截图、拍摄的习题图片。 |

暂不支持 Word（`.doc`、`.docx`）。Word 排版可能随字体和软件变化，PDF 能固定页面布局，更适合识别。请在 Word 或 WPS 中“导出为 PDF”或“另存为 PDF”后上传。格式限制见 [接入指南](server/docs/service-guide.md)。

桌面左侧“导入题库”统一提供已有 PractiQ `.json` 导入、文档解析和任务管理。JSON 导入无需模型配置。文档支持 `.pdf`、`.txt`、`.csv`、`.png`、`.jpg`、`.jpeg`。

## 如何融入你的工作流

**上传文档 → 跟踪提取进度 → 复核结果 → 接入自己的应用**

1. **上传**：通过鉴权 API 上传文件，创建文档任务。
2. **跟踪**：查询处理进度、提取内容与失败明细。
3. **复核**：结合来源信息与质量标记核对结果，按需补跑可重试单元，或明确接受已有结果。
4. **使用**：将结构化结果和视觉素材接入自己的题库或内容整理流程。

PractiQ 包含独立部署的 AI 服务和离线桌面刷题应用。桌面应用将 AI 解析结果导入 SQLite，提供题库管理、练习判分、收藏、错题、历史记录及完整备份；离线练习无需 AI 服务，原文档解析按需启动内置 Python 服务。AI 答案生成和学习报告仍不在范围内。提取结果仍需内容复核，工程测试通过不代表模型识别准确率已达标。

## 快速开始

准备 Python 3.14+、专用本地 SQLite 目录，以及可用的文本和视觉模型。使用已有 Python 解释器，不创建项目 `.venv`。模型调用可能产生提供方费用。

```bash
# 仅首次复制，保留已有配置
cp -n .env.example .env
# 在 .env 中配置服务令牌、模型、数据库与文件存储
make install AI_PYTHON=/path/to/python3.14
make init-db AI_PYTHON=/path/to/python3.14
make server-dev AI_PYTHON=/path/to/python3.14
```

服务默认运行于 `127.0.0.1:8090`，使用 FastAPI、开源 LangGraph 与 SQLite，文件可存于本地或私有 OSS Bucket。文本与视觉模型均需配置，文档内容会发送给所配置的模型提供方。同一数据库由单个服务进程运行。

## 进一步了解

- [接入与开发指南](server/docs/service-guide.md)：环境配置、导入流程、格式行为与 CI 检查。
- [任务 API](server/docs/document-tasks.md)：创建任务、查询进度、暂停恢复、补跑与人工决策。
- [部署与运维](server/docs/operations.md)：部署、存储、监控与恢复。
- [效果评测](server/docs/evaluation.md)：评测数据、模型质量验证与证据边界。
- [参与贡献](CONTRIBUTING.md)：开发检查与贡献规范。


## 离线桌面刷题应用（macOS 实验版）

新增独立 `app/`，使用 Tauri 2 + React + Vite + shadcn/ui + TypeScript + SQLite。支持导入 AI 解析 JSON 和本地图片、题库与题目管理、七种题型练习、错题与收藏、断点续练、历史记录和完整备份恢复。离线练习无需服务；文档解析按需启动内置 Python 服务；仅适配桌面端，iOS、Android 后续另行规划。

```sh
make app-install
make app-dev
make app-check AI_PYTHON=/path/to/python3.14
make app-install-python AI_PYTHON=/path/to/python3.14
make app-build AI_PYTHON=/path/to/python3.14
```

需要 Node.js 22.12+、当前稳定 Rust 和 Xcode。详见[桌面应用说明](app/README.md)。桌面按需启动内置 Python 服务；题库与解析任务使用独立 SQLite 文件。待复核题可直接练习，应用不生成参考答案。
