# PractiQ System Design

This document describes the Taro frontend baseline, unified FastAPI service, worker, and PostgreSQL data model. The split schema files under `db/*/*.sql` are the product schema authority.

The files under `db/*/*.sql` are bootstrap schema fragments for fresh local, test, or reset environments. They are not a reversible production migration history; production data-preserving schema changes should be added as explicit versioned migrations before rollout.

## 中文摘要

本文档基于 `db/*/*.sql` 中按业务拆分的 PostgreSQL schema 设计 PractiQ 题库系统的完整产品形态，覆盖：

- 后端 REST API：用户认证、题库、题目、题组、练习会话、导入任务、媒体资源、统计分析。
- 移动端页面：登录注册、学习概览、题库列表和详情、题目管理、练习作答、文件导入、学习分析与用户设置。
- 核心模块：认证授权、题库权限、题型渲染与判分、导入流水线、媒体管理、统计分析。
- 工程约束：数据关联、事务边界、参数校验、错误模型、状态生命周期和性能策略。

当前仓库包含 `taro/` 微信小程序前端基线、`server/` FastAPI 服务及 worker，以及 `db/` SQL schema；不包含其他前端。

## Redis Integration

Redis is an acceleration and live-event layer, not the system of record. PostgreSQL remains authoritative for users, question banks, questions, import jobs, events, answers, and statistics.

Current Redis responsibilities:

- Cache-aside reads for user profiles, practice question queues, and analytics summaries.
- Rate limit counters for authentication endpoints.
- Cached leaderboard and analytics snapshot endpoints for higher-cost reporting views.
- Successful responses for client mutations carrying `Idempotency-Key`, retained for 24 hours.

Failure policy:

- Cache misses or Redis cache errors fall back to PostgreSQL.
- Authentication rate limits require Redis and fail closed with `503` when Redis is unavailable. Session validation and logout use PostgreSQL.
- Requests carrying `Idempotency-Key` also fail closed with `503` when Redis is unavailable so a retry cannot create duplicate writes.
- Import processing and authenticated SSE progress continue from PostgreSQL without Redis; clients can retain polling as a fallback.
- Redis deployments should avoid evicting live rate-limit and idempotency keys.

## 1. Domain Model

### Core Entities

| Domain | Tables | Purpose |
| --- | --- | --- |
| Identity | `users` | Local accounts, system role, RevenueCat membership projection, Pro trial, encrypted user LLM configuration |
| Taxonomy | `subjects`, `question_types`, `knowledge_points` | Subject/type classification and knowledge hierarchy |
| Question banks | `question_banks`, `user_bank_links`, `user_bank_stats` | User-owned public/private banks, favorites, per-user bank stats |
| Questions | `questions`, `question_groups`, `bank_question_links`, `bank_group_links`, `group_question_links`, `v_bank_question_items` | Standalone and grouped questions inside banks |
| Answer models | `question_options`, `question_answer_keys` | Choice options and canonical answer payloads |
| Import pipeline | `question_import_jobs`, `question_import_job_events`, `question_import_job_artifacts`, `question_import_job_outputs`, `checkpoints`, `checkpoint_blobs`, `checkpoint_writes` | File import orchestration, source artifacts, events, AI-phase checkpoints, and generated-question links |
| Media | `media_assets`, `question_media_links`, `question_option_media_links`, `question_group_media_links`, `question_content_blocks` | Uploaded images and schema-supported rich content blocks |
| Practice | `user_practice_sessions`, `user_question_answers`, `user_question_stats` | Practice sessions, submitted answers, per-question user stats |
| Study groups | `study_groups`, `study_group_members`, `study_group_banks` | Organization-owned groups, members, shared banks, and member analytics access |

### Important Invariants

