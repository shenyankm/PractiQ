<p align="center">
  <img src="app/src-tauri/icons/icon.png" width="160" alt="PractiQ logo">
</p>

# PractiQ

English | [简体中文](README.zh-CN.md)

Turn documents into question banks, then practise and take mock exams on your desktop.

PractiQ combines an offline desktop practice app with a self-hosted AI service. Import an existing PractiQ bank ZIP without model access, or configure a model supporting text and image inputs to extract questions from documents. Build tests across question banks, review your answers, and request AI scoring for supported short-answer questions.

## 🎯 Who it is for and what it solves

- **Students and independent learners**: turn your papers, handouts, and question lists into reusable banks, then revisit mistakes and bookmarks.
- **Teachers and material organizers**: review questions and distribute a question-bank ZIP so recipients can practise offline.
- **Developers**: run the AI service independently to integrate document extraction into your tools.

PractiQ focuses on your materials, reviewable question banks, and local practice and mock exams. It does not include courses, a public question-bank marketplace, accounts, cloud sync, or online collaboration. Question files can be shared; each person's answers and scores stay on their device. Parsing extracts supplied answers without solving unanswered questions.

## 🚀 Try it without a model

First follow [Run the desktop app](#run-the-desktop-app). If you already have the app, start at step 1:

1. Open **Settings → Restore backup → Import bank ZIP** and select [sample.zip](app/fixtures/sample.zip) from this repository.
2. The app reads the included images automatically; no separate image folder is needed.
3. Review the preview and create a bank. The sample contains nine questions across seven basic types, formulas, a table, and an image. One question deliberately lacks an answer to demonstrate the review flag.
4. Open the bank and start practice. Answer questions and view explanations, then try a self-test or timed mock exam and review local scoring after submission.

This is a hand-written walkthrough sample, not a customer case study or a model evaluation. No API key is needed; model calls require an explicit parsing or AI grading action. Try the [composite question sample](app/fixtures/composite.zip) for reading comprehension, word-bank, and cloze questions.

When **My banks** is empty, choose **Add example bank** to load the bundled [all-types sample](app/fixtures/all-types.zip) directly. It includes English question types, an image, and listening chimes, and requires no model configuration.

### 📦 Sharing question files

Choose **Export bank ZIP** in a bank card's menu and send the package to a classmate. Recipients import the ZIP with its images and audio and keep their own practice records. Packages preserve answers, explanations, materials, and review flags, but exclude bookmarks, mistakes, personal answers, and scores. Missing or damaged referenced images or audio prevent export; existing destination files are never overwritten.

**Learning-data backup ZIPs** include personal records for recovery. **Question-bank ZIPs** contain shareable content. Both are available under **Settings → Restore backup**, with separate options for bank import and full restoration. The app rejects packages opened through the wrong option. See the [package guide](docs/question-bank-package.md).

See the [first-release draft](docs/first-release.md) for scope, concise release notes, and outstanding release checks.

## 📚 Practise with your own materials

The desktop app supports the following tasks:

| Task | What you can do |
| --- | --- |
| Import questions | Parse PDF, TXT, CSV, and PNG/JPEG files, or import a PractiQ ZIP containing questions and images |
| Organize question banks | Edit questions, search, bookmark, and copy multiple banks into a new bank while keeping the originals |
| Practise offline | Answer seven basic question types and English listening, reading comprehension, word-bank, cloze, grammar fill, sentence selection, paragraph matching, translation, and writing questions |
| Build a test | Select across banks by question type, mistakes, bookmarks, or unanswered questions; use counts, type quotas, or manual selection |
| Take a mock exam | Preview point values, set a time limit, and reveal answers after submission |
| Review scores | Check local objective scores, request AI short-answer scores, or record a manual score with a reason |
| Keep your records | Resume practice, revisit history, and back up question banks, images, audio, attempts, and scores |

Practice, tests, local objective scoring, and manual scoring work offline. Document parsing and AI scoring send content to your configured model provider and may incur charges. Start or resume those actions explicitly; reopening the desktop app does not resume model calls.

The desktop supports Simplified Chinese and English. Click **Language** above Settings to choose a language in the menu above the entry. On first launch, Chinese system languages select Simplified Chinese; other languages select English. Your choice is stored locally and included in backups. Each new AI grading request keeps the language selected when you explicitly start it, including when checking that request again. Switching language does not call a model or translate imported content or existing grading feedback.

## 📄 Import documents and review results

Open **Import** in the desktop sidebar. After configuring a model, choose **Choose a document to parse**, select one or more source files, and confirm parsing for each file. Matching file content prompts you to open the existing task or explicitly parse again, which may incur another charge. Saved tasks and results remain readable without model credentials; new parsing and AI grading require a configured model.

Review the extracted questions, images, and warnings before creating a bank or appending to one. Batch import can create a bank per document or append all selected results to one existing bank; an import failure affects only that item. For offline ZIP import, follow the shortcut to **Settings → Restore backup → Import bank ZIP**; this appends content without replacing learning records.

The parser accepts these source formats:

| Format | Supported files |
| --- | --- |
| Text and question lists | `.txt`, `.csv` |
| Digital or scanned papers | `.pdf` |
| Screenshots and photographs | `.png`, `.jpg`, `.jpeg` |

Export Word files to PDF before importing. Export Excel question lists to CSV, or use PDF to preserve their layout. Source uploads do not accept Word, Excel, WebP, or GIF files.

Parsing preserves source answers, explanations, passages, available score values, rubrics, and image references. It flags missing content instead of generating answers. You can pause tasks, resume them, retry eligible failed units, or accept partial results. Use **Show only items needing review** and the next-item action to inspect flagged questions and their source pages or text segments where available. Accepting partial results keeps quality flags, and unreviewed questions can still be practised.

AI tasks expire 180 days after creation; the task list shows the retention date for results not yet imported. Import the results you want to keep into a bank before that date. Task expiry does not remove imported banks.

## 📝 Take a test and review scores

Choose **Start practice** from a question bank, then select practice, an untimed self-test, or a timed mock exam. For tests, select questions and preview the paper. Tests default to 100 points; you can change the total, allocate points by type, or edit each question's value. Values use 0.01-point increments and must sum to the total.

Composite questions always stay together: total counts use answerable subquestions, while manual selection distinguishes groups from subquestions. The setup picks a feasible default and suggests nearby counts when your requested total cannot be formed from complete groups.

Starting practice or an exam from a bank gives the session a title with its source bank, mode, and question count. The home page offers the most recently active unfinished session; history can be filtered by in-progress, awaiting-review, and finished sessions. Exams show saved draft progress and the remaining time. Choose the bank menu's unattempted-question action or **Continue with more unattempted questions** after submission to move to another batch from the source banks.

Self-tests have no time limit. Mock exams default to 60 minutes and support 1–1,440 minutes, with up to 1,000 questions. Closing the app or putting your Mac to sleep does not pause the deadline. When you reopen an expired exam, the app submits the last saved answers.

After submission, objective questions use local scoring. Select **Start/resume AI grading** to score eligible short answers against a reference answer or rubric. Missing evidence and failed calls stay ungraded. Review partial credit and explanations, and record manual corrections when needed.

Partial credit is labelled separately from a wrong answer; the mistakes list includes questions below full credit. Ungraded AI results display the reason and review notes, and an unknown result can be checked before explicitly requesting a new paid grade.

Ending ordinary practice locks answers, but eligible submitted responses can still be self-assessed against the reference. Fill-in feedback compares each blank, trimming surrounding whitespace while preserving case and punctuation; self-assessment keeps the original automatic result and answer snapshot.

AI scoring supports personal practice. It is not calibrated for formal examinations.

## Run the desktop app

Desktop build targets are macOS 14+ (Apple Silicon), Windows 10/11 (x64), and Ubuntu 22.04+ (x64, `.deb`). macOS has been validated locally; Windows and Linux builds and bundled-service checks are configured in CI, with interactive desktop acceptance still required on those systems.

Development requires Node.js 22.12+, Rust, uv, and an existing Python 3.14+ interpreter. Install the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/): Xcode on macOS, MSVC build tools and WebView2 on Windows, or WebKitGTK 4.1, `libdbus-1-dev`, and build libraries on Linux. Linux also needs an unlocked Secret Service provider (such as GNOME Keyring) for API keys, and GStreamer audio plugins for listening playback. Do not create a project `.venv`. Build on the target OS; packages include its native Python service.

