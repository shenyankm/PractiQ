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
)

const questionColumns = `
	id,
	business_type,
	subject_id,
	question_type_id,
	answer_mode,
	choice_variant,
	hierarchy_level,
	hierarchy_path,
	chapter_ref,
	chapter_title,
	chapter_order,
	content_mode,
	stem,
	analysis,
	detail_payload,
	status,
	source_type,
	source_ref,
	source_job_id,
	imported_by,
	created_at,
	updated_at
`

const persistImportedQuestionClaimSQL = `
	UPDATE question_import_jobs
	SET updated_at = NOW()
	WHERE id = $1
	  AND status = 'processing'
	  AND stage = 'persisting'
	  AND claim_version = $2
	RETURNING id
`

type Question struct {
	ID             int64     `json:"id"`
	BusinessType   string    `json:"business_type"`
	SubjectID      string    `json:"subject_id"`
	QuestionTypeID string    `json:"question_type_id"`
	AnswerMode     string    `json:"answer_mode"`
	ChoiceVariant  *string   `json:"choice_variant"`
	HierarchyLevel int       `json:"hierarchy_level"`
	HierarchyPath  *string   `json:"hierarchy_path"`
	ChapterRef     *string   `json:"chapter_ref"`
	ChapterTitle   *string   `json:"chapter_title"`
	ChapterOrder   *int      `json:"chapter_order"`
	ContentMode    *string   `json:"content_mode"`
	Stem           string    `json:"stem"`
	Analysis       *string   `json:"analysis"`
	DetailPayload  string    `json:"detail_payload"`
	Status         string    `json:"status"`
	SourceType     string    `json:"source_type"`
	SourceRef      *string   `json:"source_ref"`
	SourceJobID    *int64    `json:"source_job_id"`
	ImportedBy     *int64    `json:"imported_by"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

type QuestionOptionRecord struct {
	ID          int64     `json:"id"`
	QuestionID  int64     `json:"question_id"`
	OptionLabel string    `json:"option_label"`
	SortOrder   int       `json:"sort_order"`
	Content     string    `json:"content"`
	IsCorrect   bool      `json:"is_correct"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type QuestionAnswerKey struct {
	ID                 int64     `json:"id"`
	QuestionID         int64     `json:"question_id"`
	AnswerMode         string    `json:"answer_mode"`
	Version            int       `json:"version"`
	IsPrimary          bool      `json:"is_primary"`
	AnswerPayload      string    `json:"answer_payload"`
	ExplanationPayload string    `json:"explanation_payload"`
	ScorePayload       string    `json:"score_payload"`
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
}

type QuestionContentBlock struct {
	ID            int64     `json:"id"`
	QuestionID    *int64    `json:"question_id"`
	GroupID       *int64    `json:"group_id"`
	OptionID      *int64    `json:"option_id"`
	MediaID       *int64    `json:"media_id"`
	OwnerKind     string    `json:"owner_kind"`
	Role          *string   `json:"role"`
	PartType      string    `json:"part_type"`
	Sequence      int       `json:"sequence"`
	ContentMode   *string   `json:"content_mode"`
	TextFormat    *string   `json:"text_format"`
	TextValue     *string   `json:"text_value"`
	LatexValue    *string   `json:"latex_value"`
	MathMLValue   *string   `json:"mathml_value"`
	HTMLValue     *string   `json:"html_value"`
	MarkdownValue *string   `json:"markdown_value"`
	JSONValue     *string   `json:"json_value"`
	SourceURL     *string   `json:"source_url"`
	PageNo        *int      `json:"page_no"`
	BBoxJSON      *string   `json:"bbox_json"`
	MetadataJSON  string    `json:"metadata_json"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

type QuestionDetail struct {
	Question
	Options       []QuestionOptionRecord `json:"options"`
	AnswerKeys    []QuestionAnswerKey    `json:"answer_keys"`
	ContentBlocks []QuestionContentBlock `json:"content_blocks"`
	MediaLinks    []QuestionMediaLink    `json:"media_links"`
}

type CreateQuestionInput struct {
	QuestionTypeID string
	AnswerMode     string
	Stem           string
	Analysis       *string
	ChoiceVariant  *string
	Status         string
	Options        []QuestionOptionInput
	AnswerPayload  map[string]any
}

type UpdateQuestionInput struct {
	Stem     *string
	Analysis *string
	Status   *string
}

type UpsertAnswerKeyInput struct {
	AnswerMode         string
	AnswerPayload      map[string]any
	ExplanationPayload map[string]any
	ScorePayload       map[string]any
}

type QuestionOptionInput struct {
	Label     string
	Content   string
	IsCorrect bool
}

type CreateOptionInput struct {
	Label     string
	Content   string
	IsCorrect bool
	SortOrder *int
}

type UpdateOptionInput struct {
	Label     *string
	Content   *string
	IsCorrect *bool
	SortOrder *int
}

type QuestionContentBlockInput struct {
	OwnerKind     *string
	Role          *string
	PartType      string
	Sequence      *int
	ContentMode   *string
	TextFormat    *string
	TextValue     *string
	LatexValue    *string
	MathMLValue   *string
	HTMLValue     *string
	MarkdownValue *string
	JSONValue     any
	MediaID       *int64
}

type PersistImportedQuestionInput struct {
	JobID          int64
	ClaimVersion   int64
	Question       CreateQuestionInput
	ContentBlocks  []QuestionContentBlockInput
	Confidence     float64
	OutputMetadata map[string]any
}

func GetQuestion(ctx context.Context, db *pgxpool.Pool, user *auth.User, questionID int64) (*QuestionDetail, error) {
	var question Question
	var optionsRaw []byte
	var answerKeysRaw []byte
	var contentBlocksRaw []byte
	var mediaLinksRaw []byte

	err := db.QueryRow(ctx, `
		SELECT
			`+questionColumns+`,
			COALESCE(
				(
					SELECT json_agg(qo.* ORDER BY qo.sort_order)
					FROM question_options qo
					WHERE qo.question_id = q.id
				),
				'[]'::json
			) AS options,
			COALESCE(
				(
					SELECT json_agg(qak.* ORDER BY qak.version)
					FROM question_answer_keys qak
					WHERE qak.question_id = q.id
				),
				'[]'::json
			) AS answer_keys,
			COALESCE(
				(
					SELECT json_agg(qcb.* ORDER BY qcb.sequence)
					FROM question_content_blocks qcb
					WHERE qcb.question_id = q.id
				),
				'[]'::json
			) AS content_blocks,
			COALESCE(
				(
					SELECT json_agg(qml.* ORDER BY qml.sort_order)
					FROM question_media_links qml
					WHERE qml.question_id = q.id
				),
				'[]'::json
			) AS media_links
		FROM questions q
		WHERE q.id = $1
		  AND EXISTS (
			SELECT 1
			FROM bank_question_links bql
			JOIN question_banks b ON b.id = bql.bank_id
			LEFT JOIN user_bank_links ubl ON ubl.bank_id = b.id AND ubl.user_id = $2
			WHERE bql.question_id = q.id
			  AND (b.is_public = true OR ubl.id IS NOT NULL)
		  )
		LIMIT 1
	`, questionID, user.ID).Scan(
		&question.ID,
		&question.BusinessType,
		&question.SubjectID,
		&question.QuestionTypeID,
		&question.AnswerMode,
		&question.ChoiceVariant,
		&question.HierarchyLevel,
		&question.HierarchyPath,
		&question.ChapterRef,
		&question.ChapterTitle,
		&question.ChapterOrder,
		&question.ContentMode,
		&question.Stem,
		&question.Analysis,
		&question.DetailPayload,
		&question.Status,
		&question.SourceType,
		&question.SourceRef,
		&question.SourceJobID,
		&question.ImportedBy,
		&question.CreatedAt,
		&question.UpdatedAt,
		&optionsRaw,
		&answerKeysRaw,
		&contentBlocksRaw,
		&mediaLinksRaw,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, api.NewError(404, "NOT_FOUND", "Question not found", nil)
		}
		return nil, err
	}

	detail := &QuestionDetail{Question: question}
	if err := decodeJSON(optionsRaw, &detail.Options); err != nil {
		return nil, fmt.Errorf("decode question options: %w", err)
	}
	if err := decodeJSON(answerKeysRaw, &detail.AnswerKeys); err != nil {
		return nil, fmt.Errorf("decode answer keys: %w", err)
	}
	if err := decodeJSON(contentBlocksRaw, &detail.ContentBlocks); err != nil {
		return nil, fmt.Errorf("decode content blocks: %w", err)
	}
	if err := decodeJSON(mediaLinksRaw, &detail.MediaLinks); err != nil {
		return nil, fmt.Errorf("decode media links: %w", err)
	}
	return detail, nil
}

func CreateQuestion(ctx context.Context, db *pgxpool.Pool, user *auth.User, bankID int64, input CreateQuestionInput) (*Question, error) {
	bank, questionTypeID, status, err := prepareQuestionCreate(ctx, db, user, bankID, input)
	if err != nil {
		return nil, err
	}
	return withTx(ctx, db, func(tx pgx.Tx) (*Question, error) {
		return createQuestionTx(ctx, tx, user, bankID, bank.Subject, questionTypeID, status, input)
	})
}

func PersistImportedQuestion(ctx context.Context, db *pgxpool.Pool, user *auth.User, bankID int64, input PersistImportedQuestionInput) (*Question, error) {
	bank, questionTypeID, status, err := prepareQuestionCreate(ctx, db, user, bankID, input.Question)
	if err != nil {
		return nil, err
	}
	metadata, err := json.Marshal(input.OutputMetadata)
	if err != nil {
		return nil, err
	}
	return withTx(ctx, db, func(tx pgx.Tx) (*Question, error) {
		var jobID int64
		if err := tx.QueryRow(ctx, persistImportedQuestionClaimSQL, input.JobID, input.ClaimVersion).Scan(&jobID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, importqueue.ErrClaimLost
			}
			return nil, err
		}
		question, err := createQuestionTx(ctx, tx, user, bankID, bank.Subject, questionTypeID, status, input.Question)
		if err != nil {
			return nil, err
		}
		if err := replaceQuestionContentBlocksTx(ctx, tx, question.ID, input.ContentBlocks); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO question_import_job_outputs (job_id, output_kind, question_id, confidence, metadata_json)
			VALUES ($1, 'question', $2, $3, $4)
		`, jobID, question.ID, input.Confidence, string(metadata)); err != nil {
			return nil, err
		}
		return question, nil
	})
}

