package services

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"
	"practiq/internal/api"
)

type Subject struct {
	SubjectID   string `json:"subject_id"`
	DisplayName string `json:"display_name"`
}

type QuestionType struct {
	TypeID            string  `json:"type_id"`
	SubjectID         string  `json:"subject_id"`
	DisplayName       string  `json:"display_name"`
	Scope             string  `json:"scope"`
	DefaultAnswerMode *string `json:"default_answer_mode"`
}

type KnowledgePoint struct {
	ID           int64  `json:"id"`
	SubjectID    string `json:"subject_id"`
	Code         string `json:"code"`
	DisplayName  string `json:"display_name"`
	ParentID     *int64 `json:"parent_id"`
	MetadataJSON string `json:"metadata_json"`
	CreatedAt    string `json:"created_at"`
	UpdatedAt    string `json:"updated_at"`
}

type queryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func ResolveQuestionTypeIDForSubject(ctx context.Context, db queryer, subject string, requestedTypeID string, answerMode *string, preferredScope string) (string, error) {
	requested := strings.TrimSpace(requestedTypeID)
	if requested != "" {
		rows, err := db.Query(ctx, `
			SELECT type_id
			FROM question_types
			WHERE subject_id = $1
			  AND type_id = $2
			LIMIT 1
		`, subject, requested)
		if err != nil {
			return "", err
		}
		defer rows.Close()
		if rows.Next() {
			var typeID string
			if err := rows.Scan(&typeID); err != nil {
				return "", err
			}
			return typeID, rows.Err()
		}
		if err := rows.Err(); err != nil {
			return "", err
		}
	}

	rows, err := db.Query(ctx, `
		SELECT type_id
		FROM question_types
		WHERE subject_id = $1
		ORDER BY
			CASE WHEN default_answer_mode = $2 THEN 0 ELSE 1 END,
			CASE WHEN default_answer_mode IS NULL THEN 0 ELSE 1 END,
			CASE WHEN scope = $3 THEN 0 WHEN scope = 'hybrid' THEN 1 ELSE 2 END,
			type_id
		LIMIT 1
	`, subject, trimmedStringOrNil(stringValue(answerMode)), strings.TrimSpace(preferredScope))
	if err != nil {
		return "", err
	}
	defer rows.Close()
	if rows.Next() {
		var typeID string
		if err := rows.Scan(&typeID); err != nil {
			return "", err
		}
		return typeID, rows.Err()
	}
	if err := rows.Err(); err != nil {
		return "", err
	}

	return "", api.NewError(422, "INVALID_QUESTION_TYPE", "No compatible question type exists for subject "+subject, nil)
}

func ListSubjects(ctx context.Context, db queryer) ([]Subject, error) {
	rows, err := db.Query(ctx, `
		SELECT subject_id, display_name
		FROM subjects
		ORDER BY display_name
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]Subject, 0)
	for rows.Next() {
		var item Subject
		if err := rows.Scan(&item.SubjectID, &item.DisplayName); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func ListQuestionTypes(ctx context.Context, db queryer, subject string, scope string) ([]QuestionType, error) {
	rows, err := db.Query(ctx, `
		SELECT type_id, subject_id, display_name, scope, default_answer_mode
		FROM question_types
		WHERE ($1::text IS NULL OR subject_id = $1)
		  AND ($2::text IS NULL OR scope = $2)
		ORDER BY subject_id, display_name
	`, trimmedStringOrNil(subject), trimmedStringOrNil(scope))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]QuestionType, 0)
	for rows.Next() {
		var item QuestionType
		if err := rows.Scan(&item.TypeID, &item.SubjectID, &item.DisplayName, &item.Scope, &item.DefaultAnswerMode); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func ListKnowledgePoints(ctx context.Context, db queryer, subject string, parentID *int64, query, cursor string, requestedLimit int) (Page[KnowledgePoint], error) {
	var parent any
	if parentID != nil {
		parent = *parentID
	}
	limit := clampPositive(requestedLimit, 50, 200)
	offset, err := parsePageCursor(cursor)
	if err != nil {
		return Page[KnowledgePoint]{}, err
	}
	rows, err := db.Query(ctx, `
		SELECT id, subject_id, code, display_name, parent_id, metadata_json, created_at, updated_at
		FROM knowledge_points
		WHERE ($1::text IS NULL OR subject_id = $1)
		  AND (($2::bigint IS NULL AND parent_id IS NULL) OR parent_id = $2)
		  AND ($3::text IS NULL OR code ILIKE $3 OR display_name ILIKE $3)
		ORDER BY display_name, id
		LIMIT $4 OFFSET $5
	`, trimmedStringOrNil(subject), parent, ilikeOrNil(query), limit+1, offset)
	if err != nil {
		return Page[KnowledgePoint]{}, err
	}
	defer rows.Close()
	items := make([]KnowledgePoint, 0)
	for rows.Next() {
		var item KnowledgePoint
		if err := rows.Scan(&item.ID, &item.SubjectID, &item.Code, &item.DisplayName, &item.ParentID, &item.MetadataJSON, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return Page[KnowledgePoint]{}, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return Page[KnowledgePoint]{}, err
	}
	return buildPage(items, limit, offset), nil
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
