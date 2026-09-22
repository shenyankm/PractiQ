<p align="center">
  <img src="app/src-tauri/icons/icon.png" width="160" alt="PractiQ logo">
</p>

# PractiQ

English | [Simplified Chinese](README.zh-CN.md)

Turn documents into question banks, then practise and take mock exams on your Mac.

PractiQ combines an offline desktop practice app with a self-hosted AI service. Import an existing PractiQ bank ZIP without model access, or configure a model supporting text and image inputs to extract questions from documents. Build tests across question banks, review your answers, and request AI scoring for supported short-answer questions.

## Who it is for and what it solves

- **Students and independent learners**: turn your papers, handouts, and question lists into reusable banks, then revisit mistakes and bookmarks.
- **Teachers and material organizers**: review questions and distribute a question-bank ZIP so recipients can practise offline.
- **Developers**: run the AI service independently to integrate document extraction into your tools.

PractiQ focuses on your materials, reviewable question banks, and local practice and mock exams. It does not include courses, a public question-bank marketplace, accounts, cloud sync, or online collaboration. Question files can be shared; each person's answers and scores stay on their device. Parsing extracts supplied answers without solving unanswered questions.

## Try it without a model

First follow [Run the desktop app](#run-the-desktop-app). If you already have the app, start at step 1:

1. Open **Import → Choose bank ZIP** and select [sample.zip](app/fixtures/sample.zip) from this repository.
2. The app reads the included images automatically; no separate image folder is needed.
3. Review the preview and create a bank. The sample contains nine questions across seven basic types, formulas, a table, and an image. One question deliberately lacks an answer to demonstrate the review flag.
4. Open the bank and start practice. Answer questions and view explanations, then try a self-test or timed mock exam and review local scoring after submission.

This is a hand-written walkthrough sample, not a customer case study or a model evaluation. No API key is needed; model calls require an explicit parsing or AI grading action. Try the [composite question sample](app/fixtures/composite.zip) for reading comprehension, word-bank, and cloze questions.

### Sharing question files

Choose **Export bank ZIP** in a bank card's menu and send the package to a classmate. Recipients import the ZIP with its images and keep their own practice records. Packages preserve answers, explanations, materials, and review flags, but exclude bookmarks, mistakes, personal answers, and scores. Missing or damaged images prevent export; existing destination files are never overwritten.

**Learning-data backup ZIPs** include personal records for recovery. **Question-bank ZIPs** contain shareable content. The app rejects packages opened through the wrong entry point. See the [package guide](docs/question-bank-package.md) (Chinese).

See the [first-release draft](docs/first-release.md) for scope, concise release notes, and outstanding release checks.

## Practise with your own materials

The desktop app supports the following tasks:

| Task | What you can do |
| --- | --- |
| Import questions | Parse PDF, TXT, CSV, and PNG/JPEG files, or import a PractiQ ZIP containing questions and images |
| Organize question banks | Edit questions, search, bookmark, and copy multiple banks into a new bank while keeping the originals |
| Practise offline | Answer seven basic question types plus reading comprehension, word-bank, and cloze groups |
| Build a test | Select across banks by question type, mistakes, bookmarks, or unanswered questions; use counts, type quotas, or manual selection |
| Take a mock exam | Preview point values, set a time limit, and reveal answers after submission |
| Review scores | Check local objective scores, request AI short-answer scores, or record a manual score with a reason |
| Keep your records | Resume practice, revisit history, and back up question banks, images, attempts, and scores |

Practice, tests, local objective scoring, and manual scoring work offline. Document parsing and AI scoring send content to your configured model provider and may incur charges. Start or resume those actions explicitly; reopening the desktop app does not resume model calls.

The desktop supports Simplified Chinese and English. Click **Language** above Settings to choose a language in the menu above the entry. On first launch, Chinese system languages select Simplified Chinese; other languages select English. Your choice is stored locally and included in backups. Switching does not call a model or translate imported questions and answers.

## Import documents and review results

Open **Import** in the desktop sidebar. Choose a PractiQ bank `.zip` file for offline import, or select a source document and start parsing. Review the extracted questions, images, and warnings before creating a bank or appending to one.

The parser accepts these source formats:

| Format | Supported files |
| --- | --- |
| Text and question lists | `.txt`, `.csv` |
| Digital or scanned papers | `.pdf` |
| Screenshots and photographs | `.png`, `.jpg`, `.jpeg` |

Export Word files to PDF before importing. Export Excel question lists to CSV, or use PDF to preserve their layout. Source uploads do not accept Word, Excel, WebP, or GIF files.

Parsing preserves source answers, explanations, passages, available score values, rubrics, and image references. It flags missing content instead of generating answers. You can pause tasks, resume them, retry eligible failed units, or accept partial results. Extracted content still needs review.

## Take a test and review scores

Choose **Start practice** from a question bank, then select practice, an untimed self-test, or a timed mock exam. For tests, select questions and preview the paper. Tests default to 100 points; you can change the total, allocate points by type, or edit each question's value. Values use 0.01-point increments and must sum to the total.

Self-tests have no time limit. Mock exams default to 60 minutes and support 1–1,440 minutes, with up to 1,000 questions. Closing the app or putting your Mac to sleep does not pause the deadline. When you reopen an expired exam, the app submits the last saved answers.

After submission, objective questions use local scoring. Select **Start/resume AI grading** to score eligible short answers against a reference answer or rubric. Missing evidence and failed calls stay ungraded. Review partial credit and explanations, and record manual corrections when needed.

AI scoring supports personal practice. It is not calibrated for formal examinations. See the [exam acceptance record](app/EXAM_ACCEPTANCE.md) for dated engineering checks, synthetic model tests, and recorded failures.

## Run the desktop app

The current desktop target is Apple Silicon on macOS 14 or later. Development requires Node.js 22.12+, Rust, Xcode, uv, and an existing Python 3.14+ interpreter. Do not create a project `.venv`. Run these commands from the repository root, replacing the Python path with your interpreter:

```sh
make install-locked app-install-python AI_PYTHON=/path/to/python3.14
make app-install
make app-bundle AI_PYTHON=/path/to/python3.14
make app-dev
```

This builds the bundled Python service before starting the desktop app. You do not need model credentials to import ZIP and practise offline. Configure the provider URL, model ID, and API key in **Settings**. Parsing and AI scoring share this model, which must support text and image inputs.

To build a local application package, run:

```sh
make app-build AI_PYTHON=/path/to/python3.14
```

The app stores practice data locally and API keys in macOS Keychain. Backups exclude keys and AI task state. See the [desktop guide](app/README.md) for storage, restore, packaging, and validation details. Windows CI checks do not establish Windows runtime support.

## Run the AI service independently

For API integration, use the same Python 3.14+ interpreter, uv, a dedicated SQLite directory, and a model supporting text and image inputs. Copy the configuration template once without overwriting existing settings:

```sh
cp -n .env.example .env
```

Set the service token, model credentials, `LLM_MODEL`, database directory, and file storage in `.env`. Install dependencies, initialize a new database, and start the service:

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

Desktop language regression: `cd app && npx playwright install chromium --only-shell && npm run test:browser` checks the 960px English layout and real keyboard language switching with a mocked Tauri boundary. It starts its own Vite server on port 1420 and makes no model calls. Unit/integration coverage for language races, persistence, backup restore and bilingual workflows runs in `make app-check`.

See the [question model](docs/question-model.md) for question-type contracts, normalized SQLite tables, and composite question rules.
