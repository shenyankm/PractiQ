<p align="center">
  <img src="server/assets/logo/practiq-octopus-a5.png" width="160" alt="PractiQ logo">
</p>

# PractiQ

[English](README.md) | 简体中文

AI 文档导入工具：将文本、CSV、PDF、图片、Word 和 Excel 解析为结构化题目、材料题组、原文答案及视觉素材。支持安全暂停、立即中断、恢复、失败单元补跑、可选人工决策及模型调用用量记录。

代码保留在 `server/`，通过 LangGraph Agent Server 调用；不包含前端、题库管理、练习判分、答案生成或学习报告。

## 本地运行

使用已有 Python 3.14+ 解释器，不创建项目 `.venv`。`AI_PYTHON` 可指定解释器路径。

```bash
# 仅首次复制；已有模型配置不要覆盖
cp -n server/.env.example server/.env
# 编辑 server/.env，配置服务令牌与模型
make install AI_PYTHON=/path/to/python3.14
make server-dev AI_PYTHON=/path/to/python3.14
```

默认监听 `127.0.0.1:8090`，健康检查为 `GET /ok`。本地开发不需要产品数据库或 Docker Compose；`langgraph dev` 不提供生产级任务持久化。

所有格式统一使用必填的 `LLM_VISION_MODEL`，移除 `LLM_TEXT_MODEL`。PDF、DOCX、图片直接由视觉模型提取结构化题目，不再经过 OCR 转写和文本模型二次提题；文本、CSV、Excel 将原始文本交给同一模型。DOCX 另需 LibreOffice Writer 和中文字体，可使用 `AI_SOFFICE_PATH` 指定转换程序。

## 导入流程

1. 携带 `Authorization: Bearer <AI_SERVICE_TOKEN>`，调用 `POST /api/uploads` 申请文件引用。
2. 使用返回的地址和 Content-Type 鉴权 PUT 原始文件；已有文件可能直接返回引用。
3. 将 `document` 与 UUID `requestId` 交给 `POST /api/document-tasks`，通过 `GET /api/document-tasks/{threadId}` 查询；原生 Graph API 继续保留。
4. 使用 `POST /api/artifacts/read` 鉴权读取衍生素材。

支持 `text_csv_parser`、`pdf_parser`、`docx_parser`、`excel_parser`，以及覆盖全部格式的 `document_parser`。原生入口不接受 URL、Base64 或服务器路径；原产品 `/api/v1/ai/*` 接口已移除。

暂停、中断、恢复、补跑、接受部分结果统一调用 `POST /api/document-tasks/{threadId}/control`。请求示例、幂等规则、180 天期限见 [任务控制说明](server/docs/document-tasks.md)。

完整接口示例与能力边界见 [AI 使用说明](server/README.md)。

## 验证与数据

```bash
make test AI_PYTHON=/path/to/python3.14
make verify AI_PYTHON=/path/to/python3.14
```

自动化测试不调用真实模型；[评测说明](server/docs/evaluation.md) 和历史报告保留，历史失败结果不代表当前质量基线。

支持 `AI_STORAGE_BACKEND=local`（默认）和 `oss` 两种模式，共用鉴权上传和素材读取接口，保留大小与 SHA-256 校验。

本地模式下，AI 文件默认存放于 `server/.local/ai`，相对 `AI_STORAGE_DIR` 以 `server/` 为基准解析；生产使用持久挂载的绝对路径并备份。精简项目不会迁移或删除已有数据库、卷、文件和本地配置。生产部署参考 [运维说明](server/docs/operations.md) 与 `Dockerfile.server`。

OSS 模式需在 `server/.env` 配置 `AI_OSS_REGION`、`AI_OSS_BUCKET`、`AI_OSS_ACCESS_KEY_ID` 和 `AI_OSS_ACCESS_KEY_SECRET`；临时 STS 凭证可加 `AI_OSS_SECURITY_TOKEN`。可通过 `AI_OSS_ENDPOINT` 指定 HTTPS 端点；使用已绑定到 Bucket 的自定义域名时，设置 `AI_OSS_USE_CNAME=true`。完整配置见 `server/.env.example`。

使用已有私有 Bucket，仅授予所需对象的访问权限。凭证保留在服务端，文件仍通过鉴权 API 传输。切换模式不自动迁移数据，也不回退到另一种存储；迁移须按原 objectKey 复制并验证全部对象。新版任务拒绝存储位置变化，须在原部署完成或迁移后新建任务；历史 checkpoint 不升级。临时凭证需在过期前更新并重启服务。
