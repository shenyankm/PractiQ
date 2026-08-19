# AI Service Design

`backend/` is the public product API and source of truth. `server/` is an internal, stateless FastAPI service with exactly three protected operations:

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/v1/ai/parse-document` | Extract and structure supported documents. |
| POST | `/api/v1/ai/generate-answer` | Generate a canonical answer and explanation. |
| POST | `/api/v1/ai/learning-report` | Generate a report from caller-supplied statistics. |

`/api/health/live` is public. Other `/api/*` paths return the standard `NOT_FOUND` envelope.

## Boundary

Java owns public callers, entitlement, product relationships, persistence, retries, and audit/import state. The pending Java-to-Python integration will use `Authorization: Bearer $AI_SERVICE_TOKEN`; Python compares it in constant time. Python never accepts user, question, bank, session, or import-job IDs, while `questionTypeId` remains a semantic classification key.

## Layers

- `server/routes/`: HTTP validation and response mapping only.
- `server/services/ai.py`: configured model ownership and agent invocation.
- `server/agents/`: LangGraph parsing/generation workflows.
- `server/extractors/`: bounded document extraction.
- `server/ai_schemas.py`: strict integration DTOs.

Model configuration is process-level: `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_TEXT_MODEL`, and optional `LLM_VISION_MODEL`. Supported providers are DashScope, DeepSeek (no vision model), and Moonshot. `AI_SOURCE_MAX_BYTES`, `AI_AGENT_*`, and `AI_MAX_*` bound request and model work.

The service retains request IDs, logs, security headers, strict JSON limits, and structured envelopes. Java or the gateway owns public rate limiting, CORS/origin policy, idempotency, user authentication, payment, and persistence.