- `questions.subject_id` and `question_type_id` must match an existing `(subject_id, type_id)` in `question_types`.
- Bank links carry trigger-filled subject fields so a bank can only contain same-subject questions/groups.
- Group-question links also carry trigger-filled subject fields so a group cannot contain cross-subject questions.
- Import outputs connect source jobs to generated questions.
- Answer submissions update `user_question_stats`, `user_bank_stats`, and `user_practice_sessions` through database triggers.
- `question_answer_keys` allows only one primary answer key per question.
- `media_assets.created_by` owns every uploaded asset; the fresh schema requires it and media reads still follow bank visibility.
- Import jobs use the terminal `cancelled` status directly.
- Effective membership is derived from the RevenueCat `membership` projection plus `trial_ends_at`; system roles do not bypass paid entitlements.
- Study-group owners manage membership and bank links; group members receive read access to linked banks.

## 2. API Design

Use REST under `/api/v1`. All responses use a consistent envelope:

```json
{
  "data": {},
  "meta": {
    "requestId": "req_...",
    "pagination": { "cursor": "...", "limit": 20, "hasMore": false }
  }
}
```

Errors:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request body",
    "details": [{ "field": "name", "message": "Required" }],
    "requestId": "req_..."
  }
}
```

### Authentication

Use short-lived access JWTs and rotating refresh tokens. Native clients receive bearer tokens only after target-appropriate secure storage is implemented; the server also supports HttpOnly cookie transport for external browser clients. Login/register responses contain `tokens.accessToken`, `tokens.refreshToken`, `tokens.expiresAt`, and `tokens.refreshExpiresAt`. PostgreSQL stores the device session plus only the SHA-256 hash of each refresh token; refresh-token reuse revokes the whole device session.

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/api/v1/auth/register` | Public | Validate local registration details, create `users` row, and hash password. |
| `POST` | `/api/v1/auth/login` | Public | Verify username/email + password, set session cookie. |
| `POST` | `/api/v1/auth/email-code` | Public | Send a single-use six-digit registration code. |
| `POST` | `/api/v1/auth/refresh` | Public | Rotate a refresh token and return/set fresh access and refresh tokens. |
| `POST` | `/api/v1/auth/logout` | User | Revoke the PostgreSQL device session and clear both cookies. |
| `GET` | `/api/v1/auth/me` | User | Return current user profile and capability flags. |
| `PATCH` | `/api/v1/users/me` | User | Update username/email/password. |

Register body:

```json
{
  "username": "alice",
  "email": "alice@example.com",
  "password": "minimum-8-bytes",
  "code": "123456"
}
```

Registration requires a 3-20 character ASCII username containing only letters, numbers, and underscores; an email address of at most 254 characters; and an 8-72 byte password.

`GET /api/v1/auth/me` returns `401 UNAUTHENTICATED` when no valid access token and unrevoked device session exists. Profile updates accept explicit `email: null`; password changes require the current password and revoke all existing sessions.

Authorization checks:

- `is_active=false` blocks all mutating routes and practice start.
- Effective membership is ordered `free < pro < organization`; a new `free` user is treated as `pro` until `trial_ends_at`. Effective Pro gates cloud AI, import, LLM configuration, and public-bank cloning; organization additionally gates study-group creation. System roles do not bypass these checks.

### Subjects and Question Types

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/subjects` | Public/User | List subjects. |
| `GET` | `/api/v1/question-types?subject=math&scope=question` | Public/User | List supported question types. |
| `GET` | `/api/v1/knowledge-points?subject=math&parentId=...` | User | Browse knowledge tree. |

### Question Banks

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/banks` | User | List owned, favorited, and public banks; accepts `updated_since` (ISO 8601) for incremental sync. |
| `POST` | `/api/v1/banks` | User | Create bank and `user_bank_links(is_owner=true)`. |
| `GET` | `/api/v1/banks/:bankId` | Bank reader | Bank detail with stats and permissions. |
| `PATCH` | `/api/v1/banks/:bankId` | Bank owner | Update name, description, public flag. |
| `DELETE` | `/api/v1/banks/:bankId` | Bank owner | Delete bank and cascading links. |
| `POST` | `/api/v1/banks/:bankId/favorite` | User | Add/update `user_bank_links(is_favorite=true)`. |
| `DELETE` | `/api/v1/banks/:bankId/favorite` | User | Remove favorite or clear favorite flag. |
| `POST` | `/api/v1/banks/:bankId/clone` | Pro | Clone a public bank into a private bank owned by the caller. |
| `GET` | `/api/v1/banks/:bankId/items` | Bank reader | Read `v_bank_question_items` with filters. |
| `POST` | `/api/v1/banks/:bankId/questions` | Bank editor | Create standalone question and link. |
| `GET` | `/api/v1/banks/:bankId/groups` | Bank reader | List visible groups and question counts. |
| `POST` | `/api/v1/banks/:bankId/groups` | Bank editor | Create question group and link. |
| `PATCH` | `/api/v1/banks/:bankId/items/reorder` | Bank editor | Reorder standalone/group bank items. |

