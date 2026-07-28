package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"practiq/internal/api"
	"practiq/internal/auth"
	"practiq/internal/redisx"
)

type ImportJob struct {
	ID                     int64    `json:"id"`
	CreatedBy              int64    `json:"created_by"`
	BankID                 *int64   `json:"bank_id"`
	Status                 string   `json:"status"`
	Stage                  string   `json:"stage"`
	AvailableAt            *string  `json:"available_at"`
	PersistQuestions       bool     `json:"persist_questions"`
	RequestPayload         string   `json:"request_payload"`
	RawResultJSON          *string  `json:"raw_result_json"`
	WarningMessages        string   `json:"warning_messages"`
	TotalQuestions         int      `json:"total_questions"`
	ImportedQuestions      int      `json:"imported_questions"`
	FileName               *string  `json:"file_name"`
	SourceType             *string  `json:"source_type"`
	RetryCount             int      `json:"retry_count"`
	QualityScore           float64  `json:"quality_score"`
	OverallProgressPercent *float64 `json:"overall_progress_percent"`
	StepProgressPercent    *float64 `json:"step_progress_percent"`
	LastErrorCode          *string  `json:"last_error_code"`
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
}

type ImportJobChildKind string

const (
	ImportJobChildrenEvents    ImportJobChildKind = "events"
	ImportJobChildrenOutputs   ImportJobChildKind = "outputs"
	ImportJobChildrenArtifacts ImportJobChildKind = "artifacts"

	ImportWorkerFailedCode           = "IMPORT_WORKER_FAILED"
	ImportAttemptsExhaustedCode      = "IMPORT_ATTEMPTS_EXHAUSTED"
	ImportPersistenceInterruptedCode = "IMPORT_PERSISTENCE_INTERRUPTED"
)

const insertSourceArtifactSQL = `
	WITH inserted AS (
		INSERT INTO question_import_job_artifacts (job_id, artifact_type, storage_path, content_json)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (job_id) WHERE artifact_type = 'source_file' DO NOTHING
		RETURNING *
	)
	SELECT row_to_json(inserted)::text FROM inserted
`

const listImportJobEventsAfterSQL = `
	SELECT row_to_json(item)::text
	FROM (
		SELECT *
		FROM question_import_job_events
		WHERE job_id = $1 AND id > $2
		ORDER BY id
		LIMIT 1000
	) item
`

