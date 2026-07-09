package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"openwook/internal/api"
	"openwook/internal/auth"
	importqueue "openwook/internal/imports"
	"openwook/internal/redisx"
)

type ImportJob struct {
	ID                     int64    `json:"id"`
	CreatedBy              int64    `json:"created_by"`
	BankID                 *int64   `json:"bank_id"`
	Status                 string   `json:"status"`
	Stage                  string   `json:"stage"`
	RequestPayload         string   `json:"request_payload"`
	RawResultJSON          *string  `json:"raw_result_json"`
	WarningMessages        string   `json:"warning_messages"`
	ErrorPayload           *string  `json:"error_payload"`
	TotalQuestions         int      `json:"total_questions"`
	ImportedQuestions      int      `json:"imported_questions"`
	FileName               *string  `json:"file_name"`
	SourceType             *string  `json:"source_type"`
	PageCount              int      `json:"page_count"`
	WaveCount              int      `json:"wave_count"`
	FailedBlockCount       int      `json:"failed_block_count"`
	BlockCount             int      `json:"block_count"`
	CompletedBlockCount    int      `json:"completed_block_count"`
	RetryCount             int      `json:"retry_count"`
	CoveragePercent        float64  `json:"coverage_percent"`
	QualityScore           float64  `json:"quality_score"`
	HighRiskBlockCount     int      `json:"high_risk_block_count"`
	ReviewItemCount        int      `json:"review_item_count"`
	OverallProgressPercent *float64 `json:"overall_progress_percent"`
	StepProgressPercent    *float64 `json:"step_progress_percent"`
	CurrentStepCode        *string  `json:"current_step_code"`
	CurrentStepLabel       *string  `json:"current_step_label"`
	CurrentTargetKind      *string  `json:"current_target_kind"`
	CurrentTargetName      *string  `json:"current_target_name"`
	LastErrorCode          *string  `json:"last_error_code"`
	RiskLevel              string   `json:"risk_level"`
	LastError              *string  `json:"last_error"`
	LastEventID            *int64   `json:"last_event_id"`
	LastEventAt            *string  `json:"last_event_at"`
	CreatedAt              string   `json:"created_at"`
	UpdatedAt              string   `json:"updated_at"`
	CompletedAt            *string  `json:"completed_at"`
}

type CreateImportJobInput struct {
	BankID         *int64
	FileName       *string
	SourceType     string
	RequestPayload map[string]any
}

type AddImportJobFileInput struct {
	ArtifactType string
	StoragePath  *string
	Content      map[string]any
	SourceType   string
}

type QueueImportJobOptions struct {
	PersistQuestions *bool
	Retry            bool
}

type ImportJobChildKind string

const (
	ImportJobChildrenEvents      ImportJobChildKind = "events"
	ImportJobChildrenPages       ImportJobChildKind = "pages"
	ImportJobChildrenBlocks      ImportJobChildKind = "blocks"
	ImportJobChildrenReviewItems ImportJobChildKind = "review-items"
	ImportJobChildrenOutputs     ImportJobChildKind = "outputs"
	ImportJobChildrenArtifacts   ImportJobChildKind = "artifacts"
)

func ListImportJobs(ctx context.Context, pool *pgxpool.Pool, user auth.User, status string) ([]ImportJob, error) {
	rows, err := pool.Query(ctx, `
		SELECT row_to_json(job)::text
		FROM (
			SELECT *
			FROM question_import_jobs
			WHERE created_by = $1
			  AND ($2::text IS NULL OR status = ANY(string_to_array($2, ',')))
			ORDER BY created_at DESC
			LIMIT 50
		) job
	`, user.ID, nullableTrimmed(status))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	jobs := make([]ImportJob, 0, 8)
	for rows.Next() {
		job, err := scanImportJobJSON(rows)
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, job)
	}
	return jobs, rows.Err()
}