Bank create body:

```json
{
  "name": "Algebra Basics",
  "description": "Linear equations and functions",
  "subject": "math",
  "isPublic": false
}
```

Bank item list query:

```text
GET /api/v1/banks/12/items?status=active&type=math_calculation&limit=50&cursor=...
```

Owners may add `includeAnswers=true` to receive option correctness. Other readers never receive option correctness, answer keys, or drafts. List endpoints return the next opaque cursor under `meta.pagination`.

### Membership and Study Groups

RevenueCat synchronization updates the stored membership projection; authorization uses the effective membership described in `docs/membership-design.md`.

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/api/v1/billing/sync` | User | Re-read active RevenueCat entitlements and update the user projection. |
| `POST` | `/api/v1/billing/revenuecat/webhook` | RevenueCat | Re-read current entitlements after a lifecycle event. |
| `GET` | `/api/v1/study-groups` | User | List groups owned by or joined by the caller. |
| `POST` | `/api/v1/study-groups` | Organization | Create a group and its owner membership. |
| `GET` | `/api/v1/study-groups/:groupId` | Group member | Read group, member, and linked-bank details. |
| `PATCH` | `/api/v1/study-groups/:groupId` | Group owner | Update group metadata. |
| `DELETE` | `/api/v1/study-groups/:groupId` | Group owner | Delete the group and cascading links. |
| `POST` | `/api/v1/study-groups/:groupId/members` | Group owner | Add a member by username. |
| `DELETE` | `/api/v1/study-groups/:groupId/members/:userId` | Group owner | Remove a non-owner member. |
| `PUT` | `/api/v1/study-groups/:groupId/banks/:bankId` | Group owner | Link a bank owned by the group owner. |
| `DELETE` | `/api/v1/study-groups/:groupId/banks/:bankId` | Group owner | Unlink a bank. |
| `GET` | `/api/v1/study-groups/:groupId/members/:userId/stats` | Group owner | Read a member analytics snapshot. |

### Questions

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/questions/:questionId` | Bank reader or owner | Full question detail. |
| `PATCH` | `/api/v1/questions/:questionId` | Question owner/editor | Update core fields. |
| `DELETE` | `/api/v1/questions/:questionId` | Owner/editor | Delete or archive. |
| `POST` | `/api/v1/questions/:questionId/publish` | Owner/editor | Set status `active`. |
| `POST` | `/api/v1/questions/:questionId/archive` | Owner/editor | Set status `archived`. |
| `PUT` | `/api/v1/questions/:questionId/answer-key` | Owner/editor | Upsert primary answer key. |
| `POST` | `/api/v1/questions/:questionId/options` | Owner/editor | Add choice option. |
| `PATCH` | `/api/v1/questions/:questionId/options/:optionId` | Owner/editor | Update option content/correctness. |
| `PUT` | `/api/v1/questions/:questionId/content-blocks` | Owner/editor | Replace structured content. |

Question create body:

```json
{
  "questionTypeId": "math_calculation",
  "answerMode": "fill_blank",
  "stem": "Solve 2x + 3 = 9.",
  "analysis": "Move 3, then divide by 2.",
  "status": "draft",
  "answerPayload": { "slots": [{ "blankRef": "x", "answers": ["3"] }] }
}
```

Choice question answer model:

