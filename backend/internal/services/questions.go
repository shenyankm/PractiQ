package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"practiq/internal/api"
	"practiq/internal/auth"
	importqueue "practiq/internal/imports"
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
	IsCorrect   *bool     `json:"is_correct,omitempty"`
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
	CanEdit       bool                   `json:"can_edit"`
}

type LearnerQuestionOption struct {
	ID          int64  `json:"id"`
	QuestionID  int64  `json:"question_id"`
	OptionLabel string `json:"option_label"`
	SortOrder   int    `json:"sort_order"`
	Content     string `json:"content"`
}

type LearnerQuestionDetail struct {
	ID             int64                   `json:"id"`
	BusinessType   string                  `json:"business_type"`
	SubjectID      string                  `json:"subject_id"`
	QuestionTypeID string                  `json:"question_type_id"`
	AnswerMode     string                  `json:"answer_mode"`
	ChoiceVariant  *string                 `json:"choice_variant"`
	ContentMode    *string                 `json:"content_mode"`
	Stem           string                  `json:"stem"`
	Status         string                  `json:"status"`
	Options        []LearnerQuestionOption `json:"options"`
	ContentBlocks  []QuestionContentBlock  `json:"content_blocks"`
	MediaLinks     []QuestionMediaLink     `json:"media_links"`
	CanEdit        bool                    `json:"can_edit"`
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
	Stem        *string
	Analysis    *string
	AnalysisSet bool
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

func GetQuestion(ctx context.Context, db *pgxpool.Pool, user *auth.User, questionID int64) (any, error) {
	detail, err := loadQuestionDetail(ctx, db, user, questionID)
	if err != nil {
		return nil, err
	}
	if detail.CanEdit {
		return detail, nil
	}
	return learnerQuestionDetail(detail), nil
}

func GetQuestionForEditor(ctx context.Context, db *pgxpool.Pool, user *auth.User, questionID int64) (*QuestionDetail, error) {
	if err := EnsureQuestionEditable(ctx, db, user, questionID); err != nil {
		return nil, err
	}
	detail, err := loadQuestionDetail(ctx, db, user, questionID)
	if err != nil {
		return nil, err
	}
	detail.CanEdit = true
	return detail, nil
}

func loadQuestionDetail(ctx context.Context, db *pgxpool.Pool, user *auth.User, questionID int64) (*QuestionDetail, error) {
	var question Question
	var optionsRaw []byte
	var answerKeysRaw []byte
	var contentBlocksRaw []byte
	var mediaLinksRaw []byte
	var canEdit bool

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
			) AS media_links,
			EXISTS (
				SELECT 1
				FROM v_bank_question_items owner_item
				JOIN user_bank_links owner_link ON owner_link.bank_id = owner_item.bank_id
				WHERE owner_item.question_id = q.id
				  AND owner_link.user_id = $2
				  AND owner_link.is_owner = true
			) AS can_edit
		FROM questions q
		WHERE q.id = $1
		  AND EXISTS (
			SELECT 1
			FROM v_bank_question_items item
			JOIN question_banks b ON b.id = item.bank_id
			LEFT JOIN user_bank_links ubl ON ubl.bank_id = b.id AND ubl.user_id = $2
			WHERE item.question_id = q.id
			  AND (
				ubl.is_owner = true
				OR (
					(b.is_public = true OR ubl.id IS NOT NULL)
					AND q.status = 'active'
					AND item.question_status = 'active'
					AND item.bank_link_status = 'active'
				)
			  )
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
		&canEdit,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, api.NewError(404, "NOT_FOUND", "Question not found", nil)
		}
		return nil, err
	}

	detail := &QuestionDetail{Question: question, CanEdit: canEdit}
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

