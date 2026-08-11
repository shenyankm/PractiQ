# PractiQ System Design

This document designs the application services, UI pages, and core modules from the authoritative split PostgreSQL schema files in `db/*/*.sql`.

The starter Drizzle/team layer has been explicitly retired. Treat the business-area SQL files under `db/` as the product data model for the question-bank system, and do not reintroduce a parallel ORM schema until it is generated from or proven equivalent to those SQL files.

The files under `db/*/*.sql` are bootstrap schema fragments for fresh local, test, or reset environments. They are not a reversible production migration history; production data-preserving schema changes should be added as explicit versioned migrations before rollout.

## 中文摘要

本文档基于 `db/*/*.sql` 中按业务拆分的 PostgreSQL schema 设计 PractiQ 题库系统的完整产品形态，覆盖：

- 后端 REST API：用户认证、题库、题目、题组、练习会话、导入任务、媒体资源、统计分析。
- 前端页面：登录注册、仪表板、题库列表和详情、题目管理、练习作答、文件导入、用户设置。
- 核心模块：认证授权、题库权限、题型渲染与判分、导入流水线、媒体管理、统计分析。
- 工程约束：数据关联、事务边界、参数校验、错误模型、状态生命周期和性能策略。

当前仓库已移除旧的 Drizzle/team schema；正式开发仍应以 `db/` 下的业务 SQL 文件和本文档为准，并继续替换遗留的 team/dashboard 页面与路由。

## Redis Integration

Redis is an acceleration and live-event layer, not the system of record. PostgreSQL remains authoritative for users, question banks, questions, import jobs, events, answers, and statistics.

Current Redis responsibilities:

- Cache-aside reads for user profiles, practice question queues, and analytics summaries.
- Rate limit counters for authentication endpoints.
- Session revocation records.
- Best-effort Redis Pub/Sub import notifications; clients read the durable `question_import_job_events` history by polling.
- Cached leaderboard and analytics snapshot endpoints for higher-cost reporting views.
- Successful responses for mobile mutations carrying `Idempotency-Key`, retained for 24 hours.
- PostgreSQL full-text search enhancement for question search, with `ILIKE` fallback behavior.

Failure policy:

- Cache misses or Redis cache errors fall back to PostgreSQL.
- Session validation, session revocation on logout, and authentication rate limits require Redis. Those paths fail closed with `503` when Redis is unavailable.
- Requests carrying `Idempotency-Key` also fail closed with `503` when Redis is unavailable so a retry cannot create duplicate writes.
- Import processing and client progress polling continue from PostgreSQL without Redis.
- Redis deployments should enable persistence and avoid evicting active session-revocation keys.

## 1. Domain Model

### Core Entities

| Domain | Tables | Purpose |
| --- | --- | --- |
| Identity | `users` | Local username/email/password user accounts, active flag, membership tier |
| Taxonomy | `subjects`, `question_types`, `knowledge_points` | Subject/type classification and knowledge hierarchy |
| Question banks | `question_banks`, `user_bank_links`, `user_bank_stats` | User-owned public/private banks, favorites, per-user bank stats |
| Questions | `questions`, `question_groups`, `bank_question_links`, `bank_group_links`, `group_question_links`, `v_bank_question_items` | Standalone and grouped questions inside banks |
| Answer models | `question_options`, `question_answer_keys` | Choice options and canonical answer payloads |
| Import pipeline | `question_import_jobs`, `question_import_job_events`, `question_import_job_artifacts`, `question_import_job_outputs` | File import orchestration, source artifacts, events, and generated-question links |
| Media | `media_assets`, `question_media_links`, `question_option_media_links`, `question_group_media_links`, `question_content_blocks` | Uploaded images and schema-supported rich content blocks |
| Practice | `user_practice_sessions`, `user_question_answers`, `user_question_stats` | Practice sessions, submitted answers, per-question user stats |

### Important Invariants

- `questions.subject_id` and `question_type_id` must match an existing `(subject_id, type_id)` in `question_types`.
- Bank links carry trigger-filled subject fields so a bank can only contain same-subject questions/groups.
- Group-question links also carry trigger-filled subject fields so a group cannot contain cross-subject questions.
- Import outputs connect source jobs to generated questions.
- Answer submissions update `user_question_stats`, `user_bank_stats`, and `user_practice_sessions` through database triggers.
- `question_answer_keys` allows only one primary answer key per question.
- `media_assets.created_by` owns every uploaded asset; the fresh schema requires it and media reads still follow bank visibility.
- Import jobs use the terminal `cancelled` status directly.

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