- `questions.choice_variant`: `single` or `multiple`.
- `question_options`: labels, content, sort order, correctness.
- `question_answer_keys.answer_payload`: canonical answer, used by graders.
- Choice answer payloads accept client `selected` and AI `correctOption`/`correctOptions` input. The service keeps the primary answer key and option correctness flags synchronized.

Fill blank answer model:

- `question_answer_keys.answer_payload`: canonical slot and accepted-answer data.

### Question Groups

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/groups/:groupId` | Bank reader | Group detail with questions. |
| `PATCH` | `/api/v1/groups/:groupId` | Owner/editor | Update title/instructions/content. |
| `POST` | `/api/v1/groups/:groupId/publish` | Owner/editor | Publish after every child question is active. |
| `POST` | `/api/v1/groups/:groupId/archive` | Owner/editor | Archive the bank group link. |
| `DELETE` | `/api/v1/groups/:groupId` | Owner/editor | Delete the group while retaining its questions as standalone bank items. |
| `POST` | `/api/v1/groups/:groupId/questions` | Owner/editor | Add question to group. |
| `PATCH` | `/api/v1/groups/:groupId/questions/reorder` | Owner/editor | Reorder group questions. |
| `DELETE` | `/api/v1/groups/:groupId/questions/:questionId` | Owner/editor | Remove question from group. |

### Practice Sessions

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/practice-sessions` | User | List own sessions; accepts `updated_since` (ISO 8601) for incremental sync. |
| `POST` | `/api/v1/practice-sessions` | User | Start practice from bank/filter. |
| `GET` | `/api/v1/practice-sessions/:sessionId` | Owner | Session state and current summary. |
| `GET` | `/api/v1/practice-sessions/:sessionId/questions` | Owner | Ordered practice queue. |
| `POST` | `/api/v1/practice-sessions/:sessionId/answers` | Owner | Submit answer; creates `user_question_answers`. |
| `POST` | `/api/v1/practice-sessions/:sessionId/complete` | Owner | Complete session and finalize score. |
| `POST` | `/api/v1/practice-sessions/:sessionId/abandon` | Owner | Abandon active session. |
| `GET` | `/api/v1/practice-sessions/:sessionId/results` | Owner | Detailed results and explanations. |
| `POST` | `/api/v1/offline-practice` | User | Idempotently create, answer, and complete one cached offline practice session. |

Start body:

```json
{
  "bankId": 12,
  "sessionType": "practice",
  "questionCount": 20,
  "mode": "sequential",
  "filters": {
    "questionTypeIds": ["math_calculation"],
    "onlyWrong": false,
    "difficulty": ["easy", "medium"]
  }
}
```

Submit answer body:

```json
{
  "questionId": 901,
  "answerPayload": {
    "mode": "fill_blank",
    "slots": [{ "blankRef": "x", "value": "3" }]
  },
  "durationMs": 12400
}
```

Submit answer response:

```json
{
  "data": {
    "answerId": 5521,
    "isCorrect": true,
    "score": 1,
    "maxScore": 1,
    "explanation": {},
    "session": {
      "answeredCount": 8,
      "correctCount": 7,
      "wrongCount": 1
    }
  }
}
```

Implementation notes:

- The service must load the primary `question_answer_keys` row.
- The grader computes `is_correct`, `score`, and `max_score`.
- Insert into `user_question_answers`.
- Database trigger updates `user_question_stats`, `user_bank_stats`, and session counters.

