# OpenWook System Design

This document designs the application services, UI pages, and core modules from the authoritative split PostgreSQL schema files in `db/*/*.sql`.

The current Next.js project still contains starter SaaS/team code in `lib/db/schema.ts` and several dashboard pages. Treat the business-area SQL files under `db/` as the product data model for the question-bank system; the Drizzle schema and existing routes should be replaced or regenerated before implementation.

## 中文摘要

本文档基于 `db/*/*.sql` 中按业务拆分的 PostgreSQL schema 设计 OpenWook 题库系统的完整产品形态，覆盖：

- 后端 REST API：用户认证、题库、题目、题组、练习会话、导入任务、媒体资源、统计分析。
- 前端页面：登录注册、仪表板、题库列表和详情、题目管理、练习作答、文件导入、用户设置。
- 核心模块：认证授权、题库权限、题型渲染与判分、导入流水线、媒体管理、统计分析。
- 工程约束：数据关联、事务边界、参数校验、错误模型、状态生命周期和性能策略。

当前代码仍保留部分 Next.js SaaS 模板实现；正式开发时应以 `db/` 下的业务 SQL 文件和本文档为准替换旧的 team/dashboard 业务。

## Redis Integration

Redis is an acceleration and coordination layer, not the system of record. PostgreSQL remains authoritative for users, question banks, questions, import jobs, events, answers, and statistics.

Current Redis responsibilities:

- Cache-aside reads for reference data, user profiles, visible bank lists, bank items, question detail, answer keys, and analytics summaries.
- Short-lived distributed locks for import parsing and answer submission.
- Rate limit counters for authentication endpoints.
- BullMQ queue for import parsing jobs; `question_import_jobs` keeps durable state.
- Redis Pub/Sub and SSE for live import progress; `question_import_job_events` keeps durable history.
- Practice-session question queues to keep active sessions stable after bank changes.
- AI result de-duplication cache for repeated document parsing, answer generation, and report generation inputs.
- Cached leaderboard and analytics snapshot endpoints for higher-cost reporting views.
- PostgreSQL full-text search enhancement for question search, with `ILIKE` fallback behavior.

Failure policy:

- Cache misses or Redis cache errors fall back to PostgreSQL.
- Queue and SSE features require Redis and should report `IMPORT_QUEUE_UNAVAILABLE` if Redis is not configured.
- Redis queue deployments should enable AOF persistence and avoid eviction policies that can delete BullMQ keys.

## 1. Domain Model

### Core Entities

| Domain | Tables | Purpose |
| --- | --- | --- |
| Identity | `users` | Local username/email/password user accounts, active flag, membership tier |
| Taxonomy | `subjects`, `question_types`, `knowledge_points`, `question_tags` | Subject/type classification, knowledge hierarchy, free-form tags |
| Question banks | `question_banks`, `user_bank_links`, `user_bank_stats` | User-owned public/private banks, favorites, per-user bank stats |
| Questions | `questions`, `question_groups`, `bank_question_links`, `bank_group_links`, `group_question_links`, `v_bank_question_items` | Standalone and grouped questions inside banks |
| Answer models | `question_choice_details`, `question_true_false_details`, `question_fill_blank_details`, `question_short_answer_details`, `question_options`, `question_answer_keys`, `question_fill_blank_slots`, `question_rubric_items` | Type-specific answer data, answer versions, scoring rubric |
| Enrichment | `question_educational_metadata`, `question_knowledge_point_links`, `question_provenance` | Difficulty, curriculum metadata, knowledge mapping, import/source trace |
| Import pipeline | `question_import_jobs`, `question_import_job_batches`, `question_import_job_pages`, `question_import_job_blocks`, `question_import_job_block_attempts`, `question_import_job_review_items`, `question_import_job_events`, `question_import_outbox_events`, `question_import_job_artifacts`, `question_import_job_outputs` | File import orchestration, block parsing, attempts, review, events, outputs |
| Media | `media_assets`, `question_media_links`, `question_option_media_links`, `question_subquestion_media_links`, `question_group_media_links`, `question_content_blocks` | Images, videos, QR codes, diagrams, rich content blocks |
| Practice | `user_practice_sessions`, `user_question_answers`, `user_question_stats` | Practice sessions, submitted answers, per-question user stats |

### Important Invariants

- `questions.subject_id` and `question_type_id` must match an existing `(subject_id, type_id)` in `question_types`.
- Bank links carry trigger-filled subject fields so a bank can only contain same-subject questions/groups.
- Group-question links also carry trigger-filled subject fields so a group cannot contain cross-subject questions.
- Import outputs connect parsing attempts to generated questions or groups.
- Answer submissions update `user_question_stats`, `user_bank_stats`, and `user_practice_sessions` through database triggers.
- `question_answer_keys` allows only one primary answer key per question.

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