On macOS or Linux, run these commands from the repository root, replacing the Python path with your interpreter:

```sh
make install-locked app-install-python AI_PYTHON=/path/to/python3.14
make app-install
make app-bundle AI_PYTHON=/path/to/python3.14
make app-dev
```

This builds the bundled Python service before starting the desktop app. You do not need model credentials to import ZIP and practise offline. Configure the provider URL, model ID, and API key in **Settings**, then choose **Save and apply**. Editing alone does not change the running service. Applying changes is blocked during active AI requests or parsing; pause parsing or wait for it to finish first. Parsing and AI scoring share this model, which must support text and image inputs.

If a model or parser change prevents an old task from resuming, you can still inspect its saved results or explicitly parse again with the current model.

To build a local application package, run:

```sh
make app-build AI_PYTHON=/path/to/python3.14
```

On Windows, use PowerShell from the repository root:

```powershell
uv export --project server --locked --extra dev --extra desktop --no-emit-project -o "$env:TEMP/practiq-requirements.txt"
uv pip install --python (Get-Command python).Source -r "$env:TEMP/practiq-requirements.txt"
uv pip install --python (Get-Command python).Source --no-deps -e server
python app/scripts/bundle-python.py
cd app
npm ci
npm run desktop
# To build the Windows installer:
npm run tauri -- build
```

Packages are written under `app/src-tauri/target/release/bundle`: `.app`/`.dmg` on macOS, NSIS `.exe` on Windows, and `.deb` on Linux. CI checks each packaged Python service using synthetic model responses and real PDF rendering; it does not certify installer signing or interactive playback.

The app stores practice data locally and API keys in macOS Keychain, Windows Credential Manager, or Linux Secret Service. Backups exclude keys and AI task state.

## ⚙️ Run the AI service independently

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

The service listens on `127.0.0.1:8090` and runs one process per database. It uses FastAPI, LangGraph, and SQLite, with local persistent file storage. Use authenticated APIs for uploads, document tasks, artifacts, and explicit subjective grading.

## 📖 Find the detailed guides

Choose the guide for your task:

- [Service integration](server/docs/service-guide.md): configuration, parsing, grading, and API contracts
- [Document task API](server/docs/document-tasks.md): progress, pause, resume, retry, and review decisions
- [Operations](server/docs/operations.md): deployment, storage, monitoring, and recovery
- [Evaluation](server/docs/evaluation.md): extraction and grading checks, datasets, and evidence limits
- [Contributing](CONTRIBUTING.md): development checks and pull requests

Desktop browser regression: `cd app && npx playwright install chromium --only-shell && npm run test:browser` checks bilingual sidebar navigation, import entry points, keyboard focus, and the 960px layout with mocked native commands. It starts Vite on an available loopback port and makes no model calls. Unit/integration coverage for language races, persistence, backup restore and bilingual workflows runs in `make app-check`.

See the [question model](docs/question-model.md) for question-type contracts, normalized SQLite tables, and composite question rules.
