package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"openwook/internal/aiclient"
	"openwook/internal/auth"
	importqueue "openwook/internal/imports"
	"openwook/internal/redisx"
	"openwook/internal/services"
)

type importJobRecord struct {
	ID         int64
	CreatedBy  int64
	BankID     *int64
	FileName   *string
	SourceType *string
}

type importArtifactRecord struct {
	StoragePath *string
	ContentJSON *string
}

func processQueuedJob(ctx context.Context, pool *pgxpool.Pool, client *aiclient.Client, payload importqueue.QueuePayload) error {
	job, err := loadImportJob(ctx, pool, int64(payload.JobID))
	if err != nil {
		return err
	}
	user, err := auth.CurrentUserByID(ctx, pool, int(job.CreatedBy))
	if err != nil {
		return err
	}
	if user == nil {
		return fmt.Errorf("import worker user %d not found", job.CreatedBy)
	}
	if err := recordImportEvent(ctx, pool, job.ID, "processing", "parse", "处理中", "processing", nil, 10, 10); err != nil {
		return err
	}
	request, err := buildParseRequest(ctx, pool, job)
	if err != nil {
		return err
	}
	result, err := client.ParseDocument(ctx, request)
	if err != nil {
		return err
	}
	createdCount := 0
	if payload.PersistQuestions && job.BankID != nil {
		for _, parsed := range result.Questions {
			input := services.CreateQuestionInput{
				QuestionTypeID: parsed.QuestionTypeID,
				AnswerMode:     parsed.AnswerMode,
				Stem:           parsed.Stem,
				Analysis:       stringPointer(parsed.Analysis),
				Status:         "draft",
				Options:        mapOptions(parsed.Options),
				AnswerPayload:  parsed.AnswerPayload,
			}
			if input.AnswerMode == "choice" {
				variant := "single"
				if countCorrect(parsed.Options) > 1 {
					variant = "multiple"
				}
				input.ChoiceVariant = &variant
			}
			question, err := services.CreateQuestion(ctx, pool, user, *job.BankID, input, nil)
			if err != nil {
				return err
			}
			if len(parsed.ContentBlocks) > 0 {
				if err := services.ReplaceQuestionContentBlocks(ctx, pool, user, question.ID, mapContentBlocks(parsed.ContentBlocks)); err != nil {
					return err
				}
			}
			if err := insertOutputRow(ctx, pool, job.ID, question.ID, parsed.Confidence, parsed); err != nil {
				return err
			}
			createdCount++
		}
	}
	if err := completeImportJob(ctx, pool, job.ID, createdCount, result); err != nil {
		return err
	}
	return recordImportEvent(ctx, pool, job.ID, "completed", "complete", "导入完成", "completed", nil, 100, 100)
}

func loadImportJob(ctx context.Context, pool *pgxpool.Pool, jobID int64) (*importJobRecord, error) {
	row := pool.QueryRow(ctx, `
		SELECT id, created_by, bank_id, file_name, source_type
		FROM question_import_jobs
		WHERE id = $1
		LIMIT 1
	`, jobID)
	var job importJobRecord
	if err := row.Scan(&job.ID, &job.CreatedBy, &job.BankID, &job.FileName, &job.SourceType); err != nil {
		return nil, err
	}
	return &job, nil
}

func buildParseRequest(ctx context.Context, pool *pgxpool.Pool, job *importJobRecord) (aiclient.DocumentParseRequest, error) {
	rows, err := pool.Query(ctx, `
		SELECT storage_path, content_json
		FROM question_import_job_artifacts
		WHERE job_id = $1
		ORDER BY id
	`, job.ID)
	if err != nil {
		return aiclient.DocumentParseRequest{}, err
	}
	defer rows.Close()
	request := aiclient.DocumentParseRequest{ImportJobID: new(int(job.ID)), BankID: nullableIntPtr(job.BankID), SourceType: valueOrDefault(job.SourceType, "txt"), FileName: valueOrDefault(job.FileName, "")}
	var texts []string
	for rows.Next() {
		var artifact importArtifactRecord
		if err := rows.Scan(&artifact.StoragePath, &artifact.ContentJSON); err != nil {
			return aiclient.DocumentParseRequest{}, err
		}
		if artifact.ContentJSON == nil {
			continue
		}
		content := map[string]any{}
		if err := json.Unmarshal([]byte(*artifact.ContentJSON), &content); err != nil {
			continue
		}
		if text, ok := content["text"].(string); ok && strings.TrimSpace(text) != "" {
			texts = append(texts, strings.TrimSpace(text))
		}
		if request.FileBase64 == "" {
			if raw, ok := content["fileBase64"].(string); ok && raw != "" {
				request.FileBase64 = raw
			}
		}
		if request.MimeType == "" {
			if mime, ok := content["mimeType"].(string); ok {
				request.MimeType = mime
			}
		}
		if request.FileName == "" {
			if name, ok := content["originalName"].(string); ok {
				request.FileName = name
			}
		}
	}
	request.Text = strings.Join(texts, "\n\n")
	if request.SourceType == "text" {
		request.SourceType = "txt"
	}
	return request, rows.Err()
}