func CreateImportJob(ctx context.Context, pool *pgxpool.Pool, user auth.User, input CreateImportJobInput) (ImportJob, error) {
	if input.BankID != nil {
		if err := requireBankOwner(ctx, pool, user, *input.BankID); err != nil {
			return ImportJob{}, err
		}
	}
	sourceType, err := normalizeImportSourceType(user, input.SourceType)
	if err != nil {
		return ImportJob{}, err
	}
	payloadJSON, err := marshalJSONString(input.RequestPayload)
	if err != nil {
		return ImportJob{}, err
	}
	return queryImportJob(ctx, pool, `
		WITH inserted AS (
			INSERT INTO question_import_jobs (created_by, bank_id, file_name, source_type, request_payload)
			VALUES ($1, $2, $3, $4, $5)
			RETURNING *
		)
		SELECT row_to_json(inserted)::text FROM inserted
	`, user.ID, nullableImportInt64(input.BankID), nullableStringPtr(input.FileName), sourceType, payloadJSON)
}

func AddImportJobFile(ctx context.Context, pool *pgxpool.Pool, user auth.User, jobID int64, input AddImportJobFileInput) (map[string]any, error) {
	job, err := GetImportJob(ctx, pool, user, jobID)
	if err != nil {
		return nil, err
	}
	if input.StoragePath == nil && len(input.Content) == 0 {
		return nil, api.NewError(400, "SOURCE_FILE_REQUIRED", "Import artifact requires storagePath or content", nil)
	}

	jobSourceType := ""
	if job.SourceType != nil {
		jobSourceType = *job.SourceType
	}
	sourceHint := strings.TrimSpace(input.SourceType)
	if sourceHint == "" {
		sourceHint = extractSourceTypeFromArtifact(valueOrEmpty(input.StoragePath), input.Content)
	}
	if sourceHint == "" {
		sourceHint = jobSourceType
	}
	sourceType, err := normalizeImportSourceType(user, sourceHint)
	if err != nil {
		return nil, err
	}

	contentJSON := cloneJSONMap(input.Content)
	contentJSON["sourceType"] = sourceType
	rawContent, err := marshalJSONString(contentJSON)
	if err != nil {
		return nil, err
	}
	artifactType := strings.TrimSpace(input.ArtifactType)
	if artifactType == "" {
		artifactType = "source_file"
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	if _, err := queryImportJobTx(ctx, tx, `
		WITH updated AS (
			UPDATE question_import_jobs
			SET source_type = $1
			WHERE id = $2
			RETURNING *
		)
		SELECT row_to_json(updated)::text FROM updated
	`, sourceType, jobID); err != nil {
		return nil, err
	}

	artifact, err := queryJSONMapTx(ctx, tx, `
		WITH inserted AS (
			INSERT INTO question_import_job_artifacts (job_id, artifact_type, storage_path, content_json)
			VALUES ($1, $2, $3, $4)
			RETURNING *
		)
		SELECT row_to_json(inserted)::text FROM inserted
	`, jobID, artifactType, nullableStringPtr(input.StoragePath), rawContent)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return artifact, nil
}

func GetImportJob(ctx context.Context, pool *pgxpool.Pool, user auth.User, jobID int64) (ImportJob, error) {
	job, err := queryImportJob(ctx, pool, `
		SELECT row_to_json(job)::text
		FROM (
			SELECT *
			FROM question_import_jobs
			WHERE id = $1 AND created_by = $2
			LIMIT 1
		) job
	`, jobID, user.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ImportJob{}, api.NewError(404, "NOT_FOUND", "Import job not found", nil)
	}
	return job, err
}

func UpdateImportJobStatus(ctx context.Context, pool *pgxpool.Pool, user auth.User, jobID int64, action string) (ImportJob, error) {
	job, err := GetImportJob(ctx, pool, user, jobID)
	if err != nil {
		return ImportJob{}, err
	}
	transition, err := queueTransitionForAction(action)
	if err != nil {
		return ImportJob{}, err
	}

	if action == "cancel" {
		updated, event, err := applyImportQueueTransition(ctx, pool, jobID, transition)
		if err != nil {
			return ImportJob{}, err
		}
		publishImportEvent(ctx, jobID, event)
		if runtime, err := queueRuntime(); err == nil && runtime != nil {
			_, _ = runtime.CancelPendingJob(ctx, int(jobID))
		}
		invalidateUserAnalytics(ctx, user.ID)
		return updated, nil
	}
	if err := ensureImportJobQueueActionAllowed(job, action); err != nil {
		return ImportJob{}, err
	}
	if err := ensureImportJobHasSourceArtifact(ctx, pool, jobID); err != nil {
		return ImportJob{}, err
	}
	runtime, err := queueRuntimeOrError()
	if err != nil {
		return ImportJob{}, err
	}
	if pending, err := runtime.HasPendingJob(ctx, int(jobID)); err != nil {
		return ImportJob{}, err
	} else if pending {
		return job, nil
	}

	updated, event, err := applyImportQueueTransition(ctx, pool, jobID, transition)
	if err != nil {
		return ImportJob{}, err
	}
	publishImportEvent(ctx, jobID, event)

	payload := importqueue.NewQueuePayload(int(jobID), user.ID, true, time.Now(), 1)
	if err := runtime.EnqueueReady(ctx, payload); err != nil {
		if _, failureErr := RecordImportJobFailure(ctx, pool, jobID, err); failureErr != nil {
			return ImportJob{}, failureErr
		}
		return ImportJob{}, api.NewError(503, "IMPORT_QUEUE_UNAVAILABLE", "Failed to enqueue import job", nil)
	}
	invalidateUserAnalytics(ctx, user.ID)
	return updated, nil
}

func QueueImportJobForUser(ctx context.Context, pool *pgxpool.Pool, user auth.User, jobID int64, options QueueImportJobOptions) (ImportJob, error) {
	job, err := GetImportJob(ctx, pool, user, jobID)
	if err != nil {
		return ImportJob{}, err
	}
	if err := ensureImportJobQueueActionAllowed(job, "parse"); err != nil {
		return ImportJob{}, err
	}
	if err := ensureImportJobHasSourceArtifact(ctx, pool, jobID); err != nil {
		return ImportJob{}, err
	}
	runtime, err := queueRuntimeOrError()
	if err != nil {
		return ImportJob{}, err
	}
	if pending, err := runtime.HasPendingJob(ctx, int(jobID)); err != nil {
		return ImportJob{}, err
	} else if pending {
		return job, nil
	}

	transition := importQueueTransition{
		status:         "queued",
		stage:          "queued",
		stepCode:       "queue_parse",
		stepLabel:      "加入导入队列",
		eventStatus:    "queued",
		retryIncrement: boolToInt(options.Retry),
	}
	updated, event, err := applyImportQueueTransition(ctx, pool, jobID, transition)
	if err != nil {
		return ImportJob{}, err
	}
	publishImportEvent(ctx, jobID, event)

	persistQuestions := true
	if options.PersistQuestions != nil {
		persistQuestions = *options.PersistQuestions
	}
	payload := importqueue.NewQueuePayload(int(jobID), user.ID, persistQuestions, time.Now(), 1)
	if err := runtime.EnqueueReady(ctx, payload); err != nil {
		if _, failureErr := RecordImportJobFailure(ctx, pool, jobID, err); failureErr != nil {
			return ImportJob{}, failureErr
		}
		return ImportJob{}, api.NewError(503, "IMPORT_QUEUE_UNAVAILABLE", "Failed to enqueue import job", nil)
	}
	invalidateUserAnalytics(ctx, user.ID)
	return updated, nil
}

func ensureImportJobQueueActionAllowed(job ImportJob, action string) error {
	if job.Status == "completed" {
		return api.NewError(409, "IMPORT_ALREADY_COMPLETED", "Completed import jobs cannot be queued again", nil)
	}
	if action == "retry" && job.Status != "failed" && job.Status != "queued" && job.Status != "processing" {
		return api.NewError(409, "IMPORT_RETRY_NOT_ALLOWED", "Only failed import jobs can be retried", nil)
	}
	return nil
}

func RecordImportJobFailure(ctx context.Context, pool *pgxpool.Pool, jobID int64, importErr error) (ImportJob, error) {
	message := "导入失败，请稍后重试或联系管理员。"
	internalPayload, err := marshalJSONString(map[string]any{"last_internal_error": errorMessage(importErr)})
	if err != nil {
		return ImportJob{}, err
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return ImportJob{}, err
	}
	defer tx.Rollback(ctx)

	event, err := queryJSONMapTx(ctx, tx, `
		WITH inserted AS (
			INSERT INTO question_import_job_events (
				job_id, stage, step_code, step_label, status, message, overall_progress_percent, step_progress_percent
			)
			VALUES ($1, 'failed', 'import_failed', '导入失败', 'failed', $2, 100, 100)
			RETURNING *
		)
		SELECT row_to_json(inserted)::text FROM inserted
	`, jobID, message)
	if err != nil {
		return ImportJob{}, err
	}
	eventID, err := int64FromMap(event, "id")
	if err != nil {
		return ImportJob{}, err
	}

	updated, err := queryImportJobTx(ctx, tx, `
		WITH updated AS (
			UPDATE question_import_jobs
			SET
				status = 'failed',
				stage = 'failed',
				last_error = $2,
				last_error_code = 'IMPORT_WORKER_FAILED',
				error_payload = $3,
				overall_progress_percent = 100,
				step_progress_percent = 100,
				last_event_id = $4,
				last_event_at = NOW(),
				completed_at = NOW()
			WHERE id = $1
			RETURNING *
		)
		SELECT row_to_json(updated)::text FROM updated
	`, jobID, message, internalPayload, eventID)
	if err != nil {
		return ImportJob{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return ImportJob{}, err
	}
	publishImportEvent(ctx, jobID, event)
	return updated, nil
}

func ResolveImportReviewItem(ctx context.Context, pool *pgxpool.Pool, user auth.User, jobID, itemID int64, note *string) (map[string]any, error) {
	if _, err := GetImportJob(ctx, pool, user, jobID); err != nil {
		return nil, err
	}
	item, err := queryJSONMap(ctx, pool, `
		WITH updated AS (
			UPDATE question_import_job_review_items
			SET status = 'resolved', resolved_by = $1, resolution_note = $2, resolved_at = NOW()
			WHERE id = $3
			  AND job_id = $4
			  AND status = 'open'
			RETURNING *
		)
		SELECT row_to_json(updated)::text FROM updated
	`, user.ID, nullableStringPtr(note), itemID, jobID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, api.NewError(404, "NOT_FOUND", "Open review item not found", nil)
	}
	return item, err
}

func ListImportJobChildren(ctx context.Context, pool *pgxpool.Pool, user auth.User, jobID int64, kind ImportJobChildKind) ([]map[string]any, error) {
	if _, err := GetImportJob(ctx, pool, user, jobID); err != nil {
		return nil, err
	}
	return listImportJobChildrenForJob(ctx, pool, jobID, kind)
}

func ensureImportJobHasSourceArtifact(ctx context.Context, pool *pgxpool.Pool, jobID int64) error {
	var found int64
	err := pool.QueryRow(ctx, `
		SELECT id
		FROM question_import_job_artifacts
		WHERE job_id = $1
		  AND artifact_type = 'source_file'
		  AND (storage_path IS NOT NULL OR content_json IS NOT NULL)
		LIMIT 1
	`, jobID).Scan(&found)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.NewError(409, "SOURCE_FILE_REQUIRED", "Import job requires an uploaded TXT or DOCX source file before parsing", nil)
	}
	return err
}

func listImportJobChildrenForJob(ctx context.Context, pool *pgxpool.Pool, jobID int64, kind ImportJobChildKind) ([]map[string]any, error) {
	query, err := importJobChildrenQuery(kind)
	if err != nil {
		return nil, err
	}
	rows, err := pool.Query(ctx, query, jobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]map[string]any, 0, 8)
	for rows.Next() {
		item, err := scanJSONMap(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func importJobChildrenQuery(kind ImportJobChildKind) (string, error) {
	switch kind {
	case ImportJobChildrenEvents:
		return `SELECT row_to_json(item)::text FROM (SELECT * FROM question_import_job_events WHERE job_id = $1 ORDER BY id DESC LIMIT 100) item`, nil
	case ImportJobChildrenPages:
		return `SELECT row_to_json(item)::text FROM (SELECT * FROM question_import_job_pages WHERE job_id = $1 ORDER BY page_no) item`, nil
	case ImportJobChildrenBlocks:
		return `SELECT row_to_json(item)::text FROM (SELECT * FROM question_import_job_blocks WHERE job_id = $1 ORDER BY id LIMIT 200) item`, nil
	case ImportJobChildrenReviewItems:
		return `SELECT row_to_json(item)::text FROM (SELECT * FROM question_import_job_review_items WHERE job_id = $1 ORDER BY id LIMIT 200) item`, nil
	case ImportJobChildrenArtifacts:
		return `SELECT row_to_json(item)::text FROM (SELECT * FROM question_import_job_artifacts WHERE job_id = $1 ORDER BY id) item`, nil
	case ImportJobChildrenOutputs:
		return `SELECT row_to_json(item)::text FROM (SELECT * FROM question_import_job_outputs WHERE job_id = $1 ORDER BY id LIMIT 200) item`, nil
	default:
		return "", api.NewError(400, "INVALID_IMPORT_CHILD_KIND", "Unsupported import child kind", nil)
	}
}

func applyImportQueueTransition(ctx context.Context, pool *pgxpool.Pool, jobID int64, transition importQueueTransition) (ImportJob, map[string]any, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return ImportJob{}, nil, err
	}
	defer tx.Rollback(ctx)

	updated, err := queryImportJobTx(ctx, tx, `
		WITH updated AS (
			UPDATE question_import_jobs
			SET
				status = $1,
				stage = $2,
				last_error = $3,
				last_error_code = CASE WHEN $3::text IS NULL THEN NULL ELSE last_error_code END,
				retry_count = retry_count + $4,
				completed_at = CASE WHEN $5 THEN NOW() ELSE NULL END
			WHERE id = $6
			RETURNING *
		)
		SELECT row_to_json(updated)::text FROM updated
	`, transition.status, transition.stage, nullableStringPtr(transition.message), transition.retryIncrement, transition.completed, jobID)
	if err != nil {
		return ImportJob{}, nil, err
	}

	event, err := queryJSONMapTx(ctx, tx, `
		WITH inserted AS (
			INSERT INTO question_import_job_events (job_id, stage, step_code, step_label, status, message, overall_progress_percent)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			RETURNING *
		)
		SELECT row_to_json(inserted)::text FROM inserted
	`, jobID, transition.stage, transition.stepCode, transition.stepLabel, transition.eventStatus, nullableStringPtr(transition.message), updated.OverallProgressPercent)
	if err != nil {
		return ImportJob{}, nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return ImportJob{}, nil, err
	}
	return updated, event, nil
}

func publishImportEvent(ctx context.Context, jobID int64, event map[string]any) {
	rdb := redisx.Client()
	if rdb == nil {
		return
	}
	_ = redisx.AppendStreamJSON(ctx, rdb, redisx.ImportEventStreamKey(jobID), event)
	_ = redisx.PublishJSON(ctx, rdb, redisx.ImportEventChannel(jobID), event)
}

func invalidateUserAnalytics(ctx context.Context, userID int) {
	rdb := redisx.Client()
	if rdb == nil {
		return
	}
	_ = rdb.Incr(ctx, redisx.RedisKey("cache-version", "analytics", userID)).Err()
}

func queueRuntime() (*importqueue.QueueRuntime, error) {
	rdb := redisx.Client()
	if rdb == nil {
		return nil, nil
	}
	return importqueue.NewQueueRuntime(rdb, importqueue.LoadWorkerConfig())
}

func queueRuntimeOrError() (*importqueue.QueueRuntime, error) {
	runtime, err := queueRuntime()
	if err != nil || runtime == nil {
		return nil, api.NewError(503, "IMPORT_QUEUE_UNAVAILABLE", "Redis import queue is not configured", nil)
	}
	return runtime, nil
}

func requireBankOwner(ctx context.Context, pool *pgxpool.Pool, user auth.User, bankID int64) error {
	var found int64
	err := pool.QueryRow(ctx, `
		SELECT b.id
		FROM question_banks b
		JOIN user_bank_links ubl ON ubl.bank_id = b.id
		WHERE b.id = $1
		  AND ubl.user_id = $2
		  AND ubl.is_owner = true
		LIMIT 1
	`, bankID, user.ID).Scan(&found)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.NewError(403, "FORBIDDEN", "Bank owner access required", nil)
	}
	return err
}

func queryImportJob(ctx context.Context, pool *pgxpool.Pool, query string, args ...any) (ImportJob, error) {
	var raw string
	if err := pool.QueryRow(ctx, query, args...).Scan(&raw); err != nil {
		return ImportJob{}, err
	}
	return decodeImportJob(raw)
}

func queryImportJobTx(ctx context.Context, tx pgx.Tx, query string, args ...any) (ImportJob, error) {
	var raw string
	if err := tx.QueryRow(ctx, query, args...).Scan(&raw); err != nil {
		return ImportJob{}, err
	}
	return decodeImportJob(raw)
}

func scanImportJobJSON(rows pgx.Rows) (ImportJob, error) {
	var raw string
	if err := rows.Scan(&raw); err != nil {
		return ImportJob{}, err
	}
	return decodeImportJob(raw)
}

func decodeImportJob(raw string) (ImportJob, error) {
	var job ImportJob
	if err := json.Unmarshal([]byte(raw), &job); err != nil {
		return ImportJob{}, err
	}
	return job, nil
}

func queryJSONMap(ctx context.Context, pool *pgxpool.Pool, query string, args ...any) (map[string]any, error) {
	var raw string
	if err := pool.QueryRow(ctx, query, args...).Scan(&raw); err != nil {
		return nil, err
	}
	return decodeJSONMap(raw)
}

func queryJSONMapTx(ctx context.Context, tx pgx.Tx, query string, args ...any) (map[string]any, error) {
	var raw string
	if err := tx.QueryRow(ctx, query, args...).Scan(&raw); err != nil {
		return nil, err
	}
	return decodeJSONMap(raw)
}

func scanJSONMap(rows pgx.Rows) (map[string]any, error) {
	var raw string
	if err := rows.Scan(&raw); err != nil {
		return nil, err
	}
	return decodeJSONMap(raw)
}

func decodeJSONMap(raw string) (map[string]any, error) {
	var item map[string]any
	if err := json.Unmarshal([]byte(raw), &item); err != nil {
		return nil, err
	}
	return item, nil
}

func int64FromMap(value map[string]any, key string) (int64, error) {
	raw, ok := value[key]
	if !ok {
		return 0, fmt.Errorf("missing %s", key)
	}
	switch resolved := raw.(type) {
	case float64:
		return int64(resolved), nil
	case int64:
		return resolved, nil
	case int:
		return int64(resolved), nil
	default:
		return 0, fmt.Errorf("invalid %s type %T", key, raw)
	}
}

func marshalJSONString(value any) (string, error) {
	if value == nil {
		value = map[string]any{}
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

func cloneJSONMap(value map[string]any) map[string]any {
	if len(value) == 0 {
		return map[string]any{}
	}
	out := make(map[string]any, len(value))
	for key, raw := range value {
		out[key] = raw
	}
	return out
}

func nullableTrimmed(value string) any {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return trimmed
}

func nullableImportInt64(value *int64) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableStringPtr(value *string) any {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return trimmed
}

func valueOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func errorMessage(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
