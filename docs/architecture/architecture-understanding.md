# PractiQ Architecture Understanding (Current State)

This current-state model is built from code, SQL schema, deployment configuration, and `docs/system-design.md`.

## System Boundary

PractiQ is one logical system: a Taro frontend baseline plus a Python FastAPI server package that ships API, import worker, and admin CLI processes. PostgreSQL is the system of record; Redis is an acceleration layer.

| Element | Description | Confidence |
| --- | --- | --- |
| Learner / Teacher | Authenticated user with a role, effective membership, bank ownership, and optional study-group membership | high |
| Taro Client | WeChat Mini Program; currently a compile/run baseline without business API integration | high |
| API Server | FastAPI REST/SSE routes, request/security middleware, and in-process AI calls | high |
| Import Worker | Claims jobs with `FOR UPDATE SKIP LOCKED`, resumes LangGraph checkpoints, persists output and events | high |
| PostgreSQL | Authoritative schema under `db/*/*.sql` | high |
| Redis | Cache-aside, rate limits, and idempotency | high |
| Object Storage | Local mount for media bytes; metadata in PostgreSQL | medium |
| RevenueCat | External entitlement and webhook service; Taro purchase UI not restored | high |
| LLM Providers | DashScope, DeepSeek, and Moonshot through LangGraph | high |

Current relationship: Taro will call the API over HTTPS as features are restored. API and worker already use PostgreSQL, Redis, object storage, RevenueCat, and LLM providers. See `docs/taro-migration.md` for frontend sequencing and security gates.

## Evidence Index

| Claim | Evidence | Confidence |
| --- | --- | --- |
| Taro WeChat Mini Program baseline | [`taro/`](../../taro/) | high |
| Unified FastAPI assembly and middleware | [`server/app.py`](../../server/app.py) | high |
| REST routes | [`server/routes/`](../../server/routes/) | high |
| Worker and AI parsing | [`server/worker.py`](../../server/worker.py), [`server/imports_queue.py`](../../server/imports_queue.py) | high |
| Auth and sessions | [`server/auth/`](../../server/auth/), [`db/users/15_auth_sessions.sql`](../../db/users/15_auth_sessions.sql) | high |
| Membership, billing, and study groups | [`docs/membership-design.md`](../membership-design.md), [`server/routes/billing.py`](../../server/routes/billing.py), [`server/routes/study_groups.py`](../../server/routes/study_groups.py) | high |
| PostgreSQL schema | [`db/`](../../db/) | high |
| Deployment units | [`compose.yaml`](../../compose.yaml) | high |

## Known Gaps

- The Taro frontend has not restored authentication or business flows.
- There is no other client.
- Object storage is currently a local mount; a production S3-compatible deployment is not evidenced.
