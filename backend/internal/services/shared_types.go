package services

import (
	"time"

	"github.com/jackc/pgx/v5"
)

type BankQuestionItem struct {
	BankID            int64                  `json:"bank_id"`
	GroupID           *int64                 `json:"group_id"`
	QuestionID        int64                  `json:"question_id"`
	ItemScope         string                 `json:"item_scope"`
	BankSortOrder     int                    `json:"bank_sort_order"`
	GroupSortOrder    *int                   `json:"group_sort_order"`
	QuestionNo        *string                `json:"question_no"`
	BankLinkStatus    string                 `json:"bank_link_status"`
	BusinessType      string                 `json:"business_type"`
	SubjectID         string                 `json:"subject_id"`
	QuestionTypeID    string                 `json:"question_type_id"`
	AnswerMode        string                 `json:"answer_mode"`
	ChoiceVariant     *string                `json:"choice_variant"`
	ContentMode       *string                `json:"content_mode"`
	Stem              string                 `json:"stem"`
	Analysis          *string                `json:"analysis"`
	QuestionStatus    string                 `json:"question_status"`
	GroupTitle        *string                `json:"group_title"`
	GroupInstructions *string                `json:"group_instructions"`
	Options           []QuestionOptionRecord `json:"options,omitempty"`
}

type PracticeSession struct {
	ID            int64      `json:"id"`
	UserID        int64      `json:"user_id"`
	BankID        *int64     `json:"bank_id"`
	SessionType   string     `json:"session_type"`
	Status        string     `json:"status"`
	QuestionCount int        `json:"question_count"`
	AnsweredCount int        `json:"answered_count"`
	CorrectCount  int        `json:"correct_count"`
	WrongCount    int        `json:"wrong_count"`
	Score         *float64   `json:"score"`
	StartedAt     time.Time  `json:"started_at"`
	CompletedAt   *time.Time `json:"completed_at"`
}

func scanPracticeSessionRows(row pgx.Row) (PracticeSession, error) {
	var session PracticeSession
	err := row.Scan(
		&session.ID,
		&session.UserID,
		&session.BankID,
		&session.SessionType,
		&session.Status,
		&session.QuestionCount,
		&session.AnsweredCount,
		&session.CorrectCount,
		&session.WrongCount,
		&session.Score,
		&session.StartedAt,
		&session.CompletedAt,
	)
	return session, err
}