func learnerQuestionDetail(detail *QuestionDetail) LearnerQuestionDetail {
	options := make([]LearnerQuestionOption, 0, len(detail.Options))
	for _, option := range detail.Options {
		options = append(options, LearnerQuestionOption{
			ID:          option.ID,
			QuestionID:  option.QuestionID,
			OptionLabel: option.OptionLabel,
			SortOrder:   option.SortOrder,
			Content:     option.Content,
		})
	}
	blocks := make([]QuestionContentBlock, 0, len(detail.ContentBlocks))
	for _, block := range detail.ContentBlocks {
		if block.OwnerKind == "question" || block.OwnerKind == "stem" {
			blocks = append(blocks, block)
		}
	}
	return LearnerQuestionDetail{
		ID:             detail.ID,
		BusinessType:   detail.BusinessType,
		SubjectID:      detail.SubjectID,
		QuestionTypeID: detail.QuestionTypeID,
		AnswerMode:     detail.AnswerMode,
		ChoiceVariant:  detail.ChoiceVariant,
		ContentMode:    detail.ContentMode,
		Stem:           detail.Stem,
		Status:         detail.Status,
		Options:        options,
		ContentBlocks:  blocks,
		MediaLinks:     detail.MediaLinks,
		CanEdit:        false,
	}
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
		if _, err := tx.Exec(ctx, `
			UPDATE questions
			SET source_type = 'imported', source_job_id = $2
			WHERE id = $1
		`, question.ID, input.JobID); err != nil {
			return nil, err
		}
		question.SourceType = "imported"
		question.SourceJobID = &input.JobID
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

	var choiceVariant *string
	if input.ChoiceVariant != nil {
		trimmed := strings.TrimSpace(*input.ChoiceVariant)
		choiceVariant = &trimmed
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
		`, subject, questionTypeID, strings.TrimSpace(input.AnswerMode), choiceVariant, strings.TrimSpace(input.Stem), input.Analysis, status, user.ID)
	created, err := scanQuestion(row)
	if err != nil {
		return nil, err
	}

	answerPayload := input.AnswerPayload
	correctLabels := selectedAnswerValues(answerPayload)
	if created.AnswerMode == "choice" {
		if len(correctLabels) == 0 {
			for _, option := range input.Options {
				if option.IsCorrect {
					correctLabels = append(correctLabels, strings.TrimSpace(option.Label))
				}
			}
		}
		answerPayload = canonicalChoiceAnswerPayload(answerPayload, correctLabels)
	}
	if _, err := tx.Exec(ctx, `
			INSERT INTO question_answer_keys (question_id, answer_mode, answer_payload)
			VALUES ($1, $2, $3)
	`, created.ID, created.AnswerMode, marshalJSONObject(answerPayload)); err != nil {
		return nil, err
	}

	if created.AnswerMode == "choice" {
		correct := stringSet(correctLabels)
		for index, option := range input.Options {
			if _, err := tx.Exec(ctx, `
					INSERT INTO question_options (question_id, option_label, sort_order, content, is_correct)
					VALUES ($1, $2, $3, $4, $5)
			`, created.ID, strings.TrimSpace(option.Label), index+1, strings.TrimSpace(option.Content), correct[strings.TrimSpace(option.Label)]); err != nil {
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
	if input.ChoiceVariant != nil {
		variant := strings.TrimSpace(*input.ChoiceVariant)
		if strings.TrimSpace(input.AnswerMode) != "choice" || (variant != "single" && variant != "multiple") {
			details = append(details, api.ValidationDetail{Field: "choiceVariant", Message: "must be single or multiple for choice questions"})
		}
	}
	if len(details) > 0 {
		return api.ValidationError(details)
	}
	return nil
}

func UpdateQuestion(ctx context.Context, db *pgxpool.Pool, user *auth.User, questionID int64, input UpdateQuestionInput) (*Question, error) {
	if input.Stem == nil && !input.AnalysisSet {
		return nil, api.ValidationError([]api.ValidationDetail{{Field: "body", Message: "must include stem or analysis"}})
	}
	if input.Stem != nil {
		stem := strings.TrimSpace(*input.Stem)
		if stem == "" {
			return nil, api.ValidationError([]api.ValidationDetail{{Field: "stem", Message: "is required"}})
		}
		input.Stem = &stem
	}
	if input.AnalysisSet && input.Analysis != nil {
		analysis := strings.TrimSpace(*input.Analysis)
		input.Analysis = &analysis
	}
	if err := EnsureQuestionEditable(ctx, db, user, questionID); err != nil {
		return nil, err
	}
	question, err := withTx(ctx, db, func(tx pgx.Tx) (*Question, error) {
		row := tx.QueryRow(ctx, `
			UPDATE questions
			SET
				stem = COALESCE($2, stem),
				analysis = CASE WHEN $4 THEN $3 ELSE analysis END
			WHERE id = $1
			RETURNING `+questionColumns+`
		`, questionID, input.Stem, input.Analysis, input.AnalysisSet)
		updated, err := scanQuestion(row)
		if err != nil {
			return nil, err
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
			SELECT DISTINCT bank_id
			FROM v_bank_question_items
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
	mode := strings.TrimSpace(input.AnswerMode)
	return withTx(ctx, db, func(tx pgx.Tx) (*QuestionAnswerKey, error) {
		var questionMode string
		if err := tx.QueryRow(ctx, `SELECT answer_mode FROM questions WHERE id = $1 FOR UPDATE`, questionID).Scan(&questionMode); err != nil {
			return nil, err
		}
		if mode != questionMode {
			return nil, api.ValidationError([]api.ValidationDetail{{Field: "answerMode", Message: "must match the question answer mode"}})
		}
		if mode == "choice" {
			rows, err := tx.Query(ctx, `SELECT option_label FROM question_options WHERE question_id = $1`, questionID)
			if err != nil {
				return nil, err
			}
			defer rows.Close()
			labels := map[string]struct{}{}
			for rows.Next() {
				var label string
				if err := rows.Scan(&label); err != nil {
					return nil, err
				}
				labels[label] = struct{}{}
			}
			if err := rows.Err(); err != nil {
				return nil, err
			}
			for _, label := range selectedAnswerValues(input.AnswerPayload) {
				if _, ok := labels[label]; !ok {
					return nil, api.ValidationError([]api.ValidationDetail{{Field: "answerPayload", Message: "must reference existing option labels"}})
				}
			}
		}
		row := tx.QueryRow(ctx, `
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
		`, questionID, mode, marshalJSONObject(input.AnswerPayload), marshalJSONObject(input.ExplanationPayload), marshalJSONObject(input.ScorePayload))
		answerKey, err := scanQuestionAnswerKey(row)
		if err != nil {
			return nil, err
		}
		if mode == "choice" {
			selected := selectedAnswerValues(input.AnswerPayload)
			if _, err := tx.Exec(ctx, `
				UPDATE question_options
				SET is_correct = option_label = ANY($2::text[])
				WHERE question_id = $1
			`, questionID, selected); err != nil {
				return nil, err
			}
		}
		return &answerKey, nil
	})
}

func CreateOption(ctx context.Context, db *pgxpool.Pool, user *auth.User, questionID int64, input CreateOptionInput) (*QuestionOptionRecord, error) {
	if err := validateCreateOptionInput(&input); err != nil {
		return nil, err
	}
	if err := EnsureQuestionEditable(ctx, db, user, questionID); err != nil {
		return nil, err
	}
	return withTx(ctx, db, func(tx pgx.Tx) (*QuestionOptionRecord, error) {
		sortOrder := 0
		if input.SortOrder != nil {
			sortOrder = *input.SortOrder
		} else if err := tx.QueryRow(ctx, `
			SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort
			FROM question_options
			WHERE question_id = $1
		`, questionID).Scan(&sortOrder); err != nil {
			return nil, err
		}
		row := tx.QueryRow(ctx, `
			INSERT INTO question_options (question_id, option_label, sort_order, content, is_correct)
			VALUES ($1, $2, $3, $4, $5)
			RETURNING id, question_id, option_label, sort_order, content, is_correct, created_at, updated_at
		`, questionID, input.Label, sortOrder, input.Content, input.IsCorrect)
		option, err := scanQuestionOption(row)
		if err != nil {
			return nil, err
		}
		if err := syncChoiceAnswerKeyFromOptions(ctx, tx, questionID); err != nil {
			return nil, err
		}
		return &option, nil
	})
}

func UpdateOption(ctx context.Context, db *pgxpool.Pool, user *auth.User, questionID int64, optionID int64, input UpdateOptionInput) (*QuestionOptionRecord, error) {
	if err := validateUpdateOptionInput(&input); err != nil {
		return nil, err
	}
	if err := EnsureQuestionEditable(ctx, db, user, questionID); err != nil {
		return nil, err
	}
	return withTx(ctx, db, func(tx pgx.Tx) (*QuestionOptionRecord, error) {
		row := tx.QueryRow(ctx, `
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
		if err := syncChoiceAnswerKeyFromOptions(ctx, tx, questionID); err != nil {
			return nil, err
		}
		return &option, nil
	})
}