Use cookie-based sessions for web UI and bearer tokens only for service-to-service or future mobile clients.

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/api/v1/auth/register` | Public | Create `users` row. Hash password. |
| `POST` | `/api/v1/auth/login` | Public | Verify username/email + password, set session cookie. |
| `POST` | `/api/v1/auth/logout` | User | Clear session cookie. |
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
GET /api/v1/banks/12/items?status=active&type=math_calculation&cursor=...
```

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
| `PUT` | `/api/v1/questions/:questionId/metadata` | Owner/editor | Upsert educational metadata. |
| `PUT` | `/api/v1/questions/:questionId/knowledge-points` | Owner/editor | Replace knowledge point links. |
| `PUT` | `/api/v1/questions/:questionId/content-blocks` | Owner/editor | Replace structured content. |

Question create body:

```json
{
  "subjectId": "math",
  "questionTypeId": "math_calculation",
  "answerMode": "fill_blank",
  "stem": "Solve 2x + 3 = 9.",
  "analysis": "Move 3, then divide by 2.",
  "status": "draft",
  "detailPayload": {},
  "fillBlankSlots": [
    {
      "blankRef": "x",
      "blankIndex": 1,
      "correctAnswer": "3",
      "acceptedAnswers": ["3", "3.0"]
    }
  ],
  "answerKey": {
    "answerPayload": { "slots": [{ "blankRef": "x", "answers": ["3"] }] },
    "scorePayload": { "maxScore": 1 }
  }
}
```

Choice question answer model:

- `question_choice_details.selection_mode`: `single` or `multiple`.
- `question_options`: labels, content, sort order, correctness.
- `question_answer_keys.answer_payload`: canonical answer, used by graders.

Fill blank answer model:

- `question_fill_blank_details.correct_answer`: legacy/simple JSON array text.
- `question_fill_blank_slots`: normalized slot model.
- `question_answer_keys`: versioned canonical answer payload.

### Question Groups

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/groups/:groupId` | Bank reader | Group detail with questions. |
| `PATCH` | `/api/v1/groups/:groupId` | Owner/editor | Update title/instructions/content. |
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
| `POST` | `/api/v1/import-jobs/:jobId/start` | Job owner | Move from queued to processing. |
| `GET` | `/api/v1/import-jobs/:jobId` | Job owner | Job summary and progress. |
| `GET` | `/api/v1/import-jobs/:jobId/events` | Job owner | Incremental event stream, cursor by event id. |
| `GET` | `/api/v1/import-jobs/:jobId/pages` | Job owner | Page analysis status. |
| `GET` | `/api/v1/import-jobs/:jobId/blocks` | Job owner | Block status, retries, selected attempts. |
| `GET` | `/api/v1/import-jobs/:jobId/review-items` | Job owner | Items needing manual review. |
| `POST` | `/api/v1/import-jobs/:jobId/review-items/:itemId/resolve` | Job owner | Resolve review item. |
| `GET` | `/api/v1/import-jobs/:jobId/outputs` | Job owner | Generated questions/groups from `question_import_job_outputs`. |
| `POST` | `/api/v1/import-jobs/:jobId/retry` | Job owner | Retry failed blocks/job. |
| `POST` | `/api/v1/import-jobs/:jobId/cancel` | Job owner | Mark job failed/cancelled; schema currently uses `failed`, so use error code `cancelled`. |

Create body:

```json
{
  "bankId": 12,
  "fileName": "algebra.pdf",
  "sourceType": "pdf",
  "requestPayload": {
    "subject": "math",
    "defaultQuestionTypeId": "math_calculation",
    "parseMode": "layout"
  }
}
```

Import worker flow:

1. Insert `question_import_jobs(status='queued', stage='queued')`.
2. Store uploaded file as `question_import_job_artifacts`.
3. Create `question_import_job_pages` and `question_import_job_blocks`.
4. For each block, create `question_import_job_block_attempts`.
5. Select best attempt by setting `question_import_job_blocks.selected_attempt_id`.
6. Create `questions` and optionally `question_groups`.
7. Create `bank_question_links` or `bank_group_links`.
8. Insert `question_import_job_outputs` for generated entities.
9. Insert `question_provenance`.
10. Emit `question_import_job_events` and `question_import_outbox_events`.
11. Update job counters and terminal status.

### Media

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/api/v1/media` | User | Upload image/diagram/QR/table asset. |
| `GET` | `/api/v1/media/:mediaId` | Owner/linked resource reader | Metadata. |
| `DELETE` | `/api/v1/media/:mediaId` | Owner/editor | Delete if not used, or soft-hide in storage layer. |
| `POST` | `/api/v1/questions/:questionId/media-links` | Owner/editor | Link media to question. |
| `POST` | `/api/v1/groups/:groupId/media-links` | Owner/editor | Link media to group. |
| `POST` | `/api/v1/options/:optionId/media-links` | Owner/editor | Link media to option. |