Use cookie-based sessions for web UI and bearer tokens only for service-to-service or mobile clients. Mobile clients send the session JWT (returned as `token`/`expiresAt` in login and register responses alongside the cookie) as `Authorization: Bearer <token>`; the resolver prefers the cookie and falls back to the bearer header, and logout revokes whichever token was presented.

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/api/v1/auth/register` | Public | Validate local registration details, create `users` row, and hash password. |
| `POST` | `/api/v1/auth/login` | Public | Verify username/email + password, set session cookie. |
| `POST` | `/api/v1/auth/logout` | User | Persist Redis session revocation, then clear the session cookie. |
| `GET` | `/api/v1/auth/me` | User | Return current user profile and capability flags. |
| `PATCH` | `/api/v1/users/me` | User | Update username/email/password. |
| `PATCH` | `/api/v1/users/:id/status` | Admin | Set `is_active`. |

Register body:

```json
{
  "username": "alice",
  "email": "alice@example.com",
  "password": "minimum-12-chars"
}
```

Registration requires a 3-20 character ASCII username containing only letters, numbers, and underscores; an email address of at most 254 characters; and an 8-72 byte password.

`GET /api/v1/auth/me` returns `401 UNAUTHENTICATED` when no valid session exists. Profile updates accept explicit `email: null`; password changes require the current password.

Authorization checks:

- `is_active=false` blocks all mutating routes and practice start.
- `membership` gates quotas such as max private banks, import file size, and concurrent import jobs.
- There is no OAuth table; only local credentials are supported by this schema.

### Subjects and Question Types

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/subjects` | Public/User | List subjects. |
| `GET` | `/api/v1/question-types?subject=math&scope=question` | Public/User | List supported question types. |
| `GET` | `/api/v1/knowledge-points?subject=math&parentId=...` | User | Browse knowledge tree. |
| `POST` | `/api/v1/knowledge-points` | Admin | Create knowledge point. |
| `PATCH` | `/api/v1/knowledge-points/:id` | Admin | Update knowledge point. |