func prepareQuestionCreate(ctx context.Context, db *pgxpool.Pool, user *auth.User, bankID int64, input CreateQuestionInput) (*BankOwner, string, string, error) {
	if err := validateCreateQuestionInput(input); err != nil {
		return nil, "", "", err
	}
	bank, err := RequireBankOwner(ctx, db, user, bankID)
	if err != nil {
		return nil, "", "", err
	}
	if err := validateQuestionPayload(input.AnswerMode, input.Status, input.Options, input.AnswerPayload); err != nil {
		return nil, "", "", err
	}
	questionTypeID := strings.TrimSpace(input.QuestionTypeID)
	mode := strings.TrimSpace(input.AnswerMode)
	resolved, err := ResolveQuestionTypeIDForSubject(ctx, db, bank.Subject, questionTypeID, &mode, "question")
	if err != nil {
		return nil, "", "", err
	}
	questionTypeID = resolved
	status, err := normalizeQuestionStatusOrDefault(input.Status, "draft")
	if err != nil {
		return nil, "", "", err
	}
	return bank, questionTypeID, status, nil
}

func createQuestionTx(ctx context.Context, tx pgx.Tx, user *auth.User, bankID int64, subject, questionTypeID, status string, input CreateQuestionInput) (*Question, error) {
	if _, err := tx.Exec(ctx, `SELECT id FROM question_banks WHERE id = $1 FOR UPDATE`, bankID); err != nil {
		return nil, err
	}
	var nextSort int
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort
		FROM bank_question_links
		WHERE bank_id = $1
	`, bankID).Scan(&nextSort); err != nil {
		return nil, err
	}

	row := tx.QueryRow(ctx, `
			INSERT INTO questions (
				subject_id,
				question_type_id,
				answer_mode,
				choice_variant,
				stem,
				analysis,
				status,
				source_type,
				imported_by
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual', $8)
			RETURNING `+questionColumns+`
		`, subject, questionTypeID, strings.TrimSpace(input.AnswerMode), input.ChoiceVariant, strings.TrimSpace(input.Stem), input.Analysis, status, user.ID)
	created, err := scanQuestion(row)
	if err != nil {
		return nil, err
	}

	if _, err := tx.Exec(ctx, `
			INSERT INTO question_answer_keys (question_id, answer_mode, answer_payload)
			VALUES ($1, $2, $3)
	`, created.ID, created.AnswerMode, marshalJSONObject(input.AnswerPayload)); err != nil {
		return nil, err
	}

	if created.AnswerMode == "choice" {
		for index, option := range input.Options {
			if _, err := tx.Exec(ctx, `
					INSERT INTO question_options (question_id, option_label, sort_order, content, is_correct)
					VALUES ($1, $2, $3, $4, $5)
			`, created.ID, strings.TrimSpace(option.Label), index+1, option.Content, option.IsCorrect); err != nil {
				return nil, err
			}
		}
	}

	if _, err := tx.Exec(ctx, `
			INSERT INTO bank_question_links (bank_id, question_id, sort_order, status, added_by)
			VALUES ($1, $2, $3, $4, $5)
	`, bankID, created.ID, nextSort, status, user.ID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
			UPDATE question_banks
			SET total_count = total_count + 1
			WHERE id = $1
	`, bankID); err != nil {
		return nil, err
	}
	return &created, nil
}