func completeImportJob(ctx context.Context, pool *pgxpool.Pool, jobID int64, importedQuestions int, result *aiclient.DocumentParseResult) error {
	rawResult, err := json.Marshal(result)
	if err != nil {
		return err
	}
	warnings, err := json.Marshal(result.Warnings)
	if err != nil {
		return err
	}
	_, err = pool.Exec(ctx, `
		UPDATE question_import_jobs
		SET status = 'completed',
		    stage = 'completed',
		    total_questions = $2,
		    imported_questions = $3,
		    raw_result_json = $4,
		    warning_messages = $5,
		    quality_score = $6,
		    overall_progress_percent = 100,
		    step_progress_percent = 100,
		    completed_at = NOW(),
		    last_error = NULL,
		    last_error_code = NULL
		WHERE id = $1
	`, jobID, len(result.Questions), importedQuestions, string(rawResult), string(warnings), result.QualityScore)
	return err
}

func insertOutputRow(ctx context.Context, pool *pgxpool.Pool, jobID int64, questionID int64, confidence float64, parsed aiclient.ParsedQuestion) error {
	metadata, err := json.Marshal(map[string]any{"sourceText": parsed.SourceText, "needsReview": parsed.NeedsReview})
	if err != nil {
		return err
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO question_import_job_outputs (job_id, output_kind, question_id, confidence, metadata_json)
		VALUES ($1, 'question', $2, $3, $4)
	`, jobID, questionID, confidence, string(metadata))
	return err
}

func recordImportEvent(ctx context.Context, pool *pgxpool.Pool, jobID int64, stage, stepCode, stepLabel, status string, message *string, overall, step int) error {
	var eventID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO question_import_job_events (job_id, stage, step_code, step_label, status, message, overall_progress_percent, step_progress_percent, payload_json)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}')
		RETURNING id
	`, jobID, stage, stepCode, stepLabel, status, nullableString(message), overall, step).Scan(&eventID); err != nil {
		return err
	}
	_, _ = pool.Exec(ctx, `UPDATE question_import_jobs SET last_event_id = $2, last_event_at = NOW() WHERE id = $1`, jobID, eventID)
	payload := map[string]any{"id": eventID, "job_id": jobID, "stage": stage, "step_code": stepCode, "step_label": stepLabel, "status": status, "message": derefString(message), "overall_progress_percent": overall, "step_progress_percent": step}
	if rdb := redisx.Client(); rdb != nil {
		_ = redisx.AppendStreamJSON(ctx, rdb, redisx.ImportEventStreamKey(jobID), payload)
		_ = redisx.PublishJSON(ctx, rdb, redisx.ImportEventChannel(jobID), payload)
	}
	return nil
}

func mapOptions(options []aiclient.ParsedOption) []services.QuestionOptionInput {
	mapped := make([]services.QuestionOptionInput, 0, len(options))
	for _, option := range options {
		mapped = append(mapped, services.QuestionOptionInput{Label: option.Label, Content: option.Content, IsCorrect: option.IsCorrect})
	}
	return mapped
}

func mapContentBlocks(blocks []aiclient.ContentBlock) []services.QuestionContentBlockInput {
	mapped := make([]services.QuestionContentBlockInput, 0, len(blocks))
	for index, block := range blocks {
		sequence := index + 1
		mapped = append(mapped, services.QuestionContentBlockInput{Role: stringPointer(block.Role), PartType: block.PartType, Sequence: &sequence, TextValue: stringPointer(block.TextValue), MarkdownValue: stringPointer(block.MarkdownValue), LatexValue: stringPointer(block.LatexValue), JSONValue: block.JSONValue})
	}
	return mapped
}

func countCorrect(options []aiclient.ParsedOption) int {
	count := 0
	for _, option := range options {
		if option.IsCorrect {
			count++
		}
	}
	return count
}

func stringPointer(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return &value
}

func nullableIntPtr(value *int64) *int {
	if value == nil {
		return nil
	}
	return new(int(*value))
}

func valueOrDefault(value *string, fallback string) string {
	if value == nil || strings.TrimSpace(*value) == "" {
		return fallback
	}
	return *value
}

func nullableString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