func ListImportJobs(ctx context.Context, pool *pgxpool.Pool, user auth.User, status, cursor string, requestedLimit int) (Page[ImportJob], error) {
	statuses := strings.Split(strings.TrimSpace(status), ",")
	allowedStatuses := map[string]bool{"queued": true, "processing": true, "completed": true, "failed": true, "cancelled": true}
	if strings.TrimSpace(status) == "" {
		status = ""
	} else {
		for index := range statuses {
			statuses[index] = strings.TrimSpace(statuses[index])
			if !allowedStatuses[statuses[index]] {
				return Page[ImportJob]{}, api.ValidationError([]api.ValidationDetail{{Field: "status", Message: "must contain only queued, processing, completed, failed, cancelled"}})
			}
		}
		status = strings.Join(statuses, ",")
	}
	limit := clampPositive(requestedLimit, 30, 100)
	offset, err := parsePageCursor(cursor)
	if err != nil {
		return Page[ImportJob]{}, err
	}
	rows, err := pool.Query(ctx, `
		SELECT row_to_json(job)::text
		FROM (
			SELECT *
			FROM question_import_jobs
			WHERE created_by = $1
			  AND ($2::text IS NULL OR status = ANY(string_to_array($2, ',')))
			ORDER BY created_at DESC
			LIMIT $3 OFFSET $4
		) job
	`, user.ID, nullableTrimmed(status), limit+1, offset)
	if err != nil {
		return Page[ImportJob]{}, err
	}
	defer rows.Close()

	jobs := make([]ImportJob, 0, 8)
	for rows.Next() {
		job, err := scanImportJobJSON(rows)
		if err != nil {
			return Page[ImportJob]{}, err
		}
		jobs = append(jobs, job)
	}
	if err := rows.Err(); err != nil {
		return Page[ImportJob]{}, err
	}
	return buildPage(jobs, limit, offset), nil
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
	`, user.ID, nullableInt64Pointer(input.BankID), nullableStringPtr(input.FileName), sourceType, payloadJSON)
}

func AddImportJobFile(ctx context.Context, pool *pgxpool.Pool, user auth.User, jobID int64, input AddImportJobFileInput) (map[string]any, error) {
	artifactType := strings.TrimSpace(input.ArtifactType)
	if artifactType == "" {
		artifactType = "source_file"
	}
	if artifactType != "source_file" {
		return nil, api.ValidationError([]api.ValidationDetail{{Field: "artifactType", Message: "must be source_file"}})
	}
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

	if err := validateImportArtifactContent(sourceType, input.Content); err != nil {
		return nil, err
	}
	contentJSON := cloneJSONMap(input.Content)
	contentJSON["sourceType"] = sourceType
	rawContent, err := marshalJSONString(contentJSON)
	if err != nil {
		return nil, err
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

	artifact, err := queryJSONMapTx(ctx, tx, insertSourceArtifactSQL, jobID, artifactType, nullableStringPtr(input.StoragePath), rawContent)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, api.NewError(409, "IMPORT_SOURCE_EXISTS", "Import job already has a source file", nil)
	}
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

	if err := ensureImportJobQueueActionAllowed(job, action); err != nil {
		return ImportJob{}, err
	}

	if action == "cancel" {
		updated, event, err := applyImportQueueTransition(ctx, pool, job, transition)
		if err != nil {
			return ImportJob{}, err
		}
		publishImportEvent(ctx, jobID, event)
		invalidateUserAnalytics(ctx, user.ID)
		return updated, nil
	}
	if err := ensureImportJobHasSourceArtifact(ctx, pool, jobID); err != nil {
		return ImportJob{}, err
	}
	if importJobAlreadyScheduled(job) {
		return job, nil
	}

	updated, event, err := applyImportQueueTransition(ctx, pool, job, transition)
	if err != nil {
		return ImportJob{}, err
	}
	publishImportEvent(ctx, jobID, event)
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
	if importJobAlreadyScheduled(job) {
		return job, nil
	}

	persistQuestions := true
	if options.PersistQuestions != nil {
		persistQuestions = *options.PersistQuestions
	}
	transition := queueTransitionForParse(persistQuestions)
	updated, event, err := applyImportQueueTransition(ctx, pool, job, transition)
	if err != nil {
		return ImportJob{}, err
	}
	publishImportEvent(ctx, jobID, event)
	invalidateUserAnalytics(ctx, user.ID)
	return updated, nil
}

func ensureImportJobQueueActionAllowed(job ImportJob, action string) error {
	if (action == "retry" || action == "parse") && valueOrEmpty(job.LastErrorCode) == ImportPersistenceInterruptedCode {
		return api.NewError(409, "IMPORT_RETRY_UNSAFE", "Import persistence was interrupted and cannot be retried automatically", nil)
	}
	if job.Status == "completed" {
		return api.NewError(409, "IMPORT_ALREADY_COMPLETED", "Completed import jobs cannot be queued again", nil)
	}
	if action == "cancel" && job.Status != "queued" && job.Status != "processing" {
		return api.NewError(409, "IMPORT_CANCEL_NOT_ALLOWED", "Only queued or processing import jobs can be cancelled", nil)
	}
	if action == "retry" && job.Status != "failed" {
		return api.NewError(409, "IMPORT_RETRY_NOT_ALLOWED", "Only failed import jobs can be retried", nil)
	}
	return nil
}

func importJobAlreadyScheduled(job ImportJob) bool {
	return job.Status == "processing" || (job.Status == "queued" && job.AvailableAt != nil)
}

func RecordImportJobFailure(ctx context.Context, pool *pgxpool.Pool, jobID, claimVersion int64, errorCode string, importErr error) (ImportJob, error) {
	message := "导入失败，请稍后重试或联系管理员。"
	if strings.TrimSpace(errorCode) == "" {
		errorCode = ImportWorkerFailedCode
	}
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
				last_error_code = $4,
				error_payload = $3,
				available_at = NULL,
				overall_progress_percent = 100,
				step_progress_percent = 100,
				last_event_id = $5,
				last_event_at = NOW(),
				completed_at = NOW()
			WHERE id = $1 AND status = 'processing' AND claim_version = $6
			RETURNING *
		)
		SELECT row_to_json(updated)::text FROM updated
	`, jobID, message, internalPayload, errorCode, eventID, claimVersion)
	if err != nil {
		return ImportJob{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return ImportJob{}, err
	}
	publishImportEvent(ctx, jobID, event)
	return updated, nil
}