func validateCreateQuestionInput(input CreateQuestionInput) error {
	details := make([]api.ValidationDetail, 0, 3)
	if strings.TrimSpace(input.QuestionTypeID) == "" {
		details = append(details, api.ValidationDetail{Field: "questionTypeId", Message: "is required"})
	}
	switch strings.TrimSpace(input.AnswerMode) {
	case "choice", "true_false", "fill_blank", "short_answer":
	default:
		details = append(details, api.ValidationDetail{Field: "answerMode", Message: "must be one of choice, true_false, fill_blank, short_answer"})
	}
	if strings.TrimSpace(input.Stem) == "" {
		details = append(details, api.ValidationDetail{Field: "stem", Message: "is required"})
	}
	if len(details) > 0 {
		return api.ValidationError(details)
	}
	return nil
}

func UpdateQuestion(ctx context.Context, db *pgxpool.Pool, user *auth.User, questionID int64, input UpdateQuestionInput) (*Question, error) {
	if err := EnsureQuestionEditable(ctx, db, user, questionID); err != nil {
		return nil, err
	}
	status, err := normalizeQuestionStatusPointer(input.Status)
	if err != nil {
		return nil, err
	}
	if status != nil && *status == "active" {
		if err := assertQuestionPublishable(ctx, db, user, questionID); err != nil {
			return nil, err
		}
	}

	question, err := withTx(ctx, db, func(tx pgx.Tx) (*Question, error) {
		row := tx.QueryRow(ctx, `
			UPDATE questions
			SET
				stem = COALESCE($2, stem),
				analysis = COALESCE($3, analysis),
				status = COALESCE($4, status)
			WHERE id = $1
			RETURNING `+questionColumns+`
		`, questionID, input.Stem, input.Analysis, status)
		updated, err := scanQuestion(row)
		if err != nil {
			return nil, err
		}
		if status != nil {
			if _, err := tx.Exec(ctx, `
				UPDATE bank_question_links
				SET status = $2
				WHERE question_id = $1
			`, questionID, *status); err != nil {
				return nil, err
			}
		}
		return &updated, nil
	})
	if err != nil {
		return nil, err
	}
	return question, nil
}