### Import Jobs

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/api/v1/import-jobs` | Bank editor | Create upload/import job. |
| `POST` | `/api/v1/import-jobs/:jobId/file` | Job owner | Upload source file. |
| `POST` | `/api/v1/import-jobs/:jobId/parse` | Job owner | Schedule parsing with optional persistence. |
| `GET` | `/api/v1/import-jobs/:jobId` | Job owner | Job summary and progress. |
| `GET` | `/api/v1/import-jobs/:jobId/events` | Job owner | Recent durable events. |
| `GET` | `/api/v1/import-jobs/:jobId/stream` | Job owner | Authenticated SSE progress with `Last-Event-ID` resume. |
| `GET` | `/api/v1/import-jobs/:jobId/artifacts` | Job owner | Source artifacts. |
| `GET` | `/api/v1/import-jobs/:jobId/outputs` | Job owner | Generated questions from `question_import_job_outputs`. |
| `POST` | `/api/v1/import-jobs/:jobId/retry` | Job owner | Retry a failed job. |
| `POST` | `/api/v1/import-jobs/:jobId/cancel` | Job owner | Cancel a queued job or a job still in its AI phase; persistence cannot be cancelled safely. |

Create body:

```json
{
  "bankId": 12,
  "fileName": "algebra.docx",
  "sourceType": "docx",
  "requestPayload": {
    "subject": "math",
    "defaultQuestionTypeId": "math_calculation"
  }
}
```

Import worker flow:

1. Insert `question_import_jobs(status='queued', stage='queued')`.
2. Store one TXT, Markdown, CSV, DOCX, PDF, XLSX, or PNG/JPEG/GIF/WebP image source as `question_import_job_artifacts`.
3. Schedule the job by setting `available_at`.
4. Claim it atomically with `FOR UPDATE SKIP LOCKED` and mark it `processing`.
5. Run the LangGraph parser: extract, fan out vision work, split, fan out chunks, and merge. PostgreSQL checkpoints successful AI nodes under `thread_id=import:{jobId}`.
6. Stream node progress into durable `question_import_job_events`; automatic worker retries resume unfinished AI nodes.
7. Delete the AI checkpoint before entering persistence, then create each question, answer, content block, output link, and parsed group under the existing claim fencing rules.
8. Update counters and terminal status atomically with the terminal event. Clients can use SSE and fall back to polling.

### Media

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/api/v1/media` | User | Upload image/diagram/QR/table asset. |
| `GET` | `/api/v1/media/:mediaId` | Authenticated user | Metadata. |
| `GET` | `/api/v1/media/:mediaId/content` | Bank reader or owner | Read the protected image bytes. |
| `DELETE` | `/api/v1/media/:mediaId` | Admin | Permanently delete the asset and cascading links. |
| `POST` | `/api/v1/questions/:questionId/media-links` | Owner/editor | Link media to question. |
| `POST` | `/api/v1/groups/:groupId/media-links` | Owner/editor | Link media to group. |
| `POST` | `/api/v1/options/:optionId/media-links` | Owner/editor | Link media to option. |
| `DELETE` | `/api/v1/questions/:questionId/media-links/:mediaId` | Owner/editor | Unlink question media. |
| `DELETE` | `/api/v1/groups/:groupId/media-links/:mediaId` | Owner/editor | Unlink group media. |
| `DELETE` | `/api/v1/options/:optionId/media-links/:mediaId` | Owner/editor | Unlink option media. |

Uploads are limited to PNG, JPEG, GIF, and WebP images up to 10 MiB and are content-sniffed before storage. `part_type` supports text, formula, image, table, list, HTML/Markdown, chart, diagram, and QR code; video, audio, and unsanitized SVG uploads are not implemented.

## 3. Taro Client

The repository-bundled frontend lives under `taro/` and uses Taro 4.2 with React 18. It targets WeChat Mini Program only.

The current frontend is a compile/run baseline only: it has one status page and does not yet persist sessions or call business APIs. Features will be restored vertically in this order:

1. Password/email-code auth and validated API envelopes.
2. Overview, banks, question detail, and online practice.
3. Bank management, search, analytics, settings, and i18n.
4. Imports and authenticated media.
5. Offline cache, outbox replay, and payments.

PostgreSQL remains authoritative. Response schema validation, HTTPS, secure token storage, and stable `Idempotency-Key` values remain required as each flow returns. The previous Expo client and iOS target have been removed by product decision. H5 is also out of scope. See `docs/taro-migration.md` for acceptance gates and release blockers.

## 4. Core Modules

### Auth Module

Responsibilities:

