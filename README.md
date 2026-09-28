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

## Try it without a model

[Run the desktop app](#run-the-desktop-app), then:

1. Choose **Add example bank** when **My banks** is empty, or import [sample.zip](app/fixtures/sample.zip) through **Settings → Restore backup → Import bank ZIP**.
2. Open the bank and choose **Start practice**. Try practice, an untimed self-test, or a timed mock exam.
3. Submit your answers and review scores and explanations.

No API key is needed. The hand-written samples demonstrate question types and review flags; they are not model evaluations. More examples: [composite questions](app/fixtures/composite.zip) and [all question types](app/fixtures/all-types.zip).

Export a bank from its card menu to share content without personal answers or scores. Bank import appends content; restoring a full learning-data backup replaces personal data after confirmation. See the [package guide](docs/question-bank-package.md).

## Import documents with AI

1. In **Settings**, configure a provider URL, model ID, and API key for a model supporting text and image inputs. Changes save when you leave a field.
2. Open **Import**, select source files, and confirm parsing.
3. Review questions, images, and warnings, then create a bank or append to an existing one.

Supported source files are **PDF, TXT, CSV, and PNG/JPEG**. Word and Excel files require locally installed [LibreOffice](https://www.libreoffice.org/download/download-libreoffice/) with Writer and Calc. The desktop converts them to PDF by default; local conversion/export needs no model. The standalone service does not accept Office files. See the [conversion guide](server/docs/desktop-office.md) for text export and limitations.

Parsing extracts supplied answers and rubrics without solving unanswered questions. Missing content stays flagged for review. Tasks support pause, resume, retries, and partial results; import results within **180 days** to keep them. Expiry does not affect imported banks.

Practice and local scoring work offline. Parsing and AI grading require an explicit action, send content to your configured provider, and may incur charges. Reopening the app does not resume model calls. AI grading requires a reference answer or rubric; missing evidence and failed calls remain ungraded. It is intended for personal practice, not formal examination scoring.

API keys stay in the platform credential store. Backups exclude keys and AI task state. Timed exams keep their deadline when the app closes or the computer sleeps; reopening an expired exam submits the last saved answers.

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
- [First-release draft](docs/first-release.md): scope and outstanding release checks
- [Contributing](CONTRIBUTING.md): development checks and pull requests

Run `make app-check` for desktop checks and `make verify` for the AI service. Browser checks use mocked native commands and no model calls:

```sh
cd app
npx playwright install chromium --only-shell
npm run test:browser
```
