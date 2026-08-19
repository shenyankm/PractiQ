# PractiQ

PractiQ is a question-bank and smart-practice platform: teachers build question banks and import questions manually or via AI; students practice or take exams and get learning analytics. The frontend is a WeChat Mini Program; the backend splits product and AI responsibilities.

## Repository layout

- `backend/` — Java product API: users, authorization, billing, question banks, import orchestration, persistence, retries, and audit records.
- `server/` — Private FastAPI AI service: document parsing and AI question/answer/learning-report generation via LangGraph workflows. It accepts no user, bank, question, session, or import resource IDs and persists no product data; `questionTypeId` remains a semantic parsing classification key.
- `weapp/` — WeChat Mini Program frontend.

## AI service contract

The pending Java-to-Python integration uses `Authorization: Bearer $AI_SERVICE_TOKEN` on every `/api/v1/ai/*` operation; `/api/health/live` is public for probes. Stable integration DTOs live in `server/ai_schemas.py`, and every successful or terminal AI response includes idempotent per-call token usage. Supported providers: DashScope, DeepSeek (text only), and Moonshot. Document parsing supports TXT, Markdown, CSV, DOCX, PDF, XLSX, and images.

## Local setup

```bash
cp .env.example .env.local
# Set AUTH_SECRET, WECHAT_APP_ID, WECHAT_APP_SECRET, AI_SERVICE_TOKEN, LLM_PROVIDER, LLM_API_KEY, and LLM_TEXT_MODEL.
# Set SECURE_COOKIES=false only for local HTTP cookie testing.
cd server && uv sync --extra dev && cd ..
docker compose up -d      # PostgreSQL, Redis, AI service (host port 8081)
make backend-dev          # Java API
make server-dev           # AI service
```

Do not expose the AI port outside the trusted backend network in production.

## Testing

```bash
make backend-test   # Java API
make test-server    # Python AI service
make schema-check   # PostgreSQL 16 schema and critical constraints
make verify         # everything
```