func DeleteOption(ctx context.Context, db *pgxpool.Pool, user *auth.User, questionID int64, optionID int64) error {
	if err := EnsureQuestionEditable(ctx, db, user, questionID); err != nil {
		return err
	}
	_, err := withTx(ctx, db, func(tx pgx.Tx) (struct{}, error) {
		result, err := tx.Exec(ctx, `DELETE FROM question_options WHERE id = $1 AND question_id = $2`, optionID, questionID)
		if err != nil {
			return struct{}{}, err
		}
		if result.RowsAffected() == 0 {
			return struct{}{}, api.NewError(404, "NOT_FOUND", "Option not found", nil)
		}
		return struct{}{}, syncChoiceAnswerKeyFromOptions(ctx, tx, questionID)
	})
	return err
}

func ReplaceQuestionContentBlocks(ctx context.Context, db *pgxpool.Pool, user *auth.User, questionID int64, blocks []QuestionContentBlockInput) error {
	if err := EnsureQuestionEditable(ctx, db, user, questionID); err != nil {
		return err
	}
	for _, block := range blocks {
		if block.MediaID != nil {
			if err := ensureMediaOwned(ctx, db, *user, *block.MediaID); err != nil {
				return err
			}
		}
	}
	_, err := withTx(ctx, db, func(tx pgx.Tx) (struct{}, error) {
		return struct{}{}, replaceQuestionContentBlocksTx(ctx, tx, questionID, blocks)
	})
	return err
}

