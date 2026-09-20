<p align="center">
  <img src="app/src-tauri/icons/icon.png" width="160" alt="PractiQ logo">
</p>

# PractiQ

English | [简体中文](README.zh-CN.md)

Turn documents into question banks, then practise and take mock exams on your Mac.

PractiQ combines an offline desktop practice app with a self-hosted AI service. Import an existing PractiQ JSON file without model access, or configure text and vision models to extract questions from documents. Build tests across question banks, review your answers, and request AI scoring for supported short-answer questions.

## Practise with your own materials

Use the desktop app to manage questions and review your progress:

| Task | What you can do |
| --- | --- |
| Import questions | Parse PDF, TXT, CSV, and PNG/JPEG files, or import PractiQ JSON with its local images |
| Organize question banks | Edit questions, search, bookmark, and copy multiple banks into a new bank while keeping the originals |
| Practise offline | Answer single-choice, multiple-choice, true/false, fill-in-the-blank, short-answer, ordering, and matching questions |
| Build a test | Select across banks by question type, mistakes, bookmarks, or unanswered questions; use counts, type quotas, or manual selection |
| Take a mock exam | Preview point values, set a time limit, and reveal answers after submission |
| Review scores | Check local objective scores, request AI short-answer scores, or record a manual score with a reason |
| Keep your records | Resume practice, revisit history, and back up question banks, images, attempts, and scores |

Practice, tests, local objective scoring, and manual scoring work offline. Document parsing and AI scoring send content to your configured model provider and may incur charges. Start or resume those actions explicitly; reopening the desktop app does not resume model calls.

## Import documents and review results

Open **导入题库** (Import question bank) in the desktop sidebar. Choose a PractiQ `.json` file for offline import, or select a source document and start parsing. Review the extracted questions, images, and warnings before creating a bank or appending to one.

The parser accepts these source formats:

| Format | Supported files |
| --- | --- |
| Text and question lists | `.txt`, `.csv` |
| Digital or scanned papers | `.pdf` |
| Screenshots and photographs | `.png`, `.jpg`, `.jpeg` |

Export Word files to PDF before importing. Export Excel question lists to CSV, or use PDF to preserve their layout. Source uploads do not accept Word, Excel, WebP, or GIF files.

Parsing preserves source answers, explanations, passages, available score values, rubrics, and image references. It flags missing content instead of generating answers. You can pause tasks, resume them, retry eligible failed units, or accept partial results. Extracted content still needs review.

## Take a test and review scores

Choose **练习 / 自测 / 模考** (Practice / Self-test / Mock exam) from a question bank, then select questions and preview the paper. Tests default to 100 points; you can change the total, allocate points by type, or edit each question's value. Values use 0.01-point increments and must sum to the total.

Self-tests have no time limit. Mock exams default to 60 minutes and support 1–1,440 minutes, with up to 1,000 questions. Closing the app or putting your Mac to sleep does not pause the deadline. When you reopen an expired exam, the app submits the last saved answers.

After submission, objective questions use local scoring. Select **AI 评分 / 继续** (AI scoring / Continue) to score eligible short answers against a reference answer or rubric. Missing evidence and failed calls stay ungraded. Review partial credit and explanations, and record manual corrections when needed.

AI scoring supports personal practice. It is not calibrated for formal examinations. See the [exam acceptance record](app/EXAM_ACCEPTANCE.md) for dated engineering checks, synthetic model tests, and recorded failures.

## Run the desktop app

The current desktop target is Apple Silicon on macOS 14 or later. Development requires Node.js 22.12+, Rust, Xcode, uv, and an existing Python 3.14+ interpreter. Do not create a project `.venv`. Run these commands from the repository root, replacing the Python path with your interpreter:

```sh
make install-locked app-install-python AI_PYTHON=/path/to/python3.14
make app-install
make app-bundle AI_PYTHON=/path/to/python3.14
make app-dev
```

This builds the bundled Python service before starting the desktop app. You do not need model credentials to import JSON and practise offline. Configure the provider URL, text model, vision model, and API key in **设置** (Settings) when you want parsing or AI scoring.

To build a local application package, run:

```sh
make app-build AI_PYTHON=/path/to/python3.14
```

The app stores practice data locally and API keys in macOS Keychain. Backups exclude keys and AI task state. See the [desktop guide](app/README.md) for storage, restore, packaging, and validation details. Windows CI checks do not establish Windows runtime support.

## Run the AI service independently

For API integration, use the same Python 3.14+ interpreter, uv, a dedicated SQLite directory, and text and vision models. Copy the configuration template once without overwriting existing settings:

```sh
cp -n .env.example .env
```

Set the service token, model credentials, both model names, database directory, and file storage in `.env`. Install dependencies, initialize a new database, and start the service:

```sh
make install-locked AI_PYTHON=/path/to/python3.14
make init-db AI_PYTHON=/path/to/python3.14
make server-dev AI_PYTHON=/path/to/python3.14
```

The service listens on `127.0.0.1:8090` and runs one process per database. It uses FastAPI, LangGraph, and SQLite, with local files or private Alibaba Cloud Object Storage Service (OSS) storage. Use authenticated APIs for uploads, document tasks, artifacts, and explicit subjective grading.

## Find the detailed guides

Choose the guide for your task:

- [Desktop guide](app/README.md): import, practice, tests, storage, and backups (Chinese)
- [Service integration](server/docs/service-guide.md): configuration, parsing, grading, and API contracts (Chinese)
- [Document task API](server/docs/document-tasks.md): progress, pause, resume, retry, and review decisions (Chinese)
- [Operations](server/docs/operations.md): deployment, storage, monitoring, and recovery (Chinese)
- [Evaluation](server/docs/evaluation.md): extraction and grading checks, datasets, and evidence limits (Chinese)
- [Contributing](CONTRIBUTING.md): development checks and pull requests