### Question Banks

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/banks` | User | List owned, favorited, and public banks. |
| `POST` | `/api/v1/banks` | User | Create bank and `user_bank_links(is_owner=true)`. |
| `GET` | `/api/v1/banks/:bankId` | Bank reader | Bank detail with stats and permissions. |
| `PATCH` | `/api/v1/banks/:bankId` | Bank owner | Update name, description, public flag. |
| `DELETE` | `/api/v1/banks/:bankId` | Bank owner | Delete bank and cascading links. |
| `POST` | `/api/v1/banks/:bankId/favorite` | User | Add/update `user_bank_links(is_favorite=true)`. |
| `DELETE` | `/api/v1/banks/:bankId/favorite` | User | Remove favorite or clear favorite flag. |
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
| `GET` | `/api/v1/import-jobs/:jobId/artifacts` | Job owner | Source artifacts. |
| `GET` | `/api/v1/import-jobs/:jobId/outputs` | Job owner | Generated questions from `question_import_job_outputs`. |
| `POST` | `/api/v1/import-jobs/:jobId/retry` | Job owner | Retry a failed job. |
| `POST` | `/api/v1/import-jobs/:jobId/cancel` | Job owner | Move a queued or processing job to terminal `cancelled`. |

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
2. Store one TXT or DOCX source as `question_import_job_artifacts`.
3. Schedule the job by setting `available_at`.
4. Claim it atomically with `FOR UPDATE SKIP LOCKED` and mark it `processing`.
5. Ask the internal AI service to parse the document.
6. Create each question, answer, content block, and output link; then persist parsed groups using their question indexes.
7. Emit durable `question_import_job_events` and update counters and terminal status. Web and mobile poll the job/event endpoints.

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

## 3. Frontend Pages

Use the React + Vite app under `frontend/` with React Router routes:

```text
frontend/src/routes.tsx
/
/pricing
/sign-in
/sign-up
/dashboard
/banks
/banks/new
/banks/:bankId
/banks/:bankId/manage
/banks/:bankId/practice
/practice/:sessionId
/imports
/imports/:jobId
/questions/:questionId
/settings
/admin
/admin/knowledge-points
/admin/users
```

The PractiQ-branded Expo client lives under `mobile/` and exposes the same non-admin learning flows through Expo Router. It authenticates with the bearer form of the session token, validates API payloads with Zod, reads cached REST resources first, and revalidates them when focused. Offline mutations are stored in `practiq-cache.db`, replayed in creation order with a stable `Idempotency-Key`, and removed only after a successful response. PostgreSQL remains authoritative; the retired legacy local question database is not initialized or uploaded.

### Login and Registration

Pages:

- `/sign-in`
- `/sign-up`

Interactions:

- Validate username/email/password on client and server.
- On login, redirect to `/dashboard`.
- Show account inactive errors distinctly.

UI states:

- Loading submit button.
- Field-level validation.
- Invalid credentials.
- Session expired.
- Centered responsive card layout for sign-in and sign-up forms.

### Dashboard

Route: `/dashboard`

Widgets:

- Owned banks count.
- Favorite/public banks.
- Recent practice sessions.
- Accuracy trend from `user_question_stats`.
- Import jobs requiring review.
- Recently edited banks/questions.

Primary calls:

- `GET /api/v1/auth/me`
- `GET /api/v1/banks?scope=mine&limit=5`
- `GET /api/v1/practice-sessions?limit=5`
- `GET /api/v1/import-jobs?status=processing,failed&limit=5`
- `GET /api/v1/analytics/me/summary`

### Bank List

Route: `/banks`

Controls:

- Tabs: My banks, Favorites, Public.
- Filters: subject, keyword, visibility.
- Sort: recently updated, name, last practiced.
- Create bank dialog.

Cards/table columns:

- Name, subject, total count, visibility, owner, last practiced, actions.

### Bank Detail

Route: `/banks/[bankId]`

Views:

- Overview: description, stats, subject, actions.
- Items: unified `v_bank_question_items`.
- Practice launcher.
- Import status panel.

Interactions:

- Start practice.
- Favorite/unfavorite.
- Owner: edit bank, delete bank, manage questions, import file.

### Question Management

Route: `/banks/[bankId]/manage`

Layout:

- Left: bank item list with filters/status.
- Main: question editor.
- Right: answer key, metadata, knowledge points, media/content blocks.

Editor behavior:

- Type selector constrained by bank subject.
- Answer mode controls detail editor.
- Choice editor manages options and correctness.
- Fill blank editor manages slots.
- Short answer editor manages rubric and answer key.
- Publish action checks required answer data before `active`.

### Practice Page

Routes:

- `/banks/[bankId]/practice` to configure session.
- `/practice/[sessionId]` to answer.

Practice UI:

- Stable question navigation sidebar.
- Question stem and content blocks.
- Type-specific answer component.
- Submit button with immediate feedback in practice mode.
- Result drawer: correctness, explanation, score, next question.

Question type components:

- `ChoiceAnswer`: radio/checkbox depending on `choice_variant` or selection mode.
- `TrueFalseAnswer`: segmented true/false control.
- `FillBlankAnswer`: one input per slot in the canonical answer payload.
- `ShortAnswer`: textarea plus optional rubric after submit.

### Import Pages

Routes:

- `/imports`
- `/imports/[jobId]`

Upload workflow:

1. Select target bank.
2. Upload file.
3. Configure import request.
4. Start job.
5. Watch progress timeline.
6. Review flagged items.
7. Inspect outputs and publish/edit generated questions.

Job detail sections:

- Overall progress and current step.
- Pages coverage.
- Blocks list with status/risk.
- Review queue.
- Output questions/groups.
- Event log.

Realtime:

- Poll the durable job and event endpoints. There is no public SSE route.

### Settings

Route: `/settings`

Sections:

- Profile: username/email.
- Security: change password, active sessions.
- Membership: free/plus status and limits.
- Data: export/delete account flow.

## 4. Core Modules

### Auth Module

Responsibilities:

- Password hashing and verification.
- Session cookie creation and validation.
- Current-user lookup.
- `requireUser`, `requireActiveUser`, `requireAdmin` helpers.

Recommended files:

```text
lib/server/auth/password.ts
lib/server/auth/session.ts
lib/server/auth/guards.ts
```

### Authorization Module

Responsibilities:

- Resolve bank access: owner, favorite, public reader.
- Enforce editor operations for bank owners.
- Ensure import job belongs to requesting user or target bank owner.
- Ensure practice session belongs to current user.

Access matrix:

| Resource | Read | Write |
| --- | --- | --- |
| Public bank | Any active user | Owner |
| Private bank | Owner or linked user | Owner |
| Question | Reader of any linked bank | Owner/editor of linked bank |
| Import job | Creator / bank owner | Creator / bank owner |
| Practice session | Session owner | Session owner |
| Media | Linked resource reader | Linked resource owner/editor |

### Bank Module

Responsibilities:

- Create bank and owner link in one transaction.
- Keep `question_banks.total_count` updated when adding/removing bank links.
- Query `v_bank_question_items` with filters and pagination.
- Reorder items with unique sort conflict handling.

### Search and Classification Module

Responsibilities:

- Search banks by name, subject, visibility, ownership, and last activity.
- Search questions by stem keyword, subject, question type, status, chapter, tags, knowledge points, and difficulty.
- Provide saved UI filters for bank management and practice setup.
- Keep list queries backed by existing indexes and cursor pagination.

Suggested endpoints:

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/api/v1/search/banks?q=&subject=&scope=` | Search visible banks |
| `GET` | `/api/v1/search/questions?q=&bankId=&type=&status=` | Search editable/readable questions |
| `GET` | `/api/v1/search/knowledge-points?q=&subject=` | Search knowledge tree |

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
- Durable event persistence and live Redis publication.