func ListImportJobChildren(ctx context.Context, pool *pgxpool.Pool, user auth.User, jobID int64, kind ImportJobChildKind) ([]map[string]any, error) {
	if _, err := GetImportJob(ctx, pool, user, jobID); err != nil {
		return nil, err
	}
	return listImportJobChildrenForJob(ctx, pool, jobID, kind)
}

func ListImportJobEventsAfter(ctx context.Context, pool *pgxpool.Pool, user auth.User, jobID, afterID int64) ([]map[string]any, error) {
	if _, err := GetImportJob(ctx, pool, user, jobID); err != nil {
		return nil, err
	}
	rows, err := pool.Query(ctx, listImportJobEventsAfterSQL, jobID, afterID)
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
	case ImportJobChildrenArtifacts:
		return `SELECT row_to_json(item)::text FROM (SELECT * FROM question_import_job_artifacts WHERE job_id = $1 ORDER BY id) item`, nil
	case ImportJobChildrenOutputs:
		return `SELECT row_to_json(item)::text FROM (SELECT * FROM question_import_job_outputs WHERE job_id = $1 ORDER BY id LIMIT 200) item`, nil
	default:
		return "", api.NewError(400, "INVALID_IMPORT_CHILD_KIND", "Unsupported import child kind", nil)
	}
}

func applyImportQueueTransition(ctx context.Context, pool *pgxpool.Pool, job ImportJob, transition importQueueTransition) (ImportJob, map[string]any, error) {
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
					last_error_code = CASE WHEN $3::text IS NULL THEN NULL ELSE 'IMPORT_CANCELLED' END,
				error_payload = CASE WHEN $3::text IS NULL THEN NULL ELSE error_payload END,
				persist_questions = COALESCE($4::boolean, persist_questions),
				retry_count = CASE WHEN $5 THEN 0 ELSE retry_count END,
				available_at = CASE WHEN $6 THEN NOW() ELSE NULL END,
				overall_progress_percent = CASE WHEN $6 THEN 0 ELSE overall_progress_percent END,
				step_progress_percent = CASE WHEN $6 THEN 0 ELSE step_progress_percent END,
				completed_at = CASE WHEN $7 THEN NOW() ELSE NULL END
			WHERE id = $8
			  AND status = $9
			  AND (NOT $6::boolean OR available_at IS NULL)
			RETURNING *
		)
		SELECT row_to_json(updated)::text FROM updated
	`, transition.status, transition.stage, nullableStringPtr(transition.message), nullableBoolPtr(transition.persistQuestions), transition.resetAttempts, transition.available, transition.completed, job.ID, job.Status)
	if errors.Is(err, pgx.ErrNoRows) {
		return ImportJob{}, nil, api.NewError(409, "IMPORT_STATE_CHANGED", "Import job state changed; refresh and try again", nil)
	}
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
	`, job.ID, transition.stage, transition.stepCode, transition.stepLabel, transition.eventStatus, nullableStringPtr(transition.message), updated.OverallProgressPercent)
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
	_ = redisx.PublishJSON(ctx, rdb, redisx.ImportEventChannel(jobID), event)
}

func invalidateUserAnalytics(ctx context.Context, userID int) {
	rdb := redisx.Client()
	if rdb == nil {
		return
	}
	_ = rdb.Incr(ctx, redisx.RedisKey("cache-version", "analytics", userID)).Err()
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

func nullableBoolPtr(value *bool) any {
	if value == nil {
		return nil
	}
	return *value
}

func valueOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func errorMessage(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
