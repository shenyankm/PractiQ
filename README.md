# PractiQ

PractiQ has two backend boundaries:

- `backend/` is the Java product API. It owns users, authorization, payments, question banks, import orchestration, persistence, retries, and audit records.
- `server/` is a private FastAPI AI service. It only parses documents and generates answers or learning reports through LangGraph workflows.

## AI service

The bearer contract for the pending Java-to-Python integration is `Authorization: Bearer $AI_SERVICE_TOKEN`. The token is mandatory on every `/api/v1/ai/*` operation; `/api/health/live` and `/api/health/ready` are public for probes.

```bash
cp .env.example .env.local
# Set AI_SERVICE_TOKEN, LLM_PROVIDER, LLM_API_KEY, and LLM_TEXT_MODEL.
make server-dev
make test-server
```

The stable Java-to-Python integration DTOs are in `server/ai_schemas.py`. Python accepts no user, bank, question, session, or import resource IDs and persists no product data; `questionTypeId` remains a semantic parsing classification key. Supported providers are DashScope, DeepSeek (text only), and Moonshot. Document parsing supports TXT, Markdown, CSV, DOCX, PDF, XLSX, and images.

## Local setup

```bash
cp .env.example .env.local
# Set AUTH_SECRET and the required AI provider/token variables.
cd server && uv sync --extra dev && cd ..
docker compose up -d
make backend-dev
```

Docker Compose starts PostgreSQL, Redis, and the internal AI service on host port 8081. Run the Java API separately with `make backend-dev`. Do not expose the AI port outside the trusted backend network in production.

## Development

```bash
make backend-test
make test-server
make test
```