func DeleteQuestion(ctx context.Context, db *pgxpool.Pool, user *auth.User, questionID int64) error {
	if err := EnsureQuestionEditable(ctx, db, user, questionID); err != nil {
		return err
	}
	_, err := withTx(ctx, db, func(tx pgx.Tx) (struct{}, error) {
		rows, err := tx.Query(ctx, `
			SELECT bank_id
			FROM bank_question_links
			WHERE question_id = $1
		`, questionID)
		if err != nil {
			return struct{}{}, err
		}
		defer rows.Close()
		var bankIDs []int64
		for rows.Next() {
			var bankID int64
			if err := rows.Scan(&bankID); err != nil {
				return struct{}{}, err
			}
			bankIDs = append(bankIDs, bankID)
		}
		if err := rows.Err(); err != nil {
			return struct{}{}, err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM questions WHERE id = $1`, questionID); err != nil {
			return struct{}{}, err
		}
		for _, bankID := range bankIDs {
			if _, err := tx.Exec(ctx, `
				UPDATE question_banks
				SET total_count = GREATEST(total_count - 1, 0)
				WHERE id = $1
			`, bankID); err != nil {
				return struct{}{}, err
			}
		}
		return struct{}{}, nil
	})
	return err
}

func SetQuestionStatus(ctx context.Context, db *pgxpool.Pool, user *auth.User, questionID int64, status string) (*Question, error) {
	normalized, err := normalizeQuestionStatusOrDefault(status, "")
	if err != nil {
		return nil, err
	}
	if normalized == "active" {
		if err := assertQuestionPublishable(ctx, db, user, questionID); err != nil {
			return nil, err
		}
	}
	if err := EnsureQuestionEditable(ctx, db, user, questionID); err != nil {
		return nil, err
	}
	question, err := withTx(ctx, db, func(tx pgx.Tx) (*Question, error) {
		row := tx.QueryRow(ctx, `
			UPDATE questions
			SET status = $2
			WHERE id = $1
			RETURNING `+questionColumns+`
		`, questionID, normalized)
		updated, err := scanQuestion(row)
		if err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE bank_question_links
			SET status = $2
			WHERE question_id = $1
		`, questionID, normalized); err != nil {
			return nil, err
		}
		return &updated, nil
	})
	if err != nil {
		return nil, err
	}
	return question, nil
}

