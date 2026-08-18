# PractiQ Architecture Understanding (Current State)

This is a **current-state** model built from code, SQL schema, deployment configuration, and `docs/system-design.md`; it is not a design proposal.

## Purpose

Describe PractiQ's current system boundary, containers, external dependencies, and the evidence behind each claim. The C4 source is [practiq.structurizr.dsl](practiq.structurizr.dsl).

## Scope

This document covers the L1 system context and L2 containers. Component/code views, detailed flows, and deployment topology remain in their source files until a specific review needs a separate model.

## Model Summary

**System boundary**: PractiQ is one logical system — an Expo React Native client plus a Python FastAPI server package that ships three deployment units (API, import worker, admin CLI) from the same code base, with PostgreSQL as the system of record and Redis as an acceleration layer.

**Actors and containers**

| Element | Description | Confidence |
| --- | --- | --- |
| Learner / Teacher | Authenticated user with a system role, effective free/pro/organization membership, bank ownership, and optional study-group membership | high (schema + docs) |
| Mobile App | Expo Router screens; SQLite mirror (`practiq-cache.db`) at row granularity; outbox replay with `Idempotency-Key`; RevenueCat SDK | high |
| API Server | FastAPI; typed Pydantic route boundaries; request limits, security headers, request IDs/logging, rate limiting, same-origin checks, and idempotency middleware; AI in-process | high |
| Import Worker | `python -m server.worker`, separate container, same image; claims jobs `FOR UPDATE SKIP LOCKED` | high |
| PostgreSQL | Authoritative; schema under `db/*/*.sql`; stores tiered membership and study groups; triggers maintain stats | high |
| Redis | Cache-aside, rate limits, OAuth one-time records, idempotency | high |
| Object Storage | Local mount for media bytes; `media_assets` metadata in PostgreSQL | medium (storage backend configurable) |
| Google OAuth | External IdP; PKCE S256 + nonce; verified `google_sub` | high |
| RevenueCat | External billing; server-generated `revenuecat_app_user_id`; Pro/organization entitlement sync; webhook lifecycle sync | high |
| LLM Providers | DashScope/DeepSeek/Moonshot through LangGraph and LangChain's OpenAI-compatible client; pgcrypto-encrypted per-user keys | high |

**Key relationships**: Mobile → API over HTTPS bearer tokens, SSE, and idempotency keys; API → PostgreSQL via async pool; API → Redis for cache/limits; Worker → PostgreSQL claims, checkpoints, events, and persistence; Worker → LLM providers through in-process LangGraph workflows; API → RevenueCat (sync + webhook in); API → Google (OAuth redirects); API → storage (media bytes).

## Evidence Index

| Claim | Evidence (sourceRefs) | Confidence |
| --- | --- | --- |
| Unified FastAPI assembly, middleware order, router list | [app.py](../../server/app.py) | high |
| REST prefix `/api/v1` on all routes | [routes/](../../server/routes/) (e.g. [auth.py](../../server/routes/auth.py), [imports.py](../../server/routes/imports.py), [billing.py](../../server/routes/billing.py)) | high |
| AI endpoints parse/generate/report; generate-answer on questions | [ai.py](../../server/routes/ai.py) | high |
| Worker as separate process with in-process AI parse | [worker.py](../../server/worker.py) | high |
| Job claiming + LangGraph checkpoint + SSE persistence semantics | [imports_queue.py](../../server/imports_queue.py), [worker.py](../../server/worker.py), [imports.py](../../server/routes/imports.py), [system-design.md](../system-design.md#import-jobs) | high |
| Auth: sessions, email code, Google OAuth | [auth/](../../server/auth/), [routes/auth.py](../../server/routes/auth.py), [15_auth_sessions.sql](../../db/users/15_auth_sessions.sql) | high |
| RevenueCat sync + webhook + membership projection + llm-config | [billing.py](../../server/routes/billing.py), [services/billing.py](../../server/services/billing.py), [membership.py](../../server/membership.py) | high |
| Pro trial, public-bank clone, and study groups | [membership-design.md](../membership-design.md), [study_groups.py](../../server/routes/study_groups.py), [60_study_groups.sql](../../db/users/60_study_groups.sql) | high |
| Media: local storage path, 10 MiB content-sniffed uploads | [media.py](../../server/services/media.py), [60_media.sql](../../db/media/60_media.sql) | high |
| DB schema surface: users/banks/questions/imports/media/practice | [db/](../../db/) (`10_users.sql` … `70_user_answers.sql`) | high |
| Redis responsibilities (cache, rate limit, OAuth, idempotency) | [redisx.py](../../server/redisx.py), [middleware.py](../../server/middleware.py), [system-design.md](../system-design.md#redis-integration) | high |
| Mobile: Expo Router screens, SQLite mirror, outbox, RevenueCat SDK | [mobile/app/](../../mobile/app/), [mobile/src/practiq/](../../mobile/src/practiq/) (`mirror-schema.ts`, `sync.ts`, `revenuecat.ts`, `api.ts`) | high |
| Deployment units: server/worker/postgres/redis containers on one network | [compose.yaml](../../compose.yaml) | high |

## Reading Order

1. Read this document for boundary, containers, and evidence.
2. Open [practiq.structurizr.dsl](practiq.structurizr.dsl) in a Structurizr-compatible viewer for the system-context and container diagrams.
3. Drill into `docs/system-design.md` for API surface, state lifecycles, and data flows.

## Known Gaps / Validation Tasks

- **No bundled Web client**: this repository ships only the Expo client under `mobile/`; the FastAPI service is API-only and returns a structured 404 for unmatched `/api/*` routes.
- **Object storage**: backend is a local mount (`resolve_storage_path`); whether production uses S3-compatible storage is config-dependent and not evidenced here (medium confidence).
- **Media bytes are served by the API** from the local mount — if storage moves off-box, the read path (`media.py`) must change with it.
- **Authorization remains intentionally small**: system `admin`/`user` role, effective membership, bank ownership, and study-group owner/member roles cover current access. A future content-editor role would require a schema and service change.
- **C4 component view (L3) not produced**: server services (`server/services/*`) and mobile features (`mobile/src/features/*`) are candidates, but component views are only worth generating when a specific review question needs them.
