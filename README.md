<p align="center">
  <img src="app/src-tauri/icons/icon.png" width="160" alt="PractiQ logo">
</p>

# PractiQ

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

Turn documents into question banks, then practise and take mock exams offline on macOS, Windows or Android.

- **Import and review**: pull questions out of documents with AI, check anything that needs a second look, and organise your banks.
- **Practise and test**: choose questions across banks by type, mistakes, bookmarks or unanswered questions, then practise, self-test or run a timed mock exam.
- **Review scores**: score objective questions on your device, ask AI to grade short answers, or adjust marks yourself.
- **Keep and share**: pick up a session where you left off, back up your records, and share a bank with its images and audio as a ZIP file.

PractiQ works in English, Simplified Chinese and Traditional Chinese, with light and dark themes. It covers seven basic question types plus English listening, reading, cloze, translation and writing. Your practice data stays on your device: there is no account and no cloud sync. Document import runs on your own self-hosted service and asks only for its access token; there are no user accounts or built-in billing.

On first launch PractiQ follows your system language and remembers your choice on this device; you can also switch from the sidebar. Your language choice is included in full backups, and dates and numbers follow the regional format that matches the interface language. Switching language never changes question text or your answers.

PractiQ is in development. Install it from source as described in [Install](#install), or check [GitHub Releases](https://github.com/shenyankm/PractiQ/releases) for published packages and their known limitations. A passing build check does not confirm a signed release or a trial on a clean machine.

## Screenshots

These screenshots show the desktop development preview in English, with hand-written sample banks and practice records. All data is held in memory; no credentials, uploads or model calls were used. Click an image to view it at full size.

| Question banks | Practice |
| :---: | :---: |
| [![English question banks with sample titles and descriptions](docs/assets/screenshots/banks-en.png)](docs/assets/screenshots/banks-en.png) | [![English practice question with answer options and answer sheet](docs/assets/screenshots/practice-en.png)](docs/assets/screenshots/practice-en.png) |
| **Mistakes** | **Practice history** |
| [![English mistakes list with scores and source banks](docs/assets/screenshots/mistakes-en.png)](docs/assets/screenshots/mistakes-en.png) | [![English practice history with session progress and results](docs/assets/screenshots/history-en.png)](docs/assets/screenshots/history-en.png) |

## Try it without a model

[Install PractiQ](#install), then:

1. When **My banks** is empty, choose **Add example bank**, or import [sample.zip](app/fixtures/sample.zip) through **Settings → Import and restore → Import bank ZIP**. More examples: [composite questions](app/fixtures/composite.zip) and [all question types](app/fixtures/all-types.zip).
2. Open the bank and choose **Start practice**. Try practice with instant feedback, an untimed self-test or a timed mock exam.
3. Submit your answers and review the scores and explanations.

No API key is needed. The hand-written samples show the question types and review flags; they are not a measure of model quality.

Export a bank from its card menu to share its questions without your answers or scores. Importing a bank ZIP adds to your library; restoring a full learning-data backup replaces your personal data after you confirm. The [practice guide](docs/guides/practice-guide.md) covers submitting answers, draft protection, language settings and optional AI grading, and the [package guide](docs/guides/question-bank-package.md) covers import and backup boundaries.

## Import documents with AI

Document import runs in the Web page of the self-hosted AI service:

1. [Start the AI service](#self-host-the-import-service), open its Web page and enter the service access token (`AI_SERVICE_TOKEN`). Model settings and provider keys stay on the server.
2. Choose up to 10 files, then choose **Start import**. Choosing files alone does not upload or parse them.
3. Follow the progress, then review the questions, images, supplied answers and anything flagged for review. Download the result as a question-bank ZIP.
4. In the desktop app, open **Settings → Import and restore → Import bank ZIP** to create a bank or add content to an existing one.

The service reads **PDF, TXT, Markdown, PNG/JPEG, DOC, DOCX, PPT, PPTX, XLS and XLSX** with Tencent Cloud's [asynchronous multimodal document parsing](https://cloud.tencent.com/document/product/866/139312), and AI turns the text into questions. Configure the Tencent credentials in the service environment. CSV files can no longer be imported, but saved data and banks you already have stay unchanged. Desktop packages include no Python service or LibreOffice.

Tencent gives each user **1,000 free pages** on first activation, issued once and valid for one year; see the [official quota page](https://cloud.tencent.com/document/api/866/35945) for current terms. Service operators can find per-format limits, how large files are split and optional private COS staging in the [Tencent parser setup](server/docs/tencent-document-parser.md).

Task history, pause, stop, resume, retrying failed parts, reviewing partial results and parsing again are all handled in the Web page. Reading, reviewing and downloading results never calls a model; resuming, retrying and parsing again are actions you take on purpose and may cost money at your model provider. See the [import task guide](docs/guides/import-tasks.md) and [personal-use guide](server/docs/personal-use.md).

Parsing only extracts answers and rubrics already in the document; it does not solve questions that have no answer, and missing content stays flagged for review. Download the results you want to keep within **180 days**; a task expiring never affects banks already imported into the app.

## Grade short answers with AI

Practice and local scoring work offline. To have short answers graded, open **Settings → AI service**, choose **Direct model API** and enter an OpenAI-compatible API address (including the `/v1` or other base path your provider requires), model ID and your own API key. The app calls the provider directly on macOS, Windows and Android, so you need no extra grading service. If you already run the service, choose **Independent AI service** and keep using its address and token.

Grading needs a reference answer or rubric. It sends the current question, related materials, images and your answer to the provider you chose and may cost money. The API must support JSON mode and an output-length limit; questions with images need a vision model. Each explicit action makes at most one request, with a 120-second timeout and a 4,096-token output limit. Invalid, refused or cut-off results stay ungraded, and existing scores and manual corrections are kept. An unknown request is never resent automatically: checking it reads the local record, and only explicit regrading creates a new, possibly paid request. Testing the connection only reads the list of available models and does not check grading quality. This feature is for personal practice, not for scoring formal exams.

API keys and service tokens stay in the system credential store and are excluded from backups. Connection settings hold no secrets and are stored apart from your practice data, so practice records and older backups remain compatible. Earlier app versions cannot read settings saved by this one; keep using the current version after you enable AI grading. Earlier model settings and keys are kept as they are and are never reused automatically.

Timed mock exams keep counting after the app closes or the computer sleeps; when you return to an exam whose time is up, it is submitted with the answers last saved. See the [practice guide](docs/guides/practice-guide.md) for grading and exam details, and the [data format boundaries](docs/reference/question-model.md#versions-and-directories) for restore rules.

Development starts with in-memory sample data. The preview panel lets you switch scenarios or choose real local data; see [development preview](app/docs/development-preview.md) for its controls and limits.

## Install

PractiQ installs from source. You do not need to run the commands yourself: open the repository root and ask your coding agent to do it with this prompt.

> Read `docs/guides/installation.md` and install PractiQ on this machine. Check the requirements first, run only the steps for my platform, and tell me what you ran, where the build is and anything that failed. Ask before installing system packages.

The [installation guide](docs/guides/installation.md) is written for people and for agents. It covers the requirements and commands for macOS, Windows and Android, how to check that the app starts, and the optional AI service.

PractiQ runs on macOS 14+ (Apple Silicon), Windows 10/11 (x64) and Android 8+ (API 26+, arm64 APK). Linux packages are not provided; Linux is supported for the AI service and CI. Build checks cover the macOS/Windows packages, an Android APK and emulator tests on API 35; physical devices, minimum versions and signed releases are checked separately.

Desktop data uses a new `v4/` directory and SQLite schema 11. Older directories, including `v3/`, are left untouched and old full backups are no longer accepted; current question-bank ZIP files still import. See the [data format boundaries](docs/reference/question-model.md#versions-and-directories).

## Self-host the import service

Document import needs the self-hosted AI service; offline practice does not. It requires Python 3.14+, uv, Node.js 22.12+, an empty PostgreSQL database, a dedicated RabbitMQ vhost and a model that accepts text and images. Ask your agent to follow the service part of the [installation guide](docs/guides/installation.md), which lists the settings, start commands and checks.

Service operations, upgrades and storage: [service guide](server/docs/service-guide.md), [delivery and recovery guide](server/docs/rabbitmq.md) and [personal-use guide](server/docs/personal-use.md). Existing service schemas 1–4 must be upgraded offline to schema 5; back up first, and a database that holds customer tasks needs a new personal database and storage. Configure your own model provider; provider charges are paid directly, with no PractiQ billing or user management.

## Documentation and development

Start with the [documentation index](docs/README.md) for user guides, technical references, acceptance worksheets and historical evidence. The [question model](docs/reference/question-model.md) covers question types and composite rules, the [document task API](server/docs/document-tasks.md) covers task payloads and controls, and [operations](server/docs/operations.md) covers deployment, storage and recovery.

Run `make app-check` on macOS/Windows for app checks and follow the [Android guide](app/docs/android.md) for shared checks on any Android development host, APK builds and native emulator checks. Use `make web-check` for the import Web frontend and `make verify` for the AI service. Playwright Test checks bilingual interactions, browser preview, and rich-content rendering with mocked native commands and no model calls:

```sh
cd app
npx playwright install chromium --only-shell
npm run test:browser
```

The runner starts its own loopback Vite servers. Failed tests keep traces and screenshots under `app/test-results/browser/`; inspect a trace with `npx playwright show-trace /path/to/trace.zip`.

## Get help and contribute

Report reproducible bugs or propose improvements through [GitHub Issues](https://github.com/shenyankm/PractiQ/issues/new/choose). Follow [the contribution guide](CONTRIBUTING.md) for changes and [the security policy](SECURITY.md) for private vulnerability reports. Outstanding quality, release, user-trial and contributor workstreams are tracked in the [roadmap evidence record](docs/maintainers/roadmap-evidence.md); the native GitHub roadmap and sub-issues remain authoritative.

Project source uses the [MIT license](LICENSE). Bundled dependencies retain their [upstream notices](app/licenses/README.md).
