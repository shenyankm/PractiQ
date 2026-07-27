package services

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"openwook/internal/api"
	"openwook/internal/auth"
	"openwook/internal/redisx"
)

type PracticeSessionInput struct {
	BankID         int64
	SessionType    string
	QuestionCount  int
	Mode           string
	QuestionTypeID *string
	AllQuestions   bool
}

type PracticeSessionListOptions struct {
	Limit  int
	Status string
	Cursor string
}

type PracticeQuestionPageOptions struct {
	Index *int
}

type PracticeAnswer struct {
	ID            int64          `json:"id"`
	UserID        int64          `json:"user_id"`
	SessionID     *int64         `json:"session_id"`
	BankID        *int64         `json:"bank_id"`
	QuestionID    int64          `json:"question_id"`
	AnswerKeyID   *int64         `json:"answer_key_id"`
	AnswerPayload map[string]any `json:"answer_payload"`
	IsCorrect     *bool          `json:"is_correct"`
	Score         *float64       `json:"score"`
	MaxScore      *float64       `json:"max_score"`
	DurationMS    *int           `json:"duration_ms"`
	AnsweredAt    time.Time      `json:"answered_at"`
}

type PracticeAnswerInput struct {
	QuestionID    int64
	AnswerPayload map[string]any
	DurationMS    *int
}

type PracticeQuestionPage struct {
	Session       PracticeSession        `json:"session"`
	Question      *BankQuestionItem      `json:"question"`
	QuestionIndex int                    `json:"questionIndex"`
	Total         int                    `json:"total"`
	AnsweredCount int                    `json:"answeredCount"`
	Progress      []PracticeProgressItem `json:"progress"`
	Result        *PracticeAnswer        `json:"result"`
	PreviousIndex *int                   `json:"previousIndex"`
	NextIndex     *int                   `json:"nextIndex"`
}

type PracticeResult struct {
	PracticeAnswer
	Stem       string              `json:"stem"`
	AnswerMode string              `json:"answer_mode"`
	Analysis   *string             `json:"analysis"`
	AnswerKeys []QuestionAnswerKey `json:"answer_keys"`
}

func StartPracticeSession(ctx context.Context, db *pgxpool.Pool, user *auth.User, input PracticeSessionInput) (*PracticeSession, error) {
	if _, err := GetBank(ctx, db, user, input.BankID); err != nil {
		return nil, err
	}
	mode := normalizePracticeMode(strings.TrimSpace(input.Mode), strings.TrimSpace(input.SessionType))
	questionTypeID := strings.TrimSpace(stringValue(input.QuestionTypeID))
	if mode == PracticeModeByType && questionTypeID == "" {
		return nil, api.NewError(422, "VALIDATION_ERROR", "Question type is required for type-based practice", nil)
	}
	count := normalizeQuestionCount(input.QuestionCount, input.AllQuestions || (mode == PracticeModeAll && input.QuestionCount < 1))
	questionIDs, err := loadPracticeQuestionIDs(ctx, db, user, input.BankID, count, mode, questionTypeID)
	if err != nil {
		return nil, err
	}
	if len(questionIDs) < 1 {
		message := "No active questions are available for practice"
		if mode == PracticeModeWrong {
			message = "No wrong questions are available for review"
		}
		return nil, api.NewError(409, "INVALID_STATE", message, nil)
	}

	sessionType := "practice"
	if mode == PracticeModeExam {
		sessionType = "exam"
	} else if mode == PracticeModeWrong {
		sessionType = "review"
	} else if strings.TrimSpace(input.SessionType) != "" {
		sessionType = strings.TrimSpace(input.SessionType)
	}

	row := db.QueryRow(ctx, `
		INSERT INTO user_practice_sessions (user_id, bank_id, session_type, question_count)
		VALUES ($1, $2, $3, $4)
		RETURNING id, user_id, bank_id, session_type, status, question_count, answered_count, correct_count, wrong_count, score, started_at, completed_at
	`, user.ID, input.BankID, sessionType, len(questionIDs))
	session, err := scanPracticeSessionRows(row)
	if err != nil {
		return nil, err
	}
	if rdb := redisx.Client(); rdb != nil {
		_ = redisx.SetJSON(ctx, rdb, practiceQuestionQueueKey(session.ID), questionIDs, practiceQueueTTL())
	}
	return &session, nil
}