Worker boundaries:

```text
Upload API -> import job queued
Worker: queued -> processing
Worker: parse source through internal AI service
Worker: questions/links/outputs
Worker: completed or failed
```

### AI Workflow

The unified Python server exposes document parsing, answer generation, and learning-report operations, built on AgentScope 2.x with DashScope models. TXT is decoded as UTF-8, DOCX text is pulled from `word/document.xml` with bounded archive inspection (including embedded images and OMML formula passthrough), PDF text is extracted with pypdfium2 (scanned pages are rendered via pypdfium2 and OCR'd by the vision model, which also detects figures and returns bounding-box crops), and XLSX sheets are flattened with openpyxl. Long documents are split on question boundaries into chunks; each chunk goes through one structured-output call with validation-feedback retries, and the results are merged and deduplicated. When no `DASHSCOPE_API_KEY` is configured the AI routes return 503.

AI capabilities are called in-process behind user-facing routes (session auth + Plus entitlement); there is no internal HTTP hop:

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/ai/parse-document` | Parse TXT, DOCX, PDF, or XLSX content. |
| `POST` | `/api/v1/ai/generate-answer` | Generate an answer and explanation. |
| `POST` | `/api/v1/ai/learning-report` | Generate a learning report. |

`DASHSCOPE_API_KEY` enables the AgentScope-backed models; `AI_TEXT_MODEL` and `AI_VL_MODEL` select them (defaults `qwen-max` and `qwen-vl-max`). `AI_AGENT_*` settings bound tokens and timeouts, and `AI_MAX_OCR_PAGES` caps scanned-PDF OCR.

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

- User dashboard metrics from `user_question_stats`, `user_bank_stats`, `user_practice_sessions`.
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

Use Zod schemas at route boundaries.

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
| `CONFLICT` | 409 | Unique constraint/order/status conflict |
| `INVALID_STATE` | 409 | Operation not allowed in current lifecycle state |
| `IMPORT_FAILED` | 500 | Import worker failure |
| `RATE_LIMITED` | 429 | Quota or abuse protection |
| `SESSION_STORE_UNAVAILABLE` | 503 | Redis cannot verify or revoke a session |
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

- Opaque cursor pagination for banks, bank items, bank groups, import jobs, practice sessions, knowledge points, admin lists, and question search.
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
- Use React Router views with SWR/client-side fetching for dashboards and live import progress.
- Avoid loading full question content blocks for list views.

## 9. Implementation Roadmap

### Phase 1: Align Data Layer

- Keep `db/*/*.sql` as the only product schema source of truth; do not reintroduce the retired starter ORM layer or a parallel Drizzle migration path unless it is regenerated from the SQL files.
- Keep React Router PractiQ domain routes aligned with the FastAPI server routes.
- Add shared API response/error helpers.
- Add auth session guards.

### Phase 2: Core CRUD

- Users/auth.
- Subjects and question types.
- Bank list/detail/create/edit/delete.
- Question create/edit/publish/archive.
- Bank item list through `v_bank_question_items`.

### Phase 3: Practice

- Practice session creation.
- Question queue loading.
- Answer grading.
- Results and analytics pages.

### Phase 4: Import

- Upload endpoint and storage.
- Job creation/progress.
- PostgreSQL worker claiming and retries.
- Output inspection and publish flow.

### Phase 5: Media and Rich Content

- Media upload.
- Link editors.
- Content block editor.
- Markdown/formula/table rendering.

## 10. Current Repository Status

The repository is now organized around the current unified-stack implementation:

- `frontend/` contains the React + Vite + React Router browser app and frontend tests.
- `mobile/` contains the PractiQ-branded Expo Android/iOS client, SQLite cache/outbox, and mobile tests.
- `server/` contains the unified Python FastAPI service (API + AI + import worker + admin CLI).
- `db/` contains the product SQL schema (source of truth).

The retired starter Drizzle/team data layer is no longer the implementation baseline. Continue evolving the question-bank product against `db/*/*.sql`, the services in `server/services`, and the routes documented above.
