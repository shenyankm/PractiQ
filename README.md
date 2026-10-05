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

The app supports Simplified Chinese and English, light and dark themes, seven basic question types, and English listening, reading, cloze, translation, and writing tasks. Practice data stays on your device; there are no accounts or cloud sync.

The first supported system language is used until you choose a language in the sidebar. That choice is saved locally and included in full backups; a failed save can be retried. Dates and numbers use the matching regional system preference. Language changes preserve question content and answers; materials with known language metadata declare their own language for assistive tools. AI grading captures the selected feedback language when you start it, and resuming the same request preserves that language.

Question lists hide previous results while loading. A failed read stays visible with a Retry action that preserves the current bank, search, type, review filter and page.

PractiQ is in development. There is no published GitHub Release yet; run it from source using the instructions below. Platform build checks do not establish signed-release or clean-machine acceptance.

![PractiQ question-bank home in the English desktop development preview](docs/assets/desktop-preview-en.png)

Development preview using in-memory sample data.

## Try it without a model

[Run the desktop app](#run-the-desktop-app), then:

1. Choose **Add example bank** when **My banks** is empty, or import [sample.zip](app/fixtures/sample.zip) through **Settings → Restore backup → Import bank ZIP**.
2. Open the bank and choose **Start practice**. Try practice, an untimed self-test, or a timed mock exam.
3. Submit your answers and review scores and explanations.

No API key is needed. The hand-written samples demonstrate question types and review flags; they are not model evaluations. More examples: [composite questions](app/fixtures/composite.zip) and [all question types](app/fixtures/all-types.zip).

If question statistics or the manual question list fails to load in study setup, use its retry button to read the same query again. Retrying preserves selected banks and questions, per-type quotas, a question count you entered, and exam settings. If you have not changed the count, the first successful statistics read initializes a feasible default, including after a retry. The button is disabled while that read is pending.

In practice, submit an answer before choosing **I got it right** or **I got it wrong**. Self-assessment remains available after finishing for submitted, unskipped answers that need it, including fill-in-the-blank overrides. It uses a separate action and preserves the submitted answer, automatic result and practice snapshot. Self-tests and mock exams use their score-review workflow.

Export a bank from its card menu to share content without personal answers or scores. Bank import appends content; restoring a full learning-data backup replaces personal data after confirmation. See the [package guide](docs/question-bank-package.md).

When editing a bank or question, Escape, the close button, and clicking outside ask you to **Continue editing** or **Discard changes** if the draft has changed. Unchanged or reverted drafts close immediately, including entering and clearing an initially empty text, multiple-choice or fill-in reference answer and the free-response fallback for incomplete question structures. Clearing an existing reference answer remains a change. An entered or selected listening URL that has not been applied is also protected; **Continue editing** keeps it available without starting a download. Removing the applied audio, changing the answer mode or successfully selecting a local audio file makes a retained URL unapplied again. Fetch the audio or clear the URL before saving; saving does not start a download. **Discard changes** in the editor deliberately closes without saving. Child-question changes are staged in their parent; save the top-level question to commit the complete tree. Drafts remain in memory while the editor is open and are not recovered after closing the app.

## Import documents with AI

Use the independent service's Web frontend for document import:

1. Start the [independent AI service](#run-the-ai-service-independently), open its Web frontend and enter the service access token. Model configuration and provider credentials stay in the service environment.
2. Select up to 10 source files and explicitly choose **Start import**. Selecting files does not upload or parse them.
3. Inspect task progress, saved questions, images, supplied answers and review warnings. Download the result as a question-bank ZIP.
4. In the desktop app, use **Settings → Restore backup → Import bank ZIP** to create a bank or append content to an existing bank.

The service accepts **PDF, TXT, CSV and PNG/JPEG**. Deployments configured with LibreOffice also accept **DOC, DOCX, XLS and XLSX**. Office normalization runs in the service, using PDF by default or text exports, including hidden Excel sheets. Desktop packages contain no Python service or LibreOffice. See the [Office guide](server/docs/desktop-office.md) for deployment and fidelity boundaries.

Task history, pause, interrupt, resume, failed-unit retry, partial-result review and parse-again controls belong to the Web frontend. Read-only review and ZIP download make no model calls. Resume, retry and parse again are explicit actions; their model work may incur charges. See the [import task guide](docs/import-tasks.md).

![Independent document import Web frontend](docs/assets/new-web-import.png)

Browser capture of the built Web frontend served by a local read-only AI service, with an empty task database and no configured model. Selecting the sample file made no upload or model call.

Parsing extracts supplied answers and rubrics without solving unanswered questions. Missing content stays flagged for review. Download results within **180 days** to keep them; task expiry does not affect banks already imported into the app.

Practice and local scoring work offline. For optional subjective AI grading, configure the independent service URL and access token in desktop **Settings → AI service**, then explicitly start grading or retry. Grading requires a reference answer or rubric; missing evidence, failed calls and unknown outcomes remain ungraded. It is intended for personal practice, not formal examination scoring. Opening the app or changing settings does not call a model.

The app service access token stays in macOS Keychain, Windows Credential Manager or Android Keystore-backed private storage; the Web token stays in browser memory. The service URL is stored in the separate versioned `v4/service-settings-v1.sqlite` database; practice data remains on schema 11. Backups include only the URL through an optional versioned manifest field and exclude credentials and AI task state. Existing provider settings and keys are preserved, including after saving or clearing a service URL, and are not automatically used as service credentials. Older schema-11 backups remain supported; only their exact existing service marker identifies a service URL. A pending restore record resolves the URL with the published practice database before any offline writes after restart. If publication or durable rollback cannot finish, the current app instance blocks database operations until restart recovery. A killed first settings initialization may leave an empty SQLite file; reads leave it untouched and an explicit save may initialize it. Timed exams keep their deadline when the app closes or the computer sleeps; reopening an expired exam submits the last saved answers.

Development starts with in-memory sample data. The preview panel lets you switch scenarios or choose real local data. See [development preview](app/docs/development-preview.md) for its controls and boundaries.

## Run the desktop app

Desktop data uses a fresh `v4/` directory and SQLite schema 11. Earlier directories, including `v3/`, remain untouched; old full backups are rejected. Current question-bank ZIP files can still be imported. See the [data format boundaries](docs/question-model.md#versions-and-directories).

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

Set the service token, model credentials, `LLM_MODEL`, database directory, and file storage in `.env`, then initialize a new database and start:

```sh
make install-locked AI_PYTHON=/path/to/python3.14
make init-db AI_PYTHON=/path/to/python3.14
make web-install
make web-build
make server-dev AI_PYTHON=/path/to/python3.14
```

The FastAPI/LangGraph service listens on `127.0.0.1:8090`, uses SQLite and local file storage, and runs one process per database. Uploads, tasks, artifacts, and grading require authentication. Open `http://127.0.0.1:8090/` for the built Web frontend. For development, run `make web-dev` separately; its loopback Vite server proxies API requests to the service. Configure `AI_OFFICE_EXECUTABLE` and `AI_OFFICE_VERSION` only on the service when Office support is needed. See the [service guide](server/docs/service-guide.md).

## Documentation and development

- [Document task API](server/docs/document-tasks.md): progress, pause, resume, retry, and review
- [Operations](server/docs/operations.md): deployment, storage, and recovery
- [Evaluation](server/docs/evaluation.md): datasets, checks, and evidence limits
- [Question model](docs/question-model.md): question types and composite question rules
- [Release verification](CONTRIBUTING.md#release-verification): publication checks and acceptance evidence
- [Release policy](docs/releases.md): version tags, downloads, checksums and the manual draft workflow
- [Contributing](CONTRIBUTING.md): development checks and pull requests

Run `make app-check` on macOS/Windows for app checks and follow the [Android guide](app/docs/android.md) for shared checks on any Android development host, APK builds and native emulator checks, `make web-check` for the import Web frontend and `make verify` for the AI service. Playwright Test checks bilingual interactions, browser preview, and rich-content rendering with mocked native commands and no model calls:

```sh
cd app
npx playwright install chromium --only-shell
npm run test:browser
```

The runner starts its own loopback Vite servers. Use `npm run test:preview` or `npm run test:rich-content` for an individual check. Failed tests retain traces and screenshots under `app/test-results/browser/`; inspect a trace with `npx playwright show-trace /path/to/trace.zip`.

## Get help and contribute

Report reproducible bugs or propose improvements through [GitHub Issues](https://github.com/shenyankm/PractiQ/issues/new/choose). Follow [the contribution guide](CONTRIBUTING.md) for changes and [the security policy](SECURITY.md) for private vulnerability reports.

Project source uses the [MIT license](LICENSE). Bundled dependencies retain their [upstream notices](app/licenses/README.md).

Shared dialogs, confirmation dialogs and menus respect the system reduced-motion preference by disabling their entry and exit animations. Keyboard focus entry, dismissal and restoration use the same behavior for both motion preferences.

The [roadmap evidence record](docs/roadmap-evidence.md) links the current quality, release, user-trial and contributor workstreams with their remaining acceptance requirements. The native GitHub roadmap and sub-issues remain authoritative.