func replaceQuestionContentBlocksTx(ctx context.Context, tx pgx.Tx, questionID int64, blocks []QuestionContentBlockInput) error {
	if err := validateQuestionContentBlocks(blocks); err != nil {
		return err
	}
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

func validateQuestionContentBlocks(blocks []QuestionContentBlockInput) error {
	if len(blocks) > 1000 {
		return api.ValidationError([]api.ValidationDetail{{Field: "blocks", Message: "must contain no more than 1000 items"}})
	}
	var details []api.ValidationDetail
	for index := range blocks {
		block := &blocks[index]
		prefix := fmt.Sprintf("blocks.%d.", index)
		ownerKind := "question"
		if block.OwnerKind != nil {
			ownerKind = strings.TrimSpace(*block.OwnerKind)
			block.OwnerKind = &ownerKind
		}
		switch ownerKind {
		case "question", "stem", "answer_key", "analysis", "explanation":
		default:
			details = append(details, api.ValidationDetail{Field: prefix + "ownerKind", Message: "is invalid for a question block"})
		}
		block.PartType = strings.TrimSpace(block.PartType)
		switch block.PartType {
		case "text", "formula", "image", "table", "list", "html", "markdown", "chart", "diagram", "qr_code":
		default:
			details = append(details, api.ValidationDetail{Field: prefix + "partType", Message: "is invalid"})
		}
		if block.Sequence != nil && *block.Sequence <= 0 {
			details = append(details, api.ValidationDetail{Field: prefix + "sequence", Message: "must be positive"})
		}
		if block.ContentMode != nil {
			mode := strings.TrimSpace(*block.ContentMode)
			block.ContentMode = &mode
			if mode != "text_only" && mode != "mixed_media" && mode != "structured_rich" {
				details = append(details, api.ValidationDetail{Field: prefix + "contentMode", Message: "is invalid"})
			}
		}
		if block.Role != nil && utf8.RuneCountInString(*block.Role) > 64 {
			details = append(details, api.ValidationDetail{Field: prefix + "role", Message: "must be no more than 64 characters"})
		}
		if block.TextFormat != nil && utf8.RuneCountInString(*block.TextFormat) > 32 {
			details = append(details, api.ValidationDetail{Field: prefix + "textFormat", Message: "must be no more than 32 characters"})
		}
		if block.MediaID != nil && *block.MediaID <= 0 {
			details = append(details, api.ValidationDetail{Field: prefix + "mediaId", Message: "must be positive"})
		}
	}
	if len(details) > 0 {
		return api.ValidationError(details)
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
		if len(options) > 32767 {
			return api.ValidationError([]api.ValidationDetail{{Field: "options", Message: "must contain no more than 32767 items"}})
		}
		for _, option := range options {
			label := strings.TrimSpace(option.Label)
			if label == "" || utf8.RuneCountInString(label) > 16 || strings.TrimSpace(option.Content) == "" {
				return api.NewError(422, "VALIDATION_ERROR", "Choice options require a label of at most 16 characters and non-empty content", nil)
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
		hasAnswer := hasUsableAnswerPayload(mode, answerPayload)
		if mode == "choice" && !hasAnswer {
			for _, option := range options {
				hasAnswer = hasAnswer || option.IsCorrect
			}
		}
		if !hasAnswer {
			return api.NewError(409, "INVALID_STATE", "Active questions require a usable answer payload", nil)
		}
		if mode == "choice" {
			correct := len(selectedAnswerValues(answerPayload)) > 0
			for _, option := range options {
				correct = correct || option.IsCorrect
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
	for _, key := range []string{"selected", "correctOptions", "correctOption"} {
		if values := normalizeQuestionStringArray(questionObjectValue(payload, key)); len(values) > 0 {
			return values
		}
	}
	return nil
}

func canonicalChoiceAnswerPayload(payload map[string]any, selected []string) map[string]any {
	result := make(map[string]any, len(payload)+1)
	for key, value := range payload {
		result[key] = value
	}
	delete(result, "correctOption")
	delete(result, "correctOptions")
	result["selected"] = selected
	return result
}

func stringSet(values []string) map[string]bool {
	result := make(map[string]bool, len(values))
	for _, value := range values {
		result[value] = true
	}
	return result
}

func syncChoiceAnswerKeyFromOptions(ctx context.Context, tx pgx.Tx, questionID int64) error {
	var mode string
	var raw *string
	if err := tx.QueryRow(ctx, `
		SELECT
			q.answer_mode,
			(SELECT answer_payload FROM question_answer_keys WHERE question_id = q.id AND is_primary = true LIMIT 1)
		FROM questions q
		WHERE q.id = $1
	`, questionID).Scan(&mode, &raw); err != nil {
		return err
	}
	if mode != "choice" || raw == nil {
		return nil
	}
	rows, err := tx.Query(ctx, `
		SELECT option_label
		FROM question_options
		WHERE question_id = $1 AND is_correct = true
		ORDER BY sort_order, id
	`, questionID)
	if err != nil {
		return err
	}
	selected := []string{}
	for rows.Next() {
		var label string
		if err := rows.Scan(&label); err != nil {
			rows.Close()
			return err
		}
		selected = append(selected, label)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	payload := map[string]any{}
	if strings.TrimSpace(*raw) != "" {
		if err := json.Unmarshal([]byte(*raw), &payload); err != nil {
			return fmt.Errorf("decode answer payload: %w", err)
		}
	}
	_, err = tx.Exec(ctx, `
		UPDATE question_answer_keys
		SET answer_payload = $2
		WHERE question_id = $1 AND is_primary = true
	`, questionID, marshalJSONObject(canonicalChoiceAnswerPayload(payload, selected)))
	return err
}

func validateCreateOptionInput(input *CreateOptionInput) error {
	input.Label = strings.TrimSpace(input.Label)
	input.Content = strings.TrimSpace(input.Content)
	var details []api.ValidationDetail
	if input.Label == "" || utf8.RuneCountInString(input.Label) > 16 {
		details = append(details, api.ValidationDetail{Field: "label", Message: "must be 1-16 characters"})
	}
	if input.Content == "" {
		details = append(details, api.ValidationDetail{Field: "content", Message: "is required"})
	}
	if input.SortOrder != nil && (*input.SortOrder < 1 || *input.SortOrder > 32767) {
		details = append(details, api.ValidationDetail{Field: "sortOrder", Message: "must be between 1 and 32767"})
	}
	if len(details) > 0 {
		return api.ValidationError(details)
	}
	return nil
}

func validateUpdateOptionInput(input *UpdateOptionInput) error {
	if input.Label == nil && input.Content == nil && input.IsCorrect == nil && input.SortOrder == nil {
		return api.ValidationError([]api.ValidationDetail{{Field: "body", Message: "must include a field to update"}})
	}
	var details []api.ValidationDetail
	if input.Label != nil {
		label := strings.TrimSpace(*input.Label)
		input.Label = &label
		if label == "" || utf8.RuneCountInString(label) > 16 {
			details = append(details, api.ValidationDetail{Field: "label", Message: "must be 1-16 characters"})
		}
	}
	if input.Content != nil {
		content := strings.TrimSpace(*input.Content)
		input.Content = &content
		if content == "" {
			details = append(details, api.ValidationDetail{Field: "content", Message: "is required"})
		}
	}
	if input.SortOrder != nil && (*input.SortOrder < 1 || *input.SortOrder > 32767) {
		details = append(details, api.ValidationDetail{Field: "sortOrder", Message: "must be between 1 and 32767"})
	}
	if len(details) > 0 {
		return api.ValidationError(details)
	}
	return nil
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
	var isCorrect bool
	err := row.Scan(&option.ID, &option.QuestionID, &option.OptionLabel, &option.SortOrder, &option.Content, &isCorrect, &option.CreatedAt, &option.UpdatedAt)
	option.IsCorrect = new(isCorrect)
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