func UpsertAnswerKey(ctx context.Context, db *pgxpool.Pool, user *auth.User, questionID int64, input UpsertAnswerKeyInput) (*QuestionAnswerKey, error) {
	if err := EnsureQuestionEditable(ctx, db, user, questionID); err != nil {
		return nil, err
	}
	row := db.QueryRow(ctx, `
		INSERT INTO question_answer_keys (
			question_id,
			answer_mode,
			version,
			is_primary,
			answer_payload,
			explanation_payload,
			score_payload
		)
		VALUES ($1, $2, 1, true, $3, $4, $5)
		ON CONFLICT (question_id) WHERE is_primary
		DO UPDATE SET
			answer_mode = EXCLUDED.answer_mode,
			answer_payload = EXCLUDED.answer_payload,
			explanation_payload = EXCLUDED.explanation_payload,
			score_payload = EXCLUDED.score_payload
		RETURNING id, question_id, answer_mode, version, is_primary, answer_payload, explanation_payload, score_payload, created_at, updated_at
	`, questionID, strings.TrimSpace(input.AnswerMode), marshalJSONObject(input.AnswerPayload), marshalJSONObject(input.ExplanationPayload), marshalJSONObject(input.ScorePayload))
	answerKey, err := scanQuestionAnswerKey(row)
	if err != nil {
		return nil, err
	}
	return &answerKey, nil
}

func CreateOption(ctx context.Context, db *pgxpool.Pool, user *auth.User, questionID int64, input CreateOptionInput) (*QuestionOptionRecord, error) {
	if err := EnsureQuestionEditable(ctx, db, user, questionID); err != nil {
		return nil, err
	}
	sortOrder := 0
	if input.SortOrder != nil {
		sortOrder = *input.SortOrder
	} else if err := db.QueryRow(ctx, `
		SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort
		FROM question_options
		WHERE question_id = $1
	`, questionID).Scan(&sortOrder); err != nil {
		return nil, err
	}
	row := db.QueryRow(ctx, `
		INSERT INTO question_options (question_id, option_label, sort_order, content, is_correct)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, question_id, option_label, sort_order, content, is_correct, created_at, updated_at
	`, questionID, strings.TrimSpace(input.Label), sortOrder, input.Content, input.IsCorrect)
	option, err := scanQuestionOption(row)
	if err != nil {
		return nil, err
	}
	return &option, nil
}

