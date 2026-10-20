<p align="center">
  <img src="app/src-tauri/icons/icon.png" width="160" alt="PractiQ logo">
</p>

# PractiQ

English | [简体中文](README.zh-CN.md)

Turn documents into question banks, then practise and take mock exams offline on macOS, Windows or Android.

- **Import and review**: extract questions from documents with AI, review warnings, and organize your banks.
- **Practise and test**: select across banks by question type, mistakes, bookmarks, or unanswered questions; practise, take self-tests, or set up timed exams.
- **Review scores**: score objective questions locally, request AI short-answer grading, or record manual corrections.
- **Keep and share**: resume sessions, back up personal records, and share banks with images and audio as ZIP files.

The app supports Simplified Chinese and English, light and dark themes, seven basic question types, and English listening, reading, cloze, translation, and writing tasks. Offline practice data stays on your device and needs no account or cloud sync. The separate Web importer uses your self-hosted service access token; there are no user accounts or built-in billing.

PractiQ is in development. Run it from source using the instructions below; check [GitHub Releases](https://github.com/shenyankm/PractiQ/releases) for published packages and their stated limitations. Platform build checks do not establish signed-release or clean-machine acceptance.

## Screenshots

These screenshots show the desktop development preview in English, including hand-written English question banks and practice records. All data is held in memory; no credentials, uploads or model calls were used. Click an image to view it at full size.

| Question banks | Practice |
| :---: | :---: |
| [![English question banks with sample titles and descriptions](docs/assets/screenshots/banks-en.png)](docs/assets/screenshots/banks-en.png) | [![English practice question with answer options and answer sheet](docs/assets/screenshots/practice-en.png)](docs/assets/screenshots/practice-en.png) |
| **Mistakes** | **Practice history** |
| [![English mistakes list with scores and source banks](docs/assets/screenshots/mistakes-en.png)](docs/assets/screenshots/mistakes-en.png) | [![English practice history with session progress and results](docs/assets/screenshots/history-en.png)](docs/assets/screenshots/history-en.png) |

## Try it without a model

[Run the desktop app](#run-the-desktop-app), then:

1. Choose **Add example bank** when **My banks** is empty, or import [sample.zip](app/fixtures/sample.zip) through **Settings → Import and restore → Import bank ZIP**. More examples: [composite questions](app/fixtures/composite.zip) and [all question types](app/fixtures/all-types.zip).
2. Open the bank and choose **Start practice**. Try practice, an untimed self-test, or a timed mock exam.
3. Submit your answers and review scores and explanations.

No API key is needed. The hand-written samples demonstrate question types and review flags; they are not model evaluations.

Export a bank from its card menu to share content without personal answers or scores. Bank import appends content; restoring a full learning-data backup replaces personal data after confirmation. See the [practice guide](docs/guides/practice-guide.md) for answer submission, draft protection, language settings and optional AI grading, and the [package guide](docs/guides/question-bank-package.md) for import and backup boundaries.

## Import documents with AI

Use the independent service's Web frontend for document import:

1. Start the [independent AI service](#run-the-ai-service-independently), open its Web frontend and enter your service access token (`AI_SERVICE_TOKEN`). Model configuration and provider credentials stay in the service environment.
2. Select up to 10 source files and explicitly choose **Start import**. Selecting files does not upload or parse them.
3. Inspect task progress, saved questions, images, supplied answers and review warnings. Download the result as a question-bank ZIP.
4. In the desktop app, use **Settings → Import and restore → Import bank ZIP** to create a bank or append content to an existing bank.

The service accepts **PDF, TXT, Markdown, PNG/JPEG, DOC, DOCX, PPT, PPTX, XLS and XLSX** through [Tencent asynchronous parsing](server/docs/tencent-document-parser.md). Configure Tencent credentials in the service environment. New CSV imports are unsupported; existing saved data and imported banks remain intact. Desktop packages contain no Python service or LibreOffice.

Document recognition uses Tencent Cloud's **异步多模态文档解析** ([`SubmitMultimodalDocParseJob`](https://cloud.tencent.com/document/product/866/139312)). Tencent currently provides **1,000 free pages per user on first activation**, issued once and valid for one year. See the [official free quota policy](https://cloud.tencent.com/document/api/866/35945) for current terms.

Task history, pause, interrupt, resume, failed-unit retry, partial-result review and parse-again controls belong to the Web frontend. Read-only review and ZIP download make no model calls; resume, retry and parse again are explicit actions that may incur model-provider charges. Use the [import task guide](docs/guides/import-tasks.md) and [personal-use guide](server/docs/personal-use.md).

Parsing extracts supplied answers and rubrics without solving unanswered questions; missing content stays flagged for review. Download results within **180 days** to keep them; task expiry does not affect banks already imported into the app.

Offline practice needs no service. For optional subjective AI grading, open **Settings → AI service**, select **Direct model API**, and enter an OpenAI-compatible API base URL (including its `/v1` or provider-specific base path), model ID and your own API key. Rust calls `/chat/completions` directly; no grading service, SDK or curl executable is required on macOS, Windows or Android. Existing deployments can select **Independent AI service** and keep using their service URL/token.

A reference answer or rubric is required. Grading sends the current frozen question, related materials, images and answer to the selected provider and may incur charges. The endpoint must support JSON mode (`response_format: json_object`) and `max_tokens`; image questions require a vision model. Each explicit action makes at most one request, with a 120-second timeout and 4,096 output-token limit. Invalid, refused or truncated results remain ungraded, and existing scores/manual corrections are retained. Unknown requests are never automatically resent; checking them reads the local receipt, while explicit regrading creates a new potentially paid request. Connection testing only reads `/models` and does not validate grading quality.

API keys and service tokens stay in the system credential store and are excluded from backups. Non-secret connection settings share the existing versioned sidecar and backup recovery; the practice schema remains 11 and old schema-11 backups remain supported. Earlier App versions reject settings sidecars and backups containing the new model configuration; continue using the current App after enabling it. Legacy model settings and keys are never automatically reused.

Development starts with in-memory sample data. The preview panel lets you switch scenarios or choose real local data. See [development preview](app/docs/development-preview.md) for its controls and boundaries.

## Run the desktop app

Desktop data uses a fresh `v4/` directory and SQLite schema 11. Earlier directories, including `v3/`, remain untouched; old full backups are rejected. Current question-bank ZIP files can still be imported. See the [data format boundaries](docs/reference/question-model.md#versions-and-directories).

App targets are macOS 14+ (Apple Silicon), Windows 10/11 (x64), and Android 8+ (API 26+, arm64 APK). Linux app packages are removed. Linux remains an AI-service and CI host. CI checks native macOS/Windows packages and an Android APK plus API 35 emulator tests; physical-device, minimum-version and signed-release acceptance remain separate.

Development requires Node.js 22.12+ and Rust. Package preparation and shared-contract checks also use an existing Python 3.14+ interpreter and uv; Python is a build tool and is not shipped in the desktop package. Install the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/): Xcode on macOS or MSVC build tools and WebView2 on Windows. Android also needs JDK 21, SDK 36 and NDK 28.2.13676358; see the [Android guide](app/docs/android.md). Do not create a project `.venv`.

Clone the repository and enter its root directory:

```sh
git clone https://github.com/shenyankm/PractiQ.git
cd PractiQ
```

On macOS, replace the Python path with your interpreter:

```sh
make install-locked AI_PYTHON=/path/to/python3.14
make app-install
cargo fetch --locked --manifest-path app/src-tauri/Cargo.toml
make app-dev AI_PYTHON=/path/to/python3.14
# Build a local application package:
make app-build AI_PYTHON=/path/to/python3.14
```

On Windows, use PowerShell from the repository root:

```powershell
npm --prefix app ci
cargo fetch --locked --manifest-path app/src-tauri/Cargo.toml
python app/scripts/prepare-package.py
cd app
npm run desktop
# Build the Windows installer:
npm run tauri -- build
```

Use Python 3.14+ for `prepare-package.py`. It generates build metadata and Cargo/npm notices, without downloading or copying document-processing runtimes. Packages are written under `app/src-tauri/target/release/bundle`: `.app`/`.dmg` on macOS and NSIS `.exe` on Windows. Android APKs use the separate [Android build and emulator commands](app/docs/android.md). Package checks verify version, notices and absence of embedded engines; they do not certify signing or interactive playback.

## Run the AI service independently

The independent service provides document import through its Web frontend and API, and explicit grading for the desktop. Use Python 3.14+, uv, Node.js 22.12+ for the Web build, and a model supporting text and image inputs. Copy the configuration template without overwriting existing settings:

```sh
cp -n .env.example .env
```

Set the service token, model credentials, `LLM_MODEL`, the PostgreSQL URL `DATABASE_URI`, dedicated RabbitMQ vhost URL `RABBITMQ_URI`, and file storage in `.env`. Provision an empty dedicated PostgreSQL database, then initialize its service tables and start:

```sh
make install-locked AI_PYTHON=/path/to/python3.14
make init-db AI_PYTHON=/path/to/python3.14
make web-install
make web-build
make server-dev AI_PYTHON=/path/to/python3.14
```

The FastAPI/LangGraph service listens on `127.0.0.1:8090`, uses RabbitMQ delivery, PostgreSQL state and local file storage, and runs one process per database. Uploads, tasks, artifacts, and grading require authentication. Open `http://127.0.0.1:8090/` for the built Web frontend. For development, run `make web-dev` separately; its loopback Vite server proxies API requests to the service. Configure `AI_OFFICE_EXECUTABLE` and `AI_OFFICE_VERSION` only on the service for XLS and oversized Office pagination before Tencent submission. XLSX preparation exposes hidden sheets in an immutable derived copy. Local Base64 inputs are capped at 8 MiB and larger sources split automatically. Advanced opt-in private COS staging (`AI_TENCENT_COS_ENABLED=true`) uses signed file URLs for every input while retaining local source/result files; configure its bucket and region in the service environment. See [Tencent parser setup](server/docs/tencent-document-parser.md) for type-specific limits and cleanup. See the [service guide](server/docs/service-guide.md).

AI service upgrades and RabbitMQ setup: [delivery and recovery guide](server/docs/rabbitmq.md). Existing service schemas 1–4 require explicit offline upgrade to schema 5. Back up first; databases containing customer tasks require a new personal database and storage. See the [personal-use guide](server/docs/personal-use.md).

Personal deployment, service-token access and safe upgrades: [personal-use guide](server/docs/personal-use.md). Configure your own model provider; provider charges are paid directly, with no PractiQ billing or user management.

## Documentation and development

Start with the [documentation index](docs/README.md) for user guides, technical references, acceptance worksheets and historical evidence. The [question model](docs/reference/question-model.md) covers question types and composite rules, the [document task API](server/docs/document-tasks.md) covers task payloads and controls, and [operations](server/docs/operations.md) covers deployment, storage and recovery.

Run `make app-check` on macOS/Windows for app checks and follow the [Android guide](app/docs/android.md) for shared checks on any Android development host, APK builds and native emulator checks. Use `make web-check` for the import Web frontend and `make verify` for the AI service. Playwright Test checks bilingual interactions, browser preview, and rich-content rendering with mocked native commands and no model calls:

```sh
cd app
npx playwright install chromium --only-shell
npm run test:browser
```

The runner starts its own loopback Vite servers. Failed tests retain traces and screenshots under `app/test-results/browser/`; inspect a trace with `npx playwright show-trace /path/to/trace.zip`.

## Get help and contribute

Report reproducible bugs or propose improvements through [GitHub Issues](https://github.com/shenyankm/PractiQ/issues/new/choose). Follow [the contribution guide](CONTRIBUTING.md) for changes and [the security policy](SECURITY.md) for private vulnerability reports. Outstanding quality, release, user-trial and contributor workstreams are tracked in the [roadmap evidence record](docs/maintainers/roadmap-evidence.md); the native GitHub roadmap and sub-issues remain authoritative.

Project source uses the [MIT license](LICENSE). Bundled dependencies retain their [upstream notices](app/licenses/README.md).
