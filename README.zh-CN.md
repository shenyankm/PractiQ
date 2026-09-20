<p align="center">
  <img src="server/assets/logo/practiq-octopus-a5.png" width="160" alt="PractiQ 标志">
</p>

# PractiQ

[English](README.md) | 简体中文

把文档整理成题库，在 Mac 上练习、自测和模考。

PractiQ 包含离线桌面练习应用和可独立部署的 AI 服务。你可以直接导入已有 PractiQ JSON，也可以配置文本与视觉模型，从文档中提取题目。导入后，跨题库组卷、复习作答，并按需使用 AI 为符合条件的简答题评分。

## 用自己的资料练习

桌面应用支持以下操作：

| 任务 | 可以做什么 |
| --- | --- |
| 导入题目 | 解析 PDF、TXT、CSV、PNG/JPEG，或导入 PractiQ JSON 和本地图片 |
| 整理题库 | 编辑、搜索、收藏题目，将多个题库复制合并为新库并保留原库 |
| 离线练习 | 练习单选、多选、判断、填空、简答、排序和匹配七种题型 |
| 自定义组卷 | 跨题库按题型、错题、收藏或未做题筛选，按总量、题型配额或手动选题 |
| 限时模考 | 预览配分、设置时限，交卷后统一查看答案 |
| 复核评分 | 查看客观题本地判分，主动请求 AI 简答题评分，或填写原因后人工改分 |
| 保存记录 | 断点续练、查看历史，备份题库、图片、作答和评分 |

练习、自测、模考、客观题判分和人工评分均可离线使用。文档解析与 AI 评分会把内容发送给你配置的模型提供方，可能产生费用。只有主动开始或继续这些操作才会调用模型，重新打开桌面应用不会自动恢复模型调用。

## 导入文档并复核题目

打开桌面左侧的**导入题库**。选择 PractiQ `.json` 可离线导入；选择原文档并开始解析后，先检查题目、图片和警告，再新建题库或追加到已有题库。

解析支持以下源文件：

| 格式 | 支持的文件 |
| --- | --- |
| 文本和题目清单 | `.txt`、`.csv` |
| 电子或扫描试卷 | `.pdf` |
| 截图和拍摄图片 | `.png`、`.jpg`、`.jpeg` |

Word 文件请先导出为 PDF。Excel 题目清单请导出为 CSV；需要保留排版时导出为 PDF。源文档上传不接受 Word、Excel、WebP 或 GIF。

解析保留原文答案、解析、共用材料、可提取的分值、评分细则和图片引用。缺失内容会标记待复核，不通过解题补答案。你可以暂停、恢复任务，补跑符合条件的失败单元，或接受部分结果；提取内容仍需核对。

## 组卷、考试与评分

从题库页选择**练习 / 自测 / 模考**，筛选题目后生成试卷预览。考试默认总分为 100 分；你可以调整总分、按题型分配分值，或逐题修改。分值精确到 0.01 分，逐题之和必须等于总分。

自测不限时。模考默认 60 分钟，可设置 1–1440 分钟，最多选择 1000 题。关闭应用或让 Mac 休眠都不会暂停截止时间；重新进入已超时的考试时，应用按最后成功保存的答案交卷。

交卷后，客观题在本地判分。点击 **AI 评分 / 继续**，才会根据参考答案或评分细则评阅符合条件的简答题。缺少依据或调用失败的题目保持未判定。你可以查看部分得分及理由，并按需人工改分。

AI 评分用于个人练习，尚未经过正式考试阅卷校准。[考试验收记录](app/EXAM_ACCEPTANCE.md) 区分了对应版本的工程检查、合成样本模型测试和失败记录。

## 运行桌面应用

当前桌面目标为 Apple Silicon Mac，最低系统版本为 macOS 14。开发需要 Node.js 22.12+、Rust、Xcode、uv 和已有 Python 3.14+ 解释器，不创建项目 `.venv`。从仓库根目录执行以下命令，并把 Python 路径替换为你的解释器：

```sh
make install-locked app-install-python AI_PYTHON=/path/to/python3.14
make app-install
make app-bundle AI_PYTHON=/path/to/python3.14
make app-dev
```

命令会先构建内置 Python 服务，再启动桌面应用。导入 JSON 和离线练习无需模型凭据。需要解析或 AI 评分时，在**设置**中填写服务地址、文本模型、视觉模型和 API Key。

构建本地应用安装包：

```sh
make app-build AI_PYTHON=/path/to/python3.14
```

练习数据保存在本机，API Key 存在 macOS 钥匙串中。备份不含密钥或 AI 任务状态。存储、恢复、打包和验证步骤见[桌面指南](app/README.md)。Windows CI 检查不代表已支持 Windows 原生运行。

## 独立运行 AI 服务

接入 API 时，需要同样的 Python 3.14+ 解释器、uv、专用 SQLite 目录，以及文本与视觉模型。首次复制配置模板，保留已有设置：

```sh
cp -n .env.example .env
```

在 `.env` 中设置服务令牌、模型凭据、两种模型名称、数据库目录与文件存储，然后安装依赖、初始化新数据库并启动服务：

```sh
make install-locked AI_PYTHON=/path/to/python3.14
make init-db AI_PYTHON=/path/to/python3.14
make server-dev AI_PYTHON=/path/to/python3.14
```

服务监听 `127.0.0.1:8090`，每个数据库只运行一个服务进程。服务使用 FastAPI、LangGraph 和 SQLite，文件存于本地或私有阿里云对象存储（OSS）。上传、文档任务、素材读取和主动请求的主观题评分均使用鉴权 API。

## 查找详细说明

按当前任务选择文档：

- [桌面指南](app/README.md)：导入、练习、考试、存储与备份
- [服务接入](server/docs/service-guide.md)：配置、解析、评分与接口契约
- [文档任务 API](server/docs/document-tasks.md)：进度、暂停、恢复、补跑与人工决策
- [部署与运维](server/docs/operations.md)：部署、存储、监控与恢复
- [效果评测](server/docs/evaluation.md)：提取与评分检查、数据集和证据边界
- [参与贡献](CONTRIBUTING.md)：开发检查与提交规范