Supported `part_type` excludes audio. The UI should allow image, table, formula, HTML/Markdown, chart, diagram, and QR code content blocks.

Video policy:

- `media_assets` can store video metadata through `mime_type`, `duration_ms`, `storage_path`, and `external_url`.
- Video can be linked through the generic media link tables with `media_kind='video'`.
- `question_content_blocks.part_type` currently has no `video` enum, so video should render from media links, not structured content blocks, unless the schema is extended later.
- Audio upload and listening-specific UI remain out of scope because audio fields and listening tables were intentionally removed.

## 3. Frontend Pages

Use Next.js App Router route groups:

```text
app/(auth)/sign-in
app/(auth)/sign-up
app/(app)/dashboard
app/(app)/banks
app/(app)/banks/[bankId]
app/(app)/banks/[bankId]/manage
app/(app)/banks/[bankId]/practice
app/(app)/practice/[sessionId]
app/(app)/imports
app/(app)/imports/[jobId]
app/(app)/settings
```

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
- `FillBlankAnswer`: one input per `question_fill_blank_slots`.
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

- Start with polling every 2s.
- Upgrade to SSE endpoint later: `/api/v1/import-jobs/:jobId/events/stream`.

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
- Page/block extraction.
- Parser attempt orchestration.
- Review item creation.
- Output creation and provenance mapping.
- Event and outbox publication.

Worker boundaries:

```text
Upload API -> import job queued
Worker: queued -> processing
Worker: artifacts/pages/blocks
Worker: attempts/review
Worker: questions/groups/links/outputs/provenance
Worker: completed or failed
```

### Media Module

Responsibilities:

- Upload validation.
- Storage abstraction.
- `media_assets` metadata persistence.
- Link media to questions, groups, options, subquestions.
- Structured content block editing.
- Image/video metadata extraction.

Validation:

- Reject audio for question content because schema removed audio part type.
- Allow images and videos in `media_assets`; restrict direct content blocks to schema-supported part types.
- Restrict MIME types to image, video, SVG when sanitized, PDF-derived images, JSON chart payloads where applicable.

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
 -> worker creates pages/blocks/attempts
 -> worker creates questions/groups/links
 -> question_import_job_outputs connects source to generated objects
 -> question_provenance captures source page/block/text
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
failed -> queued (retry creates new events and increments retry_count)
```

Stage values should be standardized in service code:

- `queued`
- `uploading`
- `page_analysis`
- `block_detection`
- `parsing`
- `review`
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

- Cursor pagination for banks, bank items, import events, blocks, answers.
- Use `id` or `(created_at, id)` cursors.

Indexes already helpful:

- `idx_question_banks_subject`
- `idx_question_import_jobs_status_stage`
- `idx_question_import_job_blocks_job_status`
- `idx_questions_subject_type`
- `idx_user_question_answers_user_question_answered_at`
- `idx_user_practice_sessions_user_started`

Recommended additional implementation practices:

- Wrap multi-table writes in transactions.
- Batch insert import blocks/attempts.
- Cache subject/type lists.
- Use server-side rendering for dashboards, client-side SWR for live import progress.
- Avoid loading full question content blocks for list views.

## 9. Implementation Roadmap

### Phase 1: Align Data Layer

- Replace `lib/db/schema.ts` starter team schema with generated/handwritten mappings for the split SQL files under `db/*/*.sql`.
- Replace old team/SaaS dashboard routes with OpenWook domain routes.
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
- Worker abstraction.
- Review UI.
- Output inspection and publish flow.

### Phase 5: Media and Rich Content

- Media upload.
- Link editors.
- Content block editor.
- Markdown/formula/table rendering.

## 10. Current Repository Gap

The current worktree still contains:

- SaaS/team Drizzle schema in `lib/db/schema.ts`.
- Team/pricing/activity dashboard pages.

These are not aligned with the split product schema under `db/*/*.sql`. To make the project actually run as the designed question-bank product, the next implementation step is to replace the starter Drizzle schema, API routes, dashboard pages, and auth helpers with the modules described above.
