# Repository Guidelines

## Project Structure

`backend/` is the Java product API and owns users, authorization, billing, question banks, imports, persistence, retries, and product API contracts. `server/` is the private AI service, packaged at `server/src/practiq_ai/`: `webapp.py` registers HTTP APIs, `graphs/` contains the sole document parser, `extractors/` handles formats, and `contracts.py` defines native OSS reference DTOs. `product/` preserves Java envelopes, answer/report generation and a small inline-to-graph compatibility facade. `taro/` is the React/TypeScript WeChat-only client. SQL under `db/` remains the product schema authority.

## Commands

- `make backend-test`: test the Java product API.
- `make server-install`: editable install into existing Conda `langgragh` Python 3.14 (no new `.venv`).
- `make test-server`: test the Python AI service.
- `make server-dev`: run the internal AI service.
- `make backend-dev`: run the Java API locally.
- `make test`: run Taro unit tests, type checking, and a WeChat build.
- `make taro-dev`: watch-build the WeChat Mini Program into `taro/dist/`.

## Coding Style

Use Java/Spring conventions in `backend/`, strict Pydantic DTOs in `server/`, and strict TypeScript with React/Taro conventions in `taro/`. Keep WeChat-specific APIs in platform adapters, keep authentication tokens in memory, and do not add H5 or another Taro target without an explicit requirement. Avoid new abstractions or dependencies until needed by a concrete feature.

## Testing

Run `make backend-test` for Java changes, `make test-server` for AI changes, and `make test` for Mini Program changes. Run `make verify` before opening a PR when changes span layers.

## Boundaries

Keep Python AI-only. Do not add product persistence, authentication, billing, import queues, or Java business rules to `server/`. Java already calls `/api/v1/ai/*` with `AI_SERVICE_TOKEN`; preserve that contract and per-call usage on both success and failure. Native Agent Server APIs use the same token. AI DTOs must exclude user, bank, question, session, and import resource IDs, while retaining semantic classification keys such as `questionTypeId`.

## Documentation, Commits, and Security

Update relevant docs with code/configuration changes. Follow `CONTRIBUTING.md` when creating issues or pull requests. Use focused Conventional Commit subjects. Do not commit `.env.local` or secrets. Production traffic must use HTTPS and the internal AI service must not be publicly exposed.
