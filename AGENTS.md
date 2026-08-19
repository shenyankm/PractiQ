# Repository Guidelines

## Project Structure

`backend/` is the Java product API and owns users, authorization, billing, question banks, imports, persistence, retries, and product API contracts. `server/` is a private FastAPI AI service: HTTP handlers in `server/routes/`, orchestration in `server/services/ai.py`, workflows in `server/agents/`, document extraction in `server/extractors/`, and strict integration DTOs in `server/ai_schemas.py`. `weapp/` is the WeChat Mini Program. SQL under `db/` remains the product schema authority.

## Commands

- `make backend-test`: test the Java product API.
- `make test-server`: test the Python AI service.
- `make server-dev`: run the internal AI service.
- `make backend-dev`: run the Java API locally.
- `make test`: verify the WeChat Mini Program.

## Coding Style

Use Java/Spring conventions in `backend/`, strict Pydantic DTOs in `server/`, and native WeChat Mini Program conventions in `weapp/`. Keep WeChat-specific code at platform boundaries. Avoid new abstractions or dependencies until needed by a concrete feature.

## Testing

Run `make backend-test` for Java changes, `make test-server` for AI changes, and `make test` for Mini Program changes. Run `make verify` before opening a PR when changes span layers.

## Boundaries

Keep Python AI-only. Do not add product persistence, authentication, billing, import queues, or Java business rules to `server/`. The bearer-token contract for a future Java-to-Python integration is defined by `AI_SERVICE_TOKEN`; Java client integration is not yet implemented. AI DTOs must exclude user, bank, question, session, and import resource IDs, while retaining semantic classification keys such as `questionTypeId`.

## Documentation, Commits, and Security

Update relevant docs with code/configuration changes. Follow `CONTRIBUTING.md` when creating issues or pull requests. Use focused Conventional Commit subjects. Do not commit `.env.local` or secrets. Production traffic must use HTTPS and the internal AI service must not be publicly exposed.
