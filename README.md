<p align="center">
  <img src="server/assets/logo/practiq-octopus-a5.png" width="160" alt="PractiQ logo">
</p>

# PractiQ

AI 文档导入工具：将文本、CSV、PDF、图片、Word 和 Excel 解析为结构化题目、材料题组、原文答案及视觉素材。支持分片解析、部分失败明细与模型调用用量记录。

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

PDF、DOCX 和图片需要视觉模型。DOCX 另需 LibreOffice Writer 和中文字体，可使用 `AI_SOFFICE_PATH` 指定转换程序。

## 导入流程

1. 携带 `Authorization: Bearer <AI_SERVICE_TOKEN>`，调用 `POST /api/uploads` 申请文件引用。
2. 使用返回的地址和 Content-Type 鉴权 PUT 原始文件；已有文件可能直接返回引用。
3. 将 `DocumentReference` 交给对应 Graph，读取运行结果。
4. 使用 `POST /api/artifacts/read` 鉴权读取衍生素材。

支持 `text_csv_parser`、`pdf_parser`、`docx_parser`、`excel_parser`，以及覆盖全部格式的 `document_parser`。原生入口不接受 URL、Base64 或服务器路径；原产品 `/api/v1/ai/*` 接口已移除。

完整接口示例与能力边界见 [AI 使用说明](server/README.md)。

## 验证与数据

```bash
make test AI_PYTHON=/path/to/python3.14
make verify AI_PYTHON=/path/to/python3.14
```

自动化测试不调用真实模型；[评测说明](server/docs/evaluation.md) 和历史报告保留，历史失败结果不代表当前质量基线。

AI 文件默认存放于 `server/.local/ai`，相对 `AI_STORAGE_DIR` 以 `server/` 为基准解析；生产使用持久挂载的绝对路径并备份。精简项目不会迁移或删除已有数据库、卷、文件和本地配置。生产部署参考 [运维说明](server/docs/operations.md) 与 `Dockerfile.server`。
