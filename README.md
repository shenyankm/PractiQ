<p align="center">
  <img src="app/src-tauri/icons/icon.png" width="160" alt="PractiQ logo">
</p>

# PractiQ

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

Turn documents into question banks, then practise and take mock exams offline on macOS.

- **Import and review**: pull questions out of documents with AI, check anything that needs a second look, and organise your banks.
- **Practise and test**: choose questions across banks by type, mistakes, bookmarks or unanswered questions, then practise, self-test or run a timed mock exam.
- **Review scores**: score objective questions on your device, ask AI to grade short answers, or adjust marks yourself.
- **Keep and share**: pick up a session where you left off, back up your records, and share a bank with its images and audio as a ZIP file.

PractiQ works in English, Simplified Chinese and Traditional Chinese, with light and dark themes, seven basic question types and English listening, reading, cloze, translation and writing. Your data stays on your device, with no account and no cloud sync.

## Screenshots

These screenshots were captured on **2026-10-29** from the desktop browser preview at [`0099f594`](https://github.com/shenyankm/PractiQ/commit/0099f5949b8b1b72c25f7939659b8cb1ce9d6041), in English with hand-written sample banks and practice records. All data is held in memory; no credentials, uploads or model calls were used. Click an image to view it at full size.

| Question banks | Practice |
| :---: | :---: |
| [![English question banks with sample titles and descriptions](docs/assets/screenshots/banks-en.png)](docs/assets/screenshots/banks-en.png) | [![English practice question with answer options and answer sheet](docs/assets/screenshots/practice-en.png)](docs/assets/screenshots/practice-en.png) |
| **Mistakes** | **Practice history** |
| [![English mistakes list with source banks and favorite controls](docs/assets/screenshots/mistakes-en.png)](docs/assets/screenshots/mistakes-en.png) | [![English practice history with session progress and results](docs/assets/screenshots/history-en.png)](docs/assets/screenshots/history-en.png) |

## Try it without a model

[Install PractiQ](#install), then:

1. When **My banks** is empty, choose **Add example bank**, or import [sample.zip](app/fixtures/sample.zip) through **Settings → Import and restore → Import bank ZIP**. More examples: [composite questions](app/fixtures/composite.zip) and [all question types](app/fixtures/all-types.zip).
2. Open the bank and choose **Start practice**. Try practice with instant feedback, an untimed self-test or a timed mock exam.
3. Submit your answers and review the scores and explanations.

No API key is needed; the samples only show question types and review flags.

Export a bank from its card menu to share its questions without your answers or scores. Importing a bank ZIP adds content, while restoring a full backup replaces your data after confirmation. See the [practice guide](docs/guides/practice-guide.md) and [package guide](docs/guides/question-bank-package.md).

## Import documents with AI

Document import runs in the Web page of the self-hosted AI service:

1. [Start the service](#self-host-the-import-service), open its Web page and enter the access token (`AI_SERVICE_TOKEN`).
2. Choose up to 10 files and select **Start import**. Choosing files does not upload or parse them.
3. Review the questions, images and anything flagged for review, then download a question-bank ZIP.
4. In the desktop app, open **Settings → Import and restore → Import bank ZIP**.

The service reads **PDF, TXT, Markdown, PNG/JPEG, DOC, DOCX, PPT, PPTX, XLS and XLSX** with Tencent Cloud's [asynchronous multimodal document parsing](https://cloud.tencent.com/document/product/866/139312). Tencent gives each user **1,000 free pages** on first activation, valid for one year.

Reading and downloading results never calls a model. Resuming, retrying or parsing again may cost money at your model provider. Download what you want to keep within **180 days**; a task expiring never affects banks you already imported. See the [import task guide](docs/guides/import-tasks.md).

## Grade short answers with AI

Open **Settings → AI service**, choose **Direct model API** and enter an OpenAI-compatible API address (including the `/v1` or other base path your provider requires), model ID and your own API key. Offline practice and local scoring need none of this.

Grading needs a reference answer or rubric, may cost money, and sends the current question, materials, images and your answer to the provider you chose. Each action makes at most one request, and an unknown result is never resent automatically. Keys stay in the system credential store and out of backups. See the [practice guide](docs/guides/practice-guide.md) for limits and retry rules.

## Install

PractiQ installs from source. You do not need to run the commands yourself: open the repository root and ask your coding agent to do it with this prompt.

> Read `docs/guides/installation.md` and install PractiQ on this machine. Check the requirements first, run only the steps for my platform, and tell me what you ran, where the build is and anything that failed. Ask before installing system packages.

The [installation guide](docs/guides/installation.md) covers requirements, commands and checks. PractiQ runs on macOS 14+ (Apple Silicon); Linux is supported only for the AI service and CI.

PractiQ is still in development: these steps build on your own machine, and a passing build does not confirm a signed release. Published packages, when available, are listed on [GitHub Releases](https://github.com/shenyankm/PractiQ/releases).

Desktop data lives in a new `v4/` folder. Older folders are left untouched, old full backups are no longer accepted, and current question-bank ZIP files still import. See the [data format boundaries](docs/reference/question-model.md#versions-and-directories).

## Self-host the import service

Document import needs the self-hosted AI service. It requires Python 3.14+, uv, Node.js 22.12+, PostgreSQL, RabbitMQ and a model that accepts text and images. The [installation guide](docs/guides/installation.md) and [personal-use guide](server/docs/personal-use.md) cover setup and upgrades; configure your own model provider, with charges paid directly and no PractiQ billing.

## Documentation and development

Start with the [documentation index](docs/README.md). It links the [question model](docs/reference/question-model.md), [document task API](server/docs/document-tasks.md), [operations](server/docs/operations.md) and contributor guides. Run `make app-check`, `make web-check` or `make verify` for the part you changed; Playwright covers the app's bilingual interactions with mocked native commands and no model calls:

```sh
cd app
npx playwright install chromium --only-shell
npm run test:browser
```

## Get help and contribute

Report reproducible bugs or propose improvements through [GitHub Issues](https://github.com/shenyankm/PractiQ/issues/new/choose). Follow [the contribution guide](CONTRIBUTING.md) for changes and [the security policy](SECURITY.md) for private vulnerability reports.

Project source uses the [MIT license](LICENSE). Bundled dependencies retain their [upstream notices](app/licenses/README.md).
