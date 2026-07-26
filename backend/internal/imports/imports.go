package imports

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrClaimLost = errors.New("import job claim lost")

const (
	MaxAttempts  = 3
	PollInterval = 500 * time.Millisecond
	ClaimTimeout = 30 * time.Minute
)

const claimNextJobSQL = `
	WITH next_job AS (
		SELECT
			id,
			status = 'processing' AND stage = 'persisting' AS persistence_started,
			retry_count >= $2 AS attempts_exhausted
		FROM question_import_jobs
		WHERE (
			status = 'queued'
			AND available_at IS NOT NULL
			AND available_at <= NOW()
		) OR (
			status = 'processing'
			AND updated_at <= NOW() - ($1 * INTERVAL '1 millisecond')
		)
		ORDER BY COALESCE(available_at, updated_at), id
		FOR UPDATE SKIP LOCKED
		LIMIT 1
	)
	UPDATE question_import_jobs AS job
	SET status = 'processing',
	    stage = CASE WHEN next_job.persistence_started THEN 'persisting' ELSE 'processing' END,
	    available_at = NULL,
	    claim_version = job.claim_version + 1,
	    retry_count = CASE
	        WHEN next_job.persistence_started OR next_job.attempts_exhausted THEN job.retry_count
	        ELSE job.retry_count + 1
	    END,
	    completed_at = NULL
	FROM next_job
	WHERE job.id = next_job.id
	RETURNING
		job.id,
		job.persist_questions,
		job.retry_count,
		job.claim_version,
		next_job.persistence_started,
		next_job.attempts_exhausted
`

const beginPersistenceSQL = `
	UPDATE question_import_jobs
	SET stage = 'persisting'
	WHERE id = $1
	  AND status = 'processing'
	  AND stage = 'processing'
	  AND claim_version = $2
`

const requeueJobSQL = `
	UPDATE question_import_jobs
	SET status = 'queued',
	    stage = 'queued',
	    available_at = NOW() + ($2 * INTERVAL '1 millisecond'),
	    completed_at = NULL
	WHERE id = $1
	  AND status = 'processing'
	  AND stage = 'processing'
	  AND claim_version = $3
`

const releaseJobSQL = `
	UPDATE question_import_jobs
	SET status = 'queued',
	    stage = 'queued',
	    available_at = NOW(),
	    retry_count = GREATEST(retry_count - 1, 0),
	    completed_at = NULL
	WHERE id = $1
	  AND status = 'processing'
	  AND stage = 'processing'
	  AND claim_version = $2
`

type ClaimedJob struct {
	ID                 int64
	PersistQuestions   bool
	Attempt            int
	ClaimVersion       int64
	PersistenceStarted bool
	AttemptsExhausted  bool
}

func ClaimNextJob(ctx context.Context, pool *pgxpool.Pool) (ClaimedJob, error) {
	var job ClaimedJob
	err := pool.QueryRow(ctx, claimNextJobSQL, ClaimTimeout.Milliseconds(), MaxAttempts).Scan(
		&job.ID,
		&job.PersistQuestions,
		&job.Attempt,
		&job.ClaimVersion,
		&job.PersistenceStarted,
		&job.AttemptsExhausted,
	)
	return job, err
}

func BeginPersistence(ctx context.Context, pool *pgxpool.Pool, jobID, claimVersion int64) error {
	return execClaimMutation(ctx, pool, beginPersistenceSQL, jobID, claimVersion)
}

func RequeueJob(ctx context.Context, pool *pgxpool.Pool, jobID, claimVersion int64, delay time.Duration) error {
	return execClaimMutation(ctx, pool, requeueJobSQL, jobID, delay.Milliseconds(), claimVersion)
}

func ReleaseJob(ctx context.Context, pool *pgxpool.Pool, jobID, claimVersion int64) error {
	return execClaimMutation(ctx, pool, releaseJobSQL, jobID, claimVersion)
}

func execClaimMutation(ctx context.Context, pool *pgxpool.Pool, query string, args ...any) error {
	tag, err := pool.Exec(ctx, query, args...)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrClaimLost
	}
	return nil
}

func RetryBackoff(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	return time.Second * time.Duration(1<<(attempt-1))
}

type ImportEvent struct {
	ID                     int64  `json:"id"`
	JobID                  int    `json:"job_id"`
	Stage                  string `json:"stage"`
	StepCode               string `json:"step_code,omitempty"`
	StepLabel              string `json:"step_label,omitempty"`
	Status                 string `json:"status"`
	Message                string `json:"message,omitempty"`
	OverallProgressPercent *int   `json:"overall_progress_percent,omitempty"`
	StepProgressPercent    *int   `json:"step_progress_percent,omitempty"`
}

func WriteEventStreamHeaders(headers http.Header) {
	headers.Set("Cache-Control", "no-cache, no-transform")
	headers.Set("Connection", "keep-alive")
	headers.Set("Content-Type", "text/event-stream; charset=utf-8")
}

func EncodeImportEvent(event ImportEvent) string {
	payload, _ := json.Marshal(event)
	return fmt.Sprintf("id: %d\nevent: import-event\ndata: %s\n\n", event.ID, payload)
}
