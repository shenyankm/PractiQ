<p align="center">
  <img src="app/src-tauri/icons/icon.png" width="160" alt="PractiQ logo">
</p>

# PractiQ

English | [简体中文](README.zh-CN.md)

Turn documents into question banks, then practise and take mock exams offline on your desktop.

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

## Import documents with AI

1. In **Settings**, configure a provider URL, model ID, and API key for a model supporting text and image inputs. Changes save when you leave a field.
2. Open **Import**, select source files, and click **Start import**.
3. Review questions, images, and warnings, then create a bank or append to an existing one.

Supported source files are **PDF, TXT, CSV, and PNG/JPEG**. Desktop packages include LibreOffice 26.8.0 for Word and Excel conversion; no separate installation or runtime download is required. The desktop converts them to PDF by default. The standalone service does not accept Office files. See the [conversion guide](server/docs/desktop-office.md) for text export and limitations.

The Import page has **Import** and **Import history** tabs. Select up to 10 source files and click **Start import** to begin conversion and parsing without a second confirmation. Review results before creating a bank or appending to an existing bank.

Matching files reuse existing tasks; **Parse again** creates a new task. Stop running tasks before deleting their records; deletion preserves imported banks and practice data. See the [import task guide](docs/import-tasks.md) for history, filtering, and recovery.

Development starts with in-memory sample data. The preview panel lets you switch scenarios or choose real local data. See [development preview](app/docs/development-preview.md) for its controls and boundaries.

Parsing extracts supplied answers and rubrics without solving unanswered questions. Missing content stays flagged for review. Tasks support pause, resume, retries, and partial results; import results within **180 days** to keep them. Expiry does not affect imported banks.

Practice and local scoring work offline. Parsing and AI grading require an explicit action, send content to your configured provider, and may incur charges. Reopening the app does not resume model calls. AI grading requires a reference answer or rubric; missing evidence and failed calls remain ungraded. It is intended for personal practice, not formal examination scoring.

API keys stay in the platform credential store. Backups exclude keys and AI task state. Timed exams keep their deadline when the app closes or the computer sleeps; reopening an expired exam submits the last saved answers.

## Run the desktop app

Desktop data uses a fresh `v4/` directory and SQLite schema 11. Earlier directories, including `v3/`, remain untouched; old full backups are rejected. Current question-bank ZIP files can still be imported. See the [data format boundaries](docs/question-model.md#versions-and-directories).

Desktop build targets are macOS 14+ (Apple Silicon), Windows 10/11 (x64), and Ubuntu 22.04+ (x64, `.deb`). macOS has been validated locally; Windows and Linux builds and bundled-service checks are configured in CI, with interactive desktop acceptance still required on those systems.

Development requires Node.js 22.12+, Rust, uv, and an existing Python 3.14+ interpreter. Install the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/): Xcode on macOS, MSVC build tools and WebView2 on Windows, or WebKitGTK 4.1, `libdbus-1-dev`, and build libraries on Linux. Linux also needs an unlocked Secret Service provider (such as GNOME Keyring) for API keys, and GStreamer audio plugins for listening playback. Do not create a project `.venv`. Build on the target OS; packages include its native Python service.

Clone the repository and enter its root directory:

```sh
git clone https://github.com/shenyankm/PractiQ.git
cd PractiQ
```

On macOS or Linux, run these commands from the repository root, replacing the Python path with your interpreter:

```sh
make install-locked app-install-python AI_PYTHON=/path/to/python3.14
make app-install
cargo fetch --locked --manifest-path app/src-tauri/Cargo.toml
make app-bundle AI_PYTHON=/path/to/python3.14
make app-dev
```

To build a local application package, run:

```sh
make app-build AI_PYTHON=/path/to/python3.14
```

On Windows, use PowerShell from the repository root:

```powershell
uv export --project server --locked --extra dev --extra desktop --no-emit-project -o "$env:TEMP/practiq-requirements.txt"
uv pip install --python (Get-Command python).Source -r "$env:TEMP/practiq-requirements.txt"
uv pip install --python (Get-Command python).Source --no-deps -e server
npm --prefix app ci
cargo fetch --locked --manifest-path app/src-tauri/Cargo.toml
python app/scripts/bundle-python.py
cd app
npm run desktop
# To build the Windows installer:
npm run tauri -- build
```

Packages are written under `app/src-tauri/target/release/bundle`: `.app`/`.dmg` on macOS, NSIS `.exe` on Windows, and `.deb` on Linux. CI checks each packaged Python service using synthetic model responses and real PDF rendering; it does not certify installer signing or interactive playback.

## Run the AI service independently

For API integration, use Python 3.14+, uv, and a model supporting text and image inputs. Copy the configuration template without overwriting existing settings:

```sh
cp -n .env.example .env
```

Set the service token, model credentials, `LLM_MODEL`, database directory, and file storage in `.env`, then initialize a new database and start:

```sh
make install-locked AI_PYTHON=/path/to/python3.14
make init-db AI_PYTHON=/path/to/python3.14
make server-dev AI_PYTHON=/path/to/python3.14
```

The FastAPI/LangGraph service listens on `127.0.0.1:8090`, uses SQLite and local file storage, and runs one process per database. Uploads, tasks, artifacts, and grading require authentication. See the [service guide](server/docs/service-guide.md).

## Documentation and development

- [Document task API](server/docs/document-tasks.md): progress, pause, resume, retry, and review
- [Operations](server/docs/operations.md): deployment, storage, and recovery
- [Evaluation](server/docs/evaluation.md): datasets, checks, and evidence limits
- [Question model](docs/question-model.md): question types and composite question rules
- [Release verification](CONTRIBUTING.md#release-verification): publication checks and acceptance evidence
- [Release policy](docs/releases.md): version tags, downloads, checksums and the manual draft workflow
- [Contributing](CONTRIBUTING.md): development checks and pull requests

Run `make app-check` for desktop checks and `make verify` for the AI service. Playwright Test checks bilingual interactions, browser preview, and rich-content rendering with mocked native commands and no model calls:

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