- Password hashing and verification.
- Access-token validation, refresh-token rotation, and device-session revocation.
- Current-user lookup.
- Email-code registration.

Current files:

```text
server/auth/runtime.py
server/auth/handlers.py
server/auth/email_code.py
server/routes/deps.py
```

### Authorization Module

Responsibilities:

- Resolve bank access: owner, favorite, public reader.
- Extend bank read access to members of linked study groups.
- Enforce editor operations for bank owners.
- Ensure import job belongs to requesting user or target bank owner.
- Ensure practice session belongs to current user.
- Enforce effective membership and study-group owner/member roles.

Access matrix:

| Resource | Read | Write |
| --- | --- | --- |
| Public bank | Any active user | Owner |
| Private bank | Owner, existing user-bank link, or linked study-group member | Owner |
| Question | Reader of any linked bank | Owner/editor of linked bank |
| Import job | Creator / bank owner | Creator / bank owner |
| Practice session | Session owner | Session owner |
| Media | Linked resource reader | Linked resource owner/editor |
| Study group | Group member | Group owner |

### Bank Module

Responsibilities:

- Create bank and owner link in one transaction.
- Keep `question_banks.total_count` updated when adding/removing bank links.
- Query `v_bank_question_items` with filters and pagination.
- Reorder items with unique sort conflict handling.

### Search and Classification Module

Responsibilities:

- Filter banks by name, subject, and ownership/public scope.
- Search questions by stem keyword with optional bank, question-type, and status filters.
- Filter knowledge points by name/code, subject, and parent.
- Keep list queries backed by existing indexes and cursor pagination.

Current endpoints:

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/api/v1/banks?q=&subject=&scope=` | Search visible banks |
| `GET` | `/api/v1/search/questions?q=&bankId=&type=&status=` | Search editable/readable questions |
| `GET` | `/api/v1/knowledge-points?q=&subject=&parentId=` | Search knowledge tree |

### Question Module

Responsibilities:

- Normalize question payloads by answer mode.
- Save core `questions` row and detail tables in one transaction.
- Validate answer mode compatibility:
  - `choice`: options required before publish.
  - `true_false`: boolean answer required before publish.
  - `fill_blank`: slots or answer payload required.
  - `short_answer`: answer key or rubric required.
- Manage primary answer key.
- Manage tags, educational metadata, knowledge points, content blocks, media.

### Practice Module

Responsibilities:

- Create sessions and choose question queue.
- Grade submitted answers.
- Insert `user_question_answers`.
- Read trigger-maintained stats.
- Finalize session status and score.

Grading strategy:

- Choice: compare selected option labels/ids to primary answer payload or `question_options.is_correct`.
- True/false: compare boolean.
- Fill blank: compare normalized values against accepted answers; respect case sensitivity.
- Short answer: manual or rubric-assisted; automatic correctness may be null.

### Import Module

Responsibilities:

- File ingestion and artifact persistence.
- PostgreSQL job claiming and retry scheduling.
- AI parser orchestration.
- Question and output persistence.
- Durable event persistence and authenticated SSE delivery.

Worker boundaries:

```text
Upload API -> import job queued
Worker: queued -> processing
Worker: resume or run the LangGraph AI workflow
Worker: questions/links/outputs
Worker: completed or failed
```

### AI Workflow

The unified Python server exposes document parsing, answer generation, and learning-report operations through LangGraph `StateGraph` workflows. Each user with effective Pro-or-higher membership supplies one encrypted provider key plus a text model and, for DashScope or Moonshot, an optional vision model. The supported OpenAI-compatible providers are DashScope, DeepSeek, and Moonshot; DeepSeek is text-only. TXT and Markdown are decoded as UTF-8, CSV is normalized to tab-separated rows, DOCX text is pulled from `word/document.xml` with bounded archive inspection (including embedded images and OMML formula passthrough), PDF text is extracted with pypdfium2 (scanned pages are rendered and OCR'd by the vision model, including figure detection with bounding-box crops), and XLSX sheets are flattened with openpyxl. PNG, JPEG, GIF, and WebP imports enter the same vision/OCR path. Vision inputs and text chunks fan out through bounded `Send` nodes, then merge in source order. Structured outputs use Pydantic validation with feedback loops, and image-only documents fail explicitly when the user has no vision model.

AI capabilities are called in-process behind session auth, effective Pro-or-higher membership, and per-user LLM configuration; there is no internal HTTP hop:

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/ai/parse-document` | Parse TXT, Markdown, CSV, DOCX, PDF, XLSX, or PNG/JPEG/GIF/WebP content. |
| `POST` | `/api/v1/ai/generate-answer` | Generate an answer and explanation. |
| `POST` | `/api/v1/ai/learning-report` | Generate a learning report. |