func UpdateOption(ctx context.Context, db *pgxpool.Pool, user *auth.User, questionID int64, optionID int64, input UpdateOptionInput) (*QuestionOptionRecord, error) {
	if err := EnsureQuestionEditable(ctx, db, user, questionID); err != nil {
		return nil, err
	}
	row := db.QueryRow(ctx, `
		UPDATE question_options
		SET
			option_label = COALESCE($3, option_label),
			content = COALESCE($4, content),
			is_correct = COALESCE($5, is_correct),
			sort_order = COALESCE($6, sort_order)
		WHERE id = $1
		  AND question_id = $2
		RETURNING id, question_id, option_label, sort_order, content, is_correct, created_at, updated_at
	`, optionID, questionID, input.Label, input.Content, input.IsCorrect, input.SortOrder)
	option, err := scanQuestionOption(row)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, api.NewError(404, "NOT_FOUND", "Option not found", nil)
		}
		return nil, err
	}
	return &option, nil
}

func ReplaceQuestionContentBlocks(ctx context.Context, db *pgxpool.Pool, user *auth.User, questionID int64, blocks []QuestionContentBlockInput) error {
	if err := EnsureQuestionEditable(ctx, db, user, questionID); err != nil {
		return err
	}
	_, err := withTx(ctx, db, func(tx pgx.Tx) (struct{}, error) {
		return struct{}{}, replaceQuestionContentBlocksTx(ctx, tx, questionID, blocks)
	})
	return err
}

