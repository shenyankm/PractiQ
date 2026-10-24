# Install PractiQ

This guide installs PractiQ from source: the offline practice app, and optionally the self-hosted AI service that imports documents. It is written so that a person or a coding agent can follow it step by step. Run every command from the repository root unless a step says otherwise.

PractiQ is in development; these steps build local packages and a development server. They do not sign installers or accept a release. Check [GitHub Releases](https://github.com/shenyankm/PractiQ/releases) before building if a published package is enough.

## Before you start

| Item | Requirement |
| --- | --- |
| Practice app | macOS 14+ on Apple Silicon |
| Node.js | 22.12 or newer |
| Rust | Installed through [rustup](https://rustup.rs/); the repository pins its toolchain |
| Python | An existing 3.14+ interpreter for packaging checks; do not create a project `.venv` |
| uv | Required for locked dependency installation |
| Desktop toolchain | Xcode on macOS; see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) |

Clone the repository and enter its root directory:

```sh
git clone https://github.com/shenyankm/PractiQ.git
cd PractiQ
```

Use your own interpreter path wherever these steps say `/path/to/python3.14`.

## Install the desktop app

### macOS

```sh
make install-locked AI_PYTHON=/path/to/python3.14
make app-install
cargo fetch --locked --manifest-path app/src-tauri/Cargo.toml
make app-dev AI_PYTHON=/path/to/python3.14
# Build a local application package:
make app-build AI_PYTHON=/path/to/python3.14
```

`prepare-package.py` needs Python 3.14+. It generates build metadata and dependency notices; it does not download or copy any document-processing runtime. A first build downloads Rust and npm dependencies and can take several minutes.

### Build outputs

Packages are written under `app/src-tauri/target/release/bundle`:

- macOS: `.app` and `.dmg`

Package checks verify the version, notices and the absence of embedded engines; they do not check signing or interactive playback.

### Confirm the app works

Run `make app-dev` (or start the packaged app), then:

1. When **My banks** is empty, choose **Add example bank**.
2. Open the bank and choose **Start practice**.
3. Answer one question and confirm that a score appears.

No API key or model call is needed for this check.

## Install the AI import service (optional)

The service handles document import for the Web page and can grade short answers for the desktop app. Its commands use GNU Make; on a host without the native build tools, the [service guide](../../server/docs/service-guide.md) covers building the Docker image instead. It needs:

- Python 3.14+ and uv
- Node.js 22.12 or newer for the Web page
- An empty, dedicated PostgreSQL database
- A dedicated RabbitMQ vhost
- A model endpoint that accepts text and images

Copy the configuration template without overwriting existing settings:

```sh
cp -n .env.example .env
```

Set these values in `.env`:

| Setting | Purpose |
| --- | --- |
| `AI_SERVICE_TOKEN` | Access token shared by the Web page and the desktop app |
| `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL` | The model used for question structuring and grading |
| `AI_TENCENT_SECRET_ID`, `AI_TENCENT_SECRET_KEY` | Tencent Cloud credentials for document parsing |
| `DATABASE_URI` | PostgreSQL address |
| `RABBITMQ_URI` | RabbitMQ address using a dedicated vhost |
| `AI_STORAGE_DIR` | Absolute, persistent location for uploads and results |

Then build the Web page, initialise the service tables and start the service:

```sh
make install-locked AI_PYTHON=/path/to/python3.14
make init-db AI_PYTHON=/path/to/python3.14
make web-install
make web-build
make server-dev AI_PYTHON=/path/to/python3.14
```

The service listens on `127.0.0.1:8090`, keeps tasks in PostgreSQL, delivers work through RabbitMQ and stores files locally. Run one process per database. Configure `AI_OFFICE_EXECUTABLE` and `AI_OFFICE_VERSION` only on the service, and only when XLS files or very large Office files must be read.

### Confirm the service works

1. Open `http://127.0.0.1:8090/ok` and `http://127.0.0.1:8090/ready`; both should return a success response (for example with `curl`).
2. Open `http://127.0.0.1:8090/` and enter the service token.
3. Import one small PDF or TXT file and download the resulting question-bank ZIP.

The last step calls Tencent and your model provider, and may cost money. Skip it if credentials are not configured.

## Notes for coding agents

- Build the app on macOS. The independent service may run on Linux.
- Ask before installing system packages, upgrading tools, or changing anything outside the repository.
- Never create a project `.venv`; use an existing Python 3.14+ interpreter.
- Do not overwrite an existing `.env`. Add missing keys instead.
- Never print, commit or copy credentials from `.env`, and do not put them in logs.
- Stop at the first failure and report the command, its output and what you already changed. Do not replace a failing step with a different toolchain or a different package manager.
- When done, report the commands you ran, the output locations, and anything you skipped.

## Next steps

- Practise, review scores and use optional AI grading: [practice guide](practice-guide.md).
- Import, resume and download documents: [import tasks](import-tasks.md).
- Deploy the service for personal use and upgrade old databases: [personal-use guide](../../server/docs/personal-use.md).
- Configure Tencent parsing limits, splitting and private COS staging: [Tencent parser setup](../../server/docs/tencent-document-parser.md).
- Open the service Web page in development: run `make web-dev` in a second terminal; it forwards API requests to the service.
