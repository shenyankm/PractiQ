<p align="center">
  <img src="server/assets/logo/practiq-octopus-a5.png" width="160" alt="PractiQ logo">
</p>

# PractiQ

English | [简体中文](README.zh-CN.md)

**Turn documents into structured questions, ready for review.**

PractiQ is an AI document import service for teams building question banks, educational content tools, and document-processing workflows. It extracts questions, passage-based groups, source answers, and visual assets from text, PDFs, images, Word documents, and Excel workbooks, so you can review and reuse the content in your own application.

## From source files to reusable content

Exam papers, scanned exercises, and spreadsheet question sets often combine text, tables, and illustrations. PractiQ brings them into a shared structure while keeping source references and identifying content that needs review.

| Capability | What it gives you |
| --- | --- |
| Structured extraction | Question stems, options, answer formats, and answers or explanations present in the source. |
| Passage-based groups | Shared reading passages or materials grouped with their questions. |
| Visual content | Page images, embedded illustrations, and supported chart or diagram assets alongside extracted content. |
| Traceable results | Available page, text, or worksheet references to help check results against the original. |
| Explicit uncertainty | Missing-field flags, quality issues, and partial results for review. Missing source answers remain missing. |
| Controllable tasks | Pause and resume work, retry eligible failed units while retaining successful results, or accept a partial result. |
| Usage visibility | Per-call model usage records, including failed calls and cases where usage is unknown. |

## Supported documents

| Format | Typical input |
| --- | --- |
| TXT / CSV | Text exercises and exported question lists. |
| PDF | Digital or scanned papers, including pages with illustrations. |
| Images | Screenshots and photographed exercises. |
| Word (`.docx`) | Teaching materials with page layouts and embedded images. |
| Excel (`.xlsx`) | Worksheets containing cells, anchored images, and supported charts or shapes. |

Word and Excel support applies to `.docx` and `.xlsx`; legacy `.doc` and `.xls` files need conversion first. See the [integration guide](server/docs/service-guide.md) for rendering requirements and format limits.

## How it fits your workflow

**Upload a document → Track extraction → Review results → Use them in your application**

1. **Upload** through the authenticated API and create a document task.
2. **Track** progress, extracted content, and any processing failures.
3. **Review** source references and quality flags. When needed, retry eligible failures or explicitly accept the available result.
4. **Use** structured results and visual assets in your own question bank or editorial workflow.

PractiQ provides a self-hosted API service. Your application supplies the user interface and downstream workflow. Question-bank management, practice grading, answer generation, and learning reports are outside the current product. Extraction results still need content review; engineering tests do not establish model accuracy.

## Get started

You need Python 3.14+, a new empty PostgreSQL 16+ database, and access to text and vision models. Use an existing Python interpreter without a project `.venv`. Word rendering requires LibreOffice Writer; Excel chart and shape rendering requires Calc. Model calls may incur provider charges.

```bash
# First setup only; preserve any existing configuration
cp -n .env.example .env
# Configure the service token, models, database, and file storage in .env
make install AI_PYTHON=/path/to/python3.14
make init-db AI_PYTHON=/path/to/python3.14
make server-dev AI_PYTHON=/path/to/python3.14
```

The service starts at `127.0.0.1:8090`. It uses FastAPI, open-source LangGraph, and PostgreSQL, with local file storage or a private OSS bucket. Text and vision models are both required; document content is sent to the configured model provider. The runtime uses one service process per database.

## Documentation

- [Integration and development guide](server/docs/service-guide.md) — configuration, import flow, format behavior, and CI checks (Chinese).
- [Task API](server/docs/document-tasks.md) — task creation, progress, pause/resume, retry, and review decisions (Chinese).
- [Operations](server/docs/operations.md) — deployment, storage, monitoring, and recovery (Chinese).
- [Evaluation](server/docs/evaluation.md) — datasets, model-quality checks, and evidence limits (Chinese).
- [Contributing](CONTRIBUTING.md) — development checks and contribution guidelines.
