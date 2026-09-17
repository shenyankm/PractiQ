# Personal product API contract

The product API is now Python/FastAPI under `backend/`. The private AI service remains `server/`. The runtime OpenAPI document at `/openapi.json` describes strict request models. `docs/openapi.json` is a checked-in snapshot.

## HTTP

- Base: `/api/v1`. Success: `{ "data": ..., "meta": { "pagination": ... } }` where pagination applies. Error: `{ "error": { "code", "message", "details", "requestId" } }`.
- List cursors are opaque base64 offsets; `limit` is 1–100. Invalid cursors are rejected.
- Every product mutation requires `Idempotency-Key` (1–128 characters). Scope is method + canonical path + key. Fingerprints include query and body; multipart fingerprints use part names, file names, content types and bytes, not random boundaries.
- Admission commits before business work; the business mutation and successful response commit atomically. Identical successful requests replay. Concurrent requests return `REQUEST_IN_PROGRESS`; changed contents return `IDEMPOTENCY_KEY_REUSED`. Failed business transactions roll back but retain their fingerprint so the same request can safely retry.
- No login, cookies or user IDs. Local Host and Origin checks remain. API responses are not cached.

## Endpoint migration matrix

| Previous capability | Personal API |
| --- | --- |
| Banks, favorites, tags, subsets, reorder | `/banks`, `/banks/{id}/...`; no public/private/owner fields |
| Questions, options, versioned keys, content blocks | `/questions/{id}/...`; `/management` includes keys, normal details omit them |
| Material groups and question links | `/banks/{id}/groups`, `/groups/{id}/...` |
| Reference data, knowledge-point management | `/subjects`, `/question-types`, `/knowledge-points`; no admin prefix |
| Media upload/content/links | `/media`, `/media/{id}/content`, resource `/media-links` |
| Practice | `/practice-sessions`, question-page, questions, answers, complete, abandon, results |
| Personal analytics | `/analytics/summary`, `/analytics/snapshot`, `/analytics/banks/{id}` |
| Search | `/search/questions` |
| Imports, events, outputs, parse/retry/cancel | `/import-jobs/...`; Web polls paginated events, old SSE stream is replaced by polling |
| AI answers/reports/cancel/usage | `/questions/{id}/ai-answer-tasks`, `/analytics/report-tasks`, `/ai-tasks` |
| Auth, users, payments, memberships, study groups, leaderboard, public-bank downloads | Removed; no compatibility implementation or fixed identity |

Request fields keep existing camelCase conventions; database-derived resource fields use snake_case. Web types are in `web/src/api.ts`. Material groups and questions belong directly to a personal bank. There are no many-owner or public sharing associations. Subject/answer-mode, same-bank links, tree cycles, answer versions and practice references remain constrained in PostgreSQL.

## Worker

Run `python -m practiq_backend.worker`. It claims PostgreSQL rows with `FOR UPDATE SKIP LOCKED`, heartbeats a 30-second lease, and fences completion by worker UUID + attempt generation + running status + unexpired lease/deadline. AI HTTP calls run outside database transactions. Reclaimed attempts cannot commit stale results. Cancellation is local and prevents result persistence; an already issued model call may finish and still has its usage recorded.

Imports persist all validated questions and output identities atomically. Output keys are `(job_id,item_index)`; failures roll back partial content. Draft imports may lack a key; publishing requires a valid key. Sources use checksums and safe local paths; failures retain a 24-hour retry window. Cleanup is a worker responsibility.

`AI_SERVICE_TOKEN` authenticates product-to-AI calls. `/api/v1/ai/parse-document`, `generate-answer`, `learning-report` retain their existing semantic-only DTOs, error envelopes and `meta.usage`. Product resource IDs are not passed to AI. The browser never accesses the AI service directly.