Provider endpoints remain fixed to the previous native defaults; users may change model names but not base URLs. PostgreSQL `pgcrypto` encrypts keys using `LLM_KEY_ENCRYPTION_SECRET`, and model objects/API keys are run-scoped LangGraph context rather than checkpoint state. `AI_AGENT_*` bounds tokens, timeouts, and per-worker concurrency, while `AI_MAX_OCR_PAGES`, `AI_MAX_VISION_BYTES`, and `AI_MAX_VISION_PAGE_PIXELS` cap scanned-PDF OCR, checkpointed visual bytes, and pre-compression bitmap allocation. `langgraph-checkpoint-postgres` stores only the AI phase; checkpoints must be deleted before question persistence, preserving the existing non-retryable persistence boundary.

### RevenueCat Billing

A future Taro purchase adapter will use the server-generated `revenuecat_app_user_id` and RevenueCat lookup keys. Client entitlement state must control presentation only. The authorized RevenueCat webhook already provides lifecycle synchronization, and future login, foreground resume, purchase, and restore flows must call `POST /api/v1/billing/sync`. Both paths query the v2 active-entitlements endpoint, project `free`/`pro`/`organization` into `users.membership`, and invalidate the Redis user cache. `trial_ends_at` remains independent of that projection and grants effective Pro while active. Duplicate or out-of-order webhook events are safe because event payloads are never treated as current entitlement state.

### Media Module

Responsibilities:

- Upload validation.
- Local object-storage mount persistence.
- `media_assets` metadata persistence.
- Link media to questions, groups, and options.
- Structured content block editing.
- Protected image download.

Validation:

- Accept only content-sniffed PNG, JPEG, GIF, and WebP uploads up to 10 MiB.
- Restrict content blocks to the schema owner, part-type, sequence, content-mode, and media-reference constraints.

### Analytics Module

Responsibilities:

- User overview metrics from `user_question_stats`, `user_bank_stats`, `user_practice_sessions`.
- Bank-level metrics from link counts and user stats.
- Import metrics from job counters and events.

Example endpoints:

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/api/v1/analytics/me/summary` | Accuracy, attempts, active banks, recent activity |
| `GET` | `/api/v1/analytics/banks/:bankId` | Bank practice stats |
| `GET` | `/api/v1/analytics/imports/:jobId` | Import quality/risk summary |

## 5. Data Flows

### Create Bank

```text
POST /banks
 -> insert question_banks
 -> insert user_bank_links(user_id, bank_id, is_owner=true)
 -> return bank detail
```

Transaction required.

### Add Question to Bank

```text
POST /banks/:bankId/questions
 -> check bank owner
 -> validate subject and type
 -> insert questions
 -> insert type detail rows
 -> insert answer key
 -> insert bank_question_links
    - trigger fills bank_subject/question_subject_id
    - constraints enforce subject match
 -> update question_banks.total_count
```

Transaction required.

### Import Questions

```text
POST /import-jobs
 -> question_import_jobs queued
 -> upload artifact
 -> schedule with available_at
 -> worker claims job and calls internal AI parser
 -> worker creates questions/links
 -> question_import_job_outputs connects source to generated objects
 -> job completed
```

### Practice Submission

```text
POST /practice-sessions/:id/answers
 -> load question and answer key
 -> grade answer
 -> insert user_question_answers
 -> trigger updates:
    - user_question_stats
    - user_bank_stats
    - user_practice_sessions
 -> return feedback