func replaceQuestionContentBlocksTx(ctx context.Context, tx pgx.Tx, questionID int64, blocks []QuestionContentBlockInput) error {
	if _, err := tx.Exec(ctx, `DELETE FROM question_content_blocks WHERE question_id = $1`, questionID); err != nil {
		return err
	}
	for index, block := range blocks {
		ownerKind := "question"
		if block.OwnerKind != nil && strings.TrimSpace(*block.OwnerKind) != "" {
			ownerKind = strings.TrimSpace(*block.OwnerKind)
		}
		sequence := index + 1
		if block.Sequence != nil && *block.Sequence > 0 {
			sequence = *block.Sequence
		}
		jsonValue, err := normalizeJSONValue(block.JSONValue)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
				INSERT INTO question_content_blocks (
					question_id,
					owner_kind,
					role,
					part_type,
					sequence,
					content_mode,
					text_format,
					text_value,
					latex_value,
					mathml_value,
					html_value,
					markdown_value,
					json_value,
					media_id
				)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
		`, questionID, ownerKind, block.Role, strings.TrimSpace(block.PartType), sequence, block.ContentMode, block.TextFormat, block.TextValue, block.LatexValue, block.MathMLValue, block.HTMLValue, block.MarkdownValue, jsonValue, block.MediaID); err != nil {
			return err
		}
	}
	return nil
}

func EnsureQuestionEditable(ctx context.Context, db *pgxpool.Pool, user *auth.User, questionID int64) error {
	var id int64
	err := db.QueryRow(ctx, `
		SELECT q.id
		FROM questions q
		JOIN bank_question_links bql ON bql.question_id = q.id
		JOIN user_bank_links ubl ON ubl.bank_id = bql.bank_id
		WHERE q.id = $1
		  AND ubl.user_id = $2
		  AND ubl.is_owner = true
		LIMIT 1
	`, questionID, user.ID).Scan(&id)
	if err == nil {
		return nil
	}
	if err == pgx.ErrNoRows {
		return api.NewError(403, "FORBIDDEN", "Question editor access required", nil)
	}
	return err
}

func assertQuestionPublishable(ctx context.Context, db *pgxpool.Pool, user *auth.User, questionID int64) error {
	if err := EnsureQuestionEditable(ctx, db, user, questionID); err != nil {
		return err
	}
	var answerMode string
	var optionCount int
	var correctOptionCount int
	var answerKeyCount int
	var answerPayload *string
	if err := db.QueryRow(ctx, `
		SELECT
			q.answer_mode,
			(SELECT COUNT(*)::int FROM question_options qo WHERE qo.question_id = q.id) AS option_count,
			(SELECT COUNT(*)::int FROM question_options qo WHERE qo.question_id = q.id AND qo.is_correct = true) AS correct_option_count,
			(SELECT COUNT(*)::int FROM question_answer_keys qak WHERE qak.question_id = q.id AND qak.is_primary = true) AS answer_key_count,
			(SELECT qak.answer_payload FROM question_answer_keys qak WHERE qak.question_id = q.id AND qak.is_primary = true LIMIT 1) AS answer_payload
		FROM questions q
		WHERE q.id = $1
		LIMIT 1
	`, questionID).Scan(&answerMode, &optionCount, &correctOptionCount, &answerKeyCount, &answerPayload); err != nil {
		if err == pgx.ErrNoRows {
			return api.NewError(404, "NOT_FOUND", "Question not found", nil)
		}
		return err
	}
	if answerKeyCount < 1 {
		return api.NewError(409, "INVALID_STATE", "Question requires a primary answer key before publishing", nil)
	}
	if answerMode == "choice" && (optionCount < 2 || correctOptionCount < 1) {
		return api.NewError(409, "INVALID_STATE", "Choice question requires at least two options and one correct option", nil)
	}
	payload := map[string]any{}
	if answerPayload != nil && strings.TrimSpace(*answerPayload) != "" {
		_ = json.Unmarshal([]byte(*answerPayload), &payload)
	}
	if !hasUsableAnswerPayload(answerMode, payload) {
		return api.NewError(409, "INVALID_STATE", "Question requires a usable primary answer payload before publishing", nil)
	}
	return nil
}

func validateQuestionPayload(answerMode string, status string, options []QuestionOptionInput, answerPayload map[string]any) error {
	mode := strings.TrimSpace(answerMode)
	if mode != "choice" && len(options) > 0 {
		return api.NewError(422, "VALIDATION_ERROR", "Options are only supported for choice questions", nil)
	}
	if mode == "choice" {
		labels := map[string]struct{}{}
		for _, option := range options {
			label := strings.TrimSpace(option.Label)
			if label == "" {
				return api.NewError(422, "VALIDATION_ERROR", "Choice option labels must be unique and non-empty", nil)
			}
			if _, exists := labels[label]; exists {
				return api.NewError(422, "VALIDATION_ERROR", "Choice option labels must be unique and non-empty", nil)
			}
			labels[label] = struct{}{}
		}
		for _, label := range selectedAnswerValues(answerPayload) {
			if _, exists := labels[label]; !exists {
				return api.NewError(422, "VALIDATION_ERROR", "Choice answer must reference existing option labels", nil)
			}
		}
	}
	if strings.TrimSpace(status) == "active" {
		if !hasUsableAnswerPayload(mode, answerPayload) {
			return api.NewError(409, "INVALID_STATE", "Active questions require a usable answer payload", nil)
		}
		if mode == "choice" {
			correct := false
			for _, option := range options {
				if option.IsCorrect {
					correct = true
					break
				}
			}
			if len(options) < 2 || !correct {
				return api.NewError(409, "INVALID_STATE", "Active choice questions require at least two options and one correct option", nil)
			}
		}
	}
	return nil
}

func hasUsableAnswerPayload(mode string, payload map[string]any) bool {
	if payload == nil {
		return false
	}
	switch mode {
	case "choice":
		return len(selectedAnswerValues(payload)) > 0
	case "true_false":
		_, ok := payload["value"].(bool)
		return ok
	case "fill_blank":
		for _, value := range questionFillBlankValues(payload) {
			if value != "" {
				return true
			}
		}
		return false
	default:
		return normalizeQuestionText(payload["value"]) != ""
	}
}

func selectedAnswerValues(payload map[string]any) []string {
	return normalizeQuestionStringArray(questionObjectValue(payload, "selected"))
}

func questionFillBlankValues(payload map[string]any) []string {
	direct := questionObjectValue(payload, "value")
	if list, ok := direct.([]any); ok {
		out := make([]string, 0, len(list))
		for _, item := range list {
			out = append(out, normalizeQuestionText(item))
		}
		return out
	}
	if direct != nil {
		return []string{normalizeQuestionText(direct)}
	}
	slots, ok := questionObjectValue(payload, "slots").([]any)
	if !ok {
		return nil
	}
	values := []string{}
	for _, slot := range slots {
		record, ok := slot.(map[string]any)
		if !ok {
			continue
		}
		nested := record["value"]
		if nested == nil {
			nested = record["answers"]
		}
		switch list := nested.(type) {
		case []any:
			for _, item := range list {
				values = append(values, normalizeQuestionText(item))
			}
		default:
			values = append(values, normalizeQuestionText(list))
		}
	}
	return values
}

func questionObjectValue(payload map[string]any, key string) any {
	if payload == nil {
		return nil
	}
	return payload[key]
}

func normalizeQuestionStringArray(value any) []string {
	var items []any
	switch typed := value.(type) {
	case nil:
		return nil
	case []any:
		items = typed
	default:
		items = []any{typed}
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		text := strings.TrimSpace(fmt.Sprint(item))
		if text != "" {
			out = append(out, text)
		}
	}
	return out
}

func normalizeQuestionText(value any) string {
	text := strings.ToLower(strings.TrimSpace(fmt.Sprint(value)))
	return strings.Join(strings.Fields(text), " ")
}

func normalizeQuestionStatusPointer(status *string) (*string, error) {
	if status == nil {
		return nil, nil
	}
	normalized, err := normalizeQuestionStatusOrDefault(*status, "")
	if err != nil {
		return nil, err
	}
	return &normalized, nil
}

func normalizeQuestionStatusOrDefault(status string, fallback string) (string, error) {
	status = strings.TrimSpace(status)
	if status == "" {
		return fallback, nil
	}
	switch status {
	case "draft", "active", "archived":
		return status, nil
	default:
		return "", api.NewError(422, "VALIDATION_ERROR", "Invalid question status", nil)
	}
}

func scanQuestion(row pgx.Row) (Question, error) {
	var question Question
	err := row.Scan(
		&question.ID,
		&question.BusinessType,
		&question.SubjectID,
		&question.QuestionTypeID,
		&question.AnswerMode,
		&question.ChoiceVariant,
		&question.HierarchyLevel,
		&question.HierarchyPath,
		&question.ChapterRef,
		&question.ChapterTitle,
		&question.ChapterOrder,
		&question.ContentMode,
		&question.Stem,
		&question.Analysis,
		&question.DetailPayload,
		&question.Status,
		&question.SourceType,
		&question.SourceRef,
		&question.SourceJobID,
		&question.ImportedBy,
		&question.CreatedAt,
		&question.UpdatedAt,
	)
	return question, err
}

func scanQuestionOption(row pgx.Row) (QuestionOptionRecord, error) {
	var option QuestionOptionRecord
	err := row.Scan(&option.ID, &option.QuestionID, &option.OptionLabel, &option.SortOrder, &option.Content, &option.IsCorrect, &option.CreatedAt, &option.UpdatedAt)
	return option, err
}

func scanQuestionAnswerKey(row pgx.Row) (QuestionAnswerKey, error) {
	var answerKey QuestionAnswerKey
	err := row.Scan(&answerKey.ID, &answerKey.QuestionID, &answerKey.AnswerMode, &answerKey.Version, &answerKey.IsPrimary, &answerKey.AnswerPayload, &answerKey.ExplanationPayload, &answerKey.ScorePayload, &answerKey.CreatedAt, &answerKey.UpdatedAt)
	return answerKey, err
}

func decodeJSON[T any](raw []byte, target *T) error {
	if len(raw) == 0 {
		return nil
	}
	return json.Unmarshal(raw, target)
}

func marshalJSONObject(value map[string]any) string {
	if len(value) == 0 {
		return "{}"
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return "{}"
	}
	return string(encoded)
}

func normalizeJSONValue(value any) (*string, error) {
	switch typed := value.(type) {
	case nil:
		return nil, nil
	case string:
		return &typed, nil
	default:
		encoded, err := json.Marshal(typed)
		if err != nil {
			return nil, err
		}
		text := string(encoded)
		return &text, nil
	}
}