func GetPracticeSession(ctx context.Context, db *pgxpool.Pool, user *auth.User, sessionID int64) (*PracticeSession, error) {
	row := db.QueryRow(ctx, `
		SELECT id, user_id, bank_id, session_type, status, question_count, answered_count, correct_count, wrong_count, score, started_at, completed_at
		FROM user_practice_sessions
		WHERE id = $1 AND user_id = $2
		LIMIT 1
	`, sessionID, user.ID)
	session, err := scanPracticeSessionRows(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, api.NewError(404, "NOT_FOUND", "Practice session not found", nil)
	}
	if err != nil {
		return nil, err
	}
	return &session, nil
}

func GetPracticeQuestions(ctx context.Context, db *pgxpool.Pool, user *auth.User, sessionID int64) ([]BankQuestionItem, error) {
	session, err := GetPracticeSession(ctx, db, user, sessionID)
	if err != nil {
		return nil, err
	}
	questionIDs, err := ensurePracticeQuestionQueue(ctx, db, session)
	if err != nil {
		return nil, err
	}
	return loadPracticeQuestionRows(ctx, db, session, questionIDs, 0, len(questionIDs))
}

func GetPracticeQuestionPage(ctx context.Context, db *pgxpool.Pool, user *auth.User, sessionID int64, options PracticeQuestionPageOptions) (*PracticeQuestionPage, error) {
	session, err := GetPracticeSession(ctx, db, user, sessionID)
	if err != nil {
		return nil, err
	}
	questionIDs, err := ensurePracticeQuestionQueue(ctx, db, session)
	if err != nil {
		return nil, err
	}

	rows, err := db.Query(ctx, `
		SELECT question_id, is_correct
		FROM user_question_answers
		WHERE user_id = $1
		  AND session_id = $2
		ORDER BY answered_at, id
	`, user.ID, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	answered := make(map[int64]*bool, len(questionIDs))
	for rows.Next() {
		var questionID int64
		var correct sql.NullBool
		if err := rows.Scan(&questionID, &correct); err != nil {
			return nil, err
		}
		if correct.Valid {
			answered[questionID] = new(correct.Bool)
		} else {
			answered[questionID] = nil
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	fallbackIndex := 0
	for index, questionID := range questionIDs {
		if _, ok := answered[questionID]; !ok {
			fallbackIndex = index
			break
		}
	}
	currentIndex := fallbackIndex
	if options.Index != nil {
		currentIndex = *options.Index
		if currentIndex < 0 {
			currentIndex = 0
		}
		if len(questionIDs) > 0 && currentIndex > len(questionIDs)-1 {
			currentIndex = len(questionIDs) - 1
		}
	}

	items, err := loadPracticeQuestionRows(ctx, db, session, questionIDs, currentIndex, 1)
	if err != nil {
		return nil, err
	}
	var question *BankQuestionItem
	if len(items) > 0 {
		question = &items[0]
	}
	var result *PracticeAnswer
	if question != nil {
		result, err = getExistingPracticeAnswer(ctx, db, int64(user.ID), sessionID, question.QuestionID)
		if err != nil {
			return nil, err
		}
		result = practiceAnswerForSession(result, session)
		if shouldRevealPracticeFeedback(session, result) {
			var analysis sql.NullString
			if err := db.QueryRow(ctx, `SELECT analysis FROM questions WHERE id = $1`, question.QuestionID).Scan(&analysis); err != nil {
				return nil, err
			}
			if analysis.Valid {
				question.Analysis = new(analysis.String)
			}
		}
	}

	progress := buildPracticeProgress(questionIDs, answered)
	if session.SessionType == "exam" && session.Status == "active" {
		for index := range progress {
			progress[index].IsCorrect = nil
		}
	}
	page := &PracticeQuestionPage{
		Session:       *session,
		Question:      question,
		Total:         len(questionIDs),
		AnsweredCount: len(answered),
		Progress:      progress,
		Result:        result,
	}
	if question != nil {
		page.QuestionIndex = currentIndex
		if currentIndex > 0 {
			page.PreviousIndex = new(currentIndex - 1)
		}
		if currentIndex < len(questionIDs)-1 {
			page.NextIndex = new(currentIndex + 1)
		}
	}
	return page, nil
}

func ListPracticeSessions(ctx context.Context, db *pgxpool.Pool, user *auth.User, options PracticeSessionListOptions) (Page[PracticeSession], error) {
	limit := options.Limit
	if limit < 1 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	offset, err := parsePageCursor(options.Cursor)
	if err != nil {
		return Page[PracticeSession]{}, err
	}
	status := strings.TrimSpace(options.Status)
	switch status {
	case "", "active", "completed", "abandoned":
	default:
		return Page[PracticeSession]{}, api.ValidationError([]api.ValidationDetail{{Field: "status", Message: "must be one of active, completed, abandoned"}})
	}
	rows, err := db.Query(ctx, `
		SELECT id, user_id, bank_id, session_type, status, question_count, answered_count, correct_count, wrong_count, score, started_at, completed_at
		FROM user_practice_sessions
		WHERE user_id = $1
		  AND ($2::text = '' OR status = $2)
		ORDER BY started_at DESC, id DESC
		LIMIT $3 OFFSET $4
	`, user.ID, status, limit+1, offset)
	if err != nil {
		return Page[PracticeSession]{}, err
	}
	defer rows.Close()

	sessions := make([]PracticeSession, 0, limit)
	for rows.Next() {
		session, scanErr := scanPracticeSessionRows(rows)
		if scanErr != nil {
			return Page[PracticeSession]{}, scanErr
		}
		sessions = append(sessions, session)
	}
	if err := rows.Err(); err != nil {
		return Page[PracticeSession]{}, err
	}
	return buildPage(sessions, limit, offset), nil
}

func SubmitAnswer(ctx context.Context, db *pgxpool.Pool, user *auth.User, sessionID int64, input PracticeAnswerInput) (*PracticeAnswer, error) {
	session, err := GetPracticeSession(ctx, db, user, sessionID)
	if err != nil {
		return nil, err
	}
	existing, err := getExistingPracticeAnswer(ctx, db, int64(user.ID), sessionID, input.QuestionID)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return practiceAnswerForSession(existing, session), nil
	}
	if session.Status != "active" {
		return nil, api.NewError(409, "INVALID_STATE", "Practice session is not active", nil)
	}
	if rdb := redisx.Client(); rdb != nil {
		if queued, ok := redisx.GetJSON[[]int64](ctx, rdb, practiceQuestionQueueKey(sessionID)); ok && len(queued) > 0 && !slices.Contains(queued, input.QuestionID) {
			return nil, api.NewError(404, "NOT_FOUND", "Question is not part of this practice session", nil)
		}
	}

	answerKey, err := loadPrimaryAnswerKey(ctx, db, input.QuestionID)
	if err != nil {
		return nil, err
	}
	var answerMode string
	err = db.QueryRow(ctx, `
		SELECT answer_mode
		FROM v_bank_question_items
		WHERE question_id = $1
		  AND bank_id = $2
		  AND question_status = 'active'
		  AND bank_link_status = 'active'
		LIMIT 1
	`, input.QuestionID, nullableInt64Pointer(session.BankID)).Scan(&answerMode)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, api.NewError(404, "NOT_FOUND", "Question is not part of this active practice session", nil)
	}
	if err != nil {
		return nil, err
	}
	if err := validateSubmittedPracticeAnswer(answerMode, input.AnswerPayload); err != nil {
		return nil, err
	}

	isCorrect := gradePracticeAnswer(answerMode, answerKey, input.AnswerPayload)
	var score *float64
	var maxScore *float64
	if answerKey != nil {
		maxScore = new(1.0)
		if isCorrect != nil {
			if *isCorrect {
				score = new(1.0)
			} else {
				score = new(0.0)
			}
		}
	}
	payloadJSON, err := json.Marshal(input.AnswerPayload)
	if err != nil {
		return nil, err
	}
	row := db.QueryRow(ctx, `
		INSERT INTO user_question_answers (
			user_id, session_id, bank_id, question_id, answer_key_id,
			answer_payload, is_correct, score, max_score, duration_ms
		)
		VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
		ON CONFLICT (user_id, session_id, question_id) DO NOTHING
		RETURNING id, user_id, session_id, bank_id, question_id, answer_key_id, answer_payload, is_correct, score, max_score, duration_ms, answered_at
	`, user.ID, sessionID, nullableInt64Pointer(session.BankID), input.QuestionID, nullableQuestionAnswerKeyID(answerKey), string(payloadJSON), isCorrect, score, maxScore, input.DurationMS)
	answer, err := scanPracticeAnswerRow(row)
	if errors.Is(err, pgx.ErrNoRows) {
		existing, lookupErr := getExistingPracticeAnswer(ctx, db, int64(user.ID), sessionID, input.QuestionID)
		if lookupErr != nil {
			return nil, lookupErr
		}
		if existing != nil {
			return practiceAnswerForSession(existing, session), nil
		}
	}
	if err != nil {
		return nil, err
	}
	bumpSliceCacheVersion(ctx, "analytics", user.ID)
	if session.BankID != nil {
		bumpSliceCacheVersion(ctx, "bank-analytics", *session.BankID)
		bumpSliceCacheVersion(ctx, "leaderboard", *session.BankID)
	}
	return practiceAnswerForSession(&answer, session), nil
}

func CompletePracticeSession(ctx context.Context, db *pgxpool.Pool, user *auth.User, sessionID int64, status string) (*PracticeSession, error) {
	row := db.QueryRow(ctx, `
		UPDATE user_practice_sessions
		SET status = $1, completed_at = NOW()
		WHERE id = $2
		  AND user_id = $3
		  AND status = 'active'
		RETURNING id, user_id, bank_id, session_type, status, question_count, answered_count, correct_count, wrong_count, score, started_at, completed_at
	`, status, sessionID, user.ID)
	session, err := scanPracticeSessionRows(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, api.NewError(404, "NOT_FOUND", "Active practice session not found", nil)
	}
	if err != nil {
		return nil, err
	}
	bumpSliceCacheVersion(ctx, "analytics", user.ID)
	return &session, nil
}

func GetPracticeResults(ctx context.Context, db *pgxpool.Pool, user *auth.User, sessionID int64) ([]PracticeResult, error) {
	session, err := GetPracticeSession(ctx, db, user, sessionID)
	if err != nil {
		return nil, err
	}
	if session.Status == "active" {
		return nil, api.NewError(409, "INVALID_STATE", "Complete the practice session before viewing results", nil)
	}
	rows, err := db.Query(ctx, `
		SELECT
			uqa.id,
			uqa.user_id,
			uqa.session_id,
			uqa.bank_id,
			uqa.question_id,
			uqa.answer_key_id,
			uqa.answer_payload,
			uqa.is_correct,
			uqa.score,
			uqa.max_score,
			uqa.duration_ms,
			uqa.answered_at,
			q.stem,
			q.answer_mode,
			q.analysis,
			COALESCE(
				(
					SELECT json_agg(qak.* ORDER BY qak.version)
					FROM question_answer_keys qak
					WHERE qak.question_id = q.id
				),
				'[]'::json
			) AS answer_keys
		FROM user_question_answers uqa
		JOIN questions q ON q.id = uqa.question_id
		WHERE uqa.user_id = $1
		  AND uqa.session_id = $2
		ORDER BY uqa.answered_at, uqa.id
	`, user.ID, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	results := make([]PracticeResult, 0)
	for rows.Next() {
		result, scanErr := scanPracticeResultRows(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		results = append(results, result)
	}
	return results, rows.Err()
}

func practiceAnswerForSession(answer *PracticeAnswer, session *PracticeSession) *PracticeAnswer {
	if answer == nil || session == nil || session.SessionType != "exam" || session.Status != "active" {
		return answer
	}
	safe := *answer
	safe.AnswerKeyID = nil
	safe.IsCorrect = nil
	safe.Score = nil
	safe.MaxScore = nil
	return &safe
}

func shouldRevealPracticeFeedback(session *PracticeSession, answer *PracticeAnswer) bool {
	return session != nil && answer != nil && (session.SessionType != "exam" || session.Status != "active")
}

func ensurePracticeQuestionQueue(ctx context.Context, db *pgxpool.Pool, session *PracticeSession) ([]int64, error) {
	if session == nil || session.BankID == nil {
		return []int64{}, nil
	}
	key := practiceQuestionQueueKey(session.ID)
	if rdb := redisx.Client(); rdb != nil {
		if cached, ok := redisx.GetJSON[[]int64](ctx, rdb, key); ok && len(cached) > 0 {
			if len(cached) > session.QuestionCount {
				return cached[:session.QuestionCount], nil
			}
			return cached, nil
		}
	}
	rows, err := db.Query(ctx, `
		SELECT question_id
		FROM v_bank_question_items
		WHERE bank_id = $1
		  AND bank_link_status = 'active'
		  AND question_status = 'active'
		ORDER BY bank_sort_order, group_sort_order NULLS FIRST, question_id
		LIMIT $2
	`, *session.BankID, session.QuestionCount)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	questionIDs := make([]int64, 0, session.QuestionCount)
	for rows.Next() {
		var questionID int64
		if err := rows.Scan(&questionID); err != nil {
			return nil, err
		}
		questionIDs = append(questionIDs, questionID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if rdb := redisx.Client(); rdb != nil {
		_ = redisx.SetJSON(ctx, rdb, key, questionIDs, practiceQueueTTL())
	}
	return questionIDs, nil
}

func loadPracticeQuestionRows(ctx context.Context, db *pgxpool.Pool, session *PracticeSession, questionIDs []int64, offset int, limit int) ([]BankQuestionItem, error) {
	if session == nil || session.BankID == nil || len(questionIDs) == 0 {
		return []BankQuestionItem{}, nil
	}
	if offset < 0 {
		offset = 0
	}
	if limit < 1 {
		limit = len(questionIDs)
	}
	if offset >= len(questionIDs) {
		return []BankQuestionItem{}, nil
	}
	end := offset + limit
	if end > len(questionIDs) {
		end = len(questionIDs)
	}
	slice := questionIDs[offset:end]
	rows, err := db.Query(ctx, `
		WITH requested_ids AS (
			SELECT id, ord
			FROM unnest($2::bigint[]) WITH ORDINALITY AS requested(id, ord)
		)
		SELECT
			item.bank_id,
			item.group_id,
			item.question_id,
			item.item_scope,
			item.bank_sort_order,
			item.group_sort_order,
			item.question_no,
			item.bank_link_status,
			item.business_type,
			item.subject_id,
			item.question_type_id,
			item.answer_mode,
			item.choice_variant,
			item.content_mode,
			item.stem,
			NULL::text AS analysis,
			item.question_status,
			item.group_title,
			item.group_instructions,
			COALESCE(
				(
					SELECT jsonb_agg(
						jsonb_build_object(
							'id', qo.id,
							'question_id', qo.question_id,
							'option_label', qo.option_label,
							'sort_order', qo.sort_order,
							'content', qo.content,
							'created_at', qo.created_at,
							'updated_at', qo.updated_at
						)
						ORDER BY qo.sort_order
					)
					FROM question_options qo
					WHERE qo.question_id = item.question_id
				),
				'[]'::json
			) AS options
		FROM requested_ids
		JOIN v_bank_question_items item ON item.question_id = requested_ids.id
		WHERE item.bank_id = $1
		  AND item.bank_link_status = 'active'
		  AND item.question_status = 'active'
		ORDER BY requested_ids.ord
	`, *session.BankID, slice)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]BankQuestionItem, 0, len(slice))
	for rows.Next() {
		var item BankQuestionItem
		var optionsRaw []byte
		if err := rows.Scan(
			&item.BankID,
			&item.GroupID,
			&item.QuestionID,
			&item.ItemScope,
			&item.BankSortOrder,
			&item.GroupSortOrder,
			&item.QuestionNo,
			&item.BankLinkStatus,
			&item.BusinessType,
			&item.SubjectID,
			&item.QuestionTypeID,
			&item.AnswerMode,
			&item.ChoiceVariant,
			&item.ContentMode,
			&item.Stem,
			&item.Analysis,
			&item.QuestionStatus,
			&item.GroupTitle,
			&item.GroupInstructions,
			&optionsRaw,
		); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(optionsRaw, &item.Options); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func loadPracticeQuestionIDs(ctx context.Context, db *pgxpool.Pool, user *auth.User, bankID int64, count int, mode string, questionTypeID string) ([]int64, error) {
	typeFilter := trimmedStringOrNil(questionTypeID)
	if mode != PracticeModeByType {
		typeFilter = nil
	}
	rows, err := db.Query(ctx, `
		SELECT item.question_id
		FROM v_bank_question_items item
		LEFT JOIN user_question_stats uqs
		  ON uqs.question_id = item.question_id
		 AND uqs.user_id = $2
		WHERE item.bank_id = $1
		  AND item.bank_link_status = 'active'
		  AND item.question_status = 'active'
		  AND ($4::text IS NULL OR item.question_type_id = $4)
		  AND (
			$3 <> 'wrong'
			OR COALESCE(uqs.wrong_count, 0) > 0
			OR uqs.last_is_correct IS FALSE
		  )
		GROUP BY item.question_id, item.bank_sort_order, item.group_sort_order, uqs.wrong_count, uqs.last_is_correct
		ORDER BY
			CASE WHEN $3 = 'wrong' THEN COALESCE(uqs.wrong_count, 0) ELSE 0 END DESC,
			CASE WHEN $3 = 'exam' THEN md5(item.question_id::text || $2::text || CURRENT_DATE::text) ELSE NULL END,
			item.bank_sort_order,
			item.group_sort_order NULLS FIRST,
			item.question_id
		LIMIT $5
	`, bankID, user.ID, mode, typeFilter, count)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	questionIDs := make([]int64, 0, count)
	for rows.Next() {
		var questionID int64
		if err := rows.Scan(&questionID); err != nil {
			return nil, err
		}
		questionIDs = append(questionIDs, questionID)
	}
	return questionIDs, rows.Err()
}

func loadPrimaryAnswerKey(ctx context.Context, db *pgxpool.Pool, questionID int64) (*QuestionAnswerKey, error) {
	row := db.QueryRow(ctx, `
		SELECT id, question_id, answer_mode, version, is_primary, answer_payload, explanation_payload, score_payload, created_at, updated_at
		FROM question_answer_keys
		WHERE question_id = $1
		  AND is_primary = true
		LIMIT 1
	`, questionID)
	var item QuestionAnswerKey
	err := row.Scan(
		&item.ID,
		&item.QuestionID,
		&item.AnswerMode,
		&item.Version,
		&item.IsPrimary,
		&item.AnswerPayload,
		&item.ExplanationPayload,
		&item.ScorePayload,
		&item.CreatedAt,
		&item.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func getExistingPracticeAnswer(ctx context.Context, db *pgxpool.Pool, userID int64, sessionID int64, questionID int64) (*PracticeAnswer, error) {
	row := db.QueryRow(ctx, `
		SELECT id, user_id, session_id, bank_id, question_id, answer_key_id, answer_payload, is_correct, score, max_score, duration_ms, answered_at
		FROM user_question_answers
		WHERE user_id = $1
		  AND session_id = $2
		  AND question_id = $3
		ORDER BY answered_at ASC, id ASC
		LIMIT 1
	`, userID, sessionID, questionID)
	answer, err := scanPracticeAnswerRow(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &answer, nil
}

func validateSubmittedPracticeAnswer(mode string, payload map[string]any) error {
	switch mode {
	case "choice":
		if len(selectedAnswerValues(payload)) < 1 {
			return api.NewError(422, "VALIDATION_ERROR", "Select at least one option before submitting", nil)
		}
	case "true_false":
		if _, ok := payload["value"].(bool); !ok {
			return api.NewError(422, "VALIDATION_ERROR", "Select true or false before submitting", nil)
		}
	case "fill_blank":
		if len(questionFillBlankValues(payload)) < 1 {
			return api.NewError(422, "VALIDATION_ERROR", "Fill at least one blank before submitting", nil)
		}
	case "short_answer":
		if normalizeQuestionText(payload["value"]) == "" {
			return api.NewError(422, "VALIDATION_ERROR", "Answer text is required before submitting", nil)
		}
	}
	return nil
}

func gradePracticeAnswer(mode string, answerKey *QuestionAnswerKey, payload map[string]any) *bool {
	if answerKey == nil {
		return nil
	}
	var expected map[string]any
	if err := json.Unmarshal([]byte(answerKey.AnswerPayload), &expected); err != nil {
		return nil
	}
	switch mode {
	case "choice":
		expectedValues := sortedQuestionValues(selectedAnswerValues(expected))
		actualValues := sortedQuestionValues(selectedAnswerValues(payload))
		matched := slices.Equal(expectedValues, actualValues)
		return new(matched)
	case "true_false":
		expectedValue, expectedOK := questionObjectValue(expected, "value").(bool)
		actualValue, actualOK := payload["value"].(bool)
		if !expectedOK || !actualOK {
			return nil
		}
		matched := expectedValue == actualValue
		return new(matched)
	case "fill_blank":
		expectedValues := questionFillBlankValues(expected)
		actualValues := questionFillBlankValues(payload)
		matched := len(expectedValues) > 0 && len(actualValues) >= len(expectedValues)
		if matched {
			for index := range expectedValues {
				if expectedValues[index] != actualValues[index] {
					matched = false
					break
				}
			}
		}
		return new(matched)
	default:
		return nil
	}
}

func practiceQuestionQueueKey(sessionID int64) string {
	return redisx.RedisKey("practice", sessionID, "question-ids")
}

func practiceQueueTTL() time.Duration {
	return time.Duration(analyticsEnvInt("PRACTICE_QUEUE_TTL_SECONDS", 7*24*60*60)) * time.Second
}

func nullableQuestionAnswerKeyID(answerKey *QuestionAnswerKey) any {
	if answerKey == nil {
		return nil
	}
	return answerKey.ID
}

func scanPracticeAnswerRow(row pgx.Row) (PracticeAnswer, error) {
	var answer PracticeAnswer
	var sessionID sql.NullInt64
	var bankID sql.NullInt64
	var answerKeyID sql.NullInt64
	var isCorrect sql.NullBool
	var score sql.NullFloat64
	var maxScore sql.NullFloat64
	var durationMS sql.NullInt32
	var payloadRaw []byte
	err := row.Scan(
		&answer.ID,
		&answer.UserID,
		&sessionID,
		&bankID,
		&answer.QuestionID,
		&answerKeyID,
		&payloadRaw,
		&isCorrect,
		&score,
		&maxScore,
		&durationMS,
		&answer.AnsweredAt,
	)
	if err != nil {
		return PracticeAnswer{}, err
	}
	answer.SessionID = analyticsNullableInt64(sessionID)
	answer.BankID = analyticsNullableInt64(bankID)
	answer.AnswerKeyID = analyticsNullableInt64(answerKeyID)
	answer.Score = analyticsNullableFloat64(score)
	answer.MaxScore = analyticsNullableFloat64(maxScore)
	if isCorrect.Valid {
		answer.IsCorrect = new(isCorrect.Bool)
	}
	if durationMS.Valid {
		answer.DurationMS = new(int(durationMS.Int32))
	}
	if len(payloadRaw) == 0 {
		answer.AnswerPayload = map[string]any{}
		return answer, nil
	}
	if err := json.Unmarshal(payloadRaw, &answer.AnswerPayload); err != nil {
		return PracticeAnswer{}, err
	}
	return answer, nil
}

func scanPracticeResultRows(rows pgx.Rows) (PracticeResult, error) {
	var result PracticeResult
	var sessionID sql.NullInt64
	var bankID sql.NullInt64
	var answerKeyID sql.NullInt64
	var isCorrect sql.NullBool
	var score sql.NullFloat64
	var maxScore sql.NullFloat64
	var durationMS sql.NullInt32
	var payloadRaw []byte
	var analysis sql.NullString
	var answerKeysRaw []byte
	err := rows.Scan(
		&result.ID,
		&result.UserID,
		&sessionID,
		&bankID,
		&result.QuestionID,
		&answerKeyID,
		&payloadRaw,
		&isCorrect,
		&score,
		&maxScore,
		&durationMS,
		&result.AnsweredAt,
		&result.Stem,
		&result.AnswerMode,
		&analysis,
		&answerKeysRaw,
	)
	if err != nil {
		return PracticeResult{}, err
	}
	result.SessionID = analyticsNullableInt64(sessionID)
	result.BankID = analyticsNullableInt64(bankID)
	result.AnswerKeyID = analyticsNullableInt64(answerKeyID)
	result.Score = analyticsNullableFloat64(score)
	result.MaxScore = analyticsNullableFloat64(maxScore)
	result.Analysis = analyticsNullableString(analysis)
	if isCorrect.Valid {
		result.IsCorrect = new(isCorrect.Bool)
	}
	if durationMS.Valid {
		result.DurationMS = new(int(durationMS.Int32))
	}
	if len(payloadRaw) > 0 {
		if err := json.Unmarshal(payloadRaw, &result.AnswerPayload); err != nil {
			return PracticeResult{}, err
		}
	}
	if len(answerKeysRaw) > 0 {
		if err := json.Unmarshal(answerKeysRaw, &result.AnswerKeys); err != nil {
			return PracticeResult{}, err
		}
	}
	return result, nil
}

func sortedQuestionValues(values []string) []string {
	copied := append([]string(nil), values...)
	slices.Sort(copied)
	return copied
}