```

## 6. Validation and Error Handling

### Request Validation

Use FastAPI/Pydantic request models at server route boundaries. Restored Taro flows must validate received API payloads with Zod before caching them.

Validation categories:

- Body shape and primitive ranges.
- Enum values consistent with schema CHECK constraints.
- Subject/type compatibility.
- Bank ownership and visibility.
- Question status transition.
- Upload file type/size.

### Error Codes

| Code | HTTP | Meaning |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | Missing/expired session |
| `FORBIDDEN` | 403 | User lacks resource permission |
| `NOT_FOUND` | 404 | Resource missing or hidden |
| `VALIDATION_ERROR` | 422 | Request failed schema validation |
| `INVALID_JSON` | 400 | Body is malformed JSON or contains unknown fields |
| `REQUEST_TOO_LARGE` | 413 | JSON body exceeds the route-family limit |
| `CONFLICT` | 409 | Unique constraint/order/status conflict |
| `INVALID_STATE` | 409 | Operation not allowed in current lifecycle state |
| `IMPORT_FAILED` | 500 | Import worker failure |
| `RATE_LIMITED` | 429 | Quota or abuse protection |
| `SESSION_STORE_UNAVAILABLE` | 503 | Redis-backed authentication state is unavailable |
| `AUTH_RATE_LIMIT_UNAVAILABLE` | 503 | Redis cannot enforce authentication rate limits |

### Constraint Mapping

- Unique violation on `(bank_id, sort_order)`: return `CONFLICT` with reorder guidance.
- Subject mismatch constraint: return `VALIDATION_ERROR` for bank/question subject mismatch.
- Primary answer key unique index: return `CONFLICT` unless replacing existing primary.
- Practice session completed/abandoned: return `INVALID_STATE` on answer submission.

## 7. State Lifecycles

### Question

```text
draft -> active -> archived
draft -> archived
archived -> draft (restore/edit)
```

Publish requires valid answer data.

### Bank Link

```text
draft -> active -> archived
active -> archived
archived -> active
```

Question and link statuses both matter: a bank item is practice-eligible only when both are `active`.

### Import Job

```text
queued -> processing -> completed
queued -> processing -> failed
queued -> processing -> persisting -> completed
queued -> processing -> persisting -> failed (terminal; no automatic retry)
failed -> queued (retry creates a new event and resets the attempt count)
```

Stage values should be standardized in service code:

- `queued`
- `processing`
- `persisting`
- `completed`
- `failed`

### Practice Session

```text
active -> completed
active -> abandoned
```

Answers accepted only while active.

## 8. Performance

API pagination:

- Opaque cursor pagination for banks, bank items, bank groups, import jobs, practice sessions, knowledge points, and question search.
- Current cursors encode an offset; switch individual deep-list queries to keyset cursors only when profiling justifies it.

Indexes already helpful:

- `idx_question_banks_subject`
- `idx_question_import_jobs_status_stage`
- `idx_question_import_jobs_ready`
- `idx_questions_subject_type`
- `idx_user_question_answers_user_question_answered_at`
- `idx_user_practice_sessions_user_started`

Recommended additional implementation practices:

- Wrap multi-table writes in transactions.
- Batch insert parsed questions.
- Cache subject/type lists.
- Keep overview reads cacheable and open the import SSE stream only while a job is active; retain polling fallback.
- Avoid loading full question content blocks for list views.

## 9. Current Repository Boundaries

- `taro/` contains the WeChat Mini Program baseline; `docs/taro-migration.md` defines its staged rollout.
- `server/` contains the unified Python FastAPI service (API + AI + import worker + admin CLI).
- `db/` contains bootstrap product SQL and is the schema source of truth; it is not a versioned production migration history.
- `docs/membership-design.md` is authoritative for effective membership, public-bank cloning, and study groups.
- No Web client or static bundle server ships in this repository; unmatched `/api/*` routes return the structured API `NOT_FOUND` envelope.
