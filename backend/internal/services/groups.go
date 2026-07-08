package services

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"openwook/internal/api"
	"openwook/internal/auth"
)

const questionGroupColumns = `
	id,
	business_type,
	subject_id,
	group_type_id,
	parent_group_id,
	hierarchy_level,
	hierarchy_path,
	chapter_ref,
	chapter_title,
	chapter_order,
	title,
	instructions,
	source_ref,
	content_mode,
	detail_payload,
	imported_by,
	created_at,
	updated_at,
	source_job_id
`

type QuestionGroup struct {
	ID             int64     `json:"id"`
	BusinessType   string    `json:"business_type"`
	SubjectID      string    `json:"subject_id"`
	GroupTypeID    string    `json:"group_type_id"`
	ParentGroupID  *int64    `json:"parent_group_id"`
	HierarchyLevel int       `json:"hierarchy_level"`
	HierarchyPath  *string   `json:"hierarchy_path"`
	ChapterRef     *string   `json:"chapter_ref"`
	ChapterTitle   *string   `json:"chapter_title"`
	ChapterOrder   *int      `json:"chapter_order"`
	Title          *string   `json:"title"`
	Instructions   *string   `json:"instructions"`
	SourceRef      *string   `json:"source_ref"`
	ContentMode    *string   `json:"content_mode"`
	DetailPayload  string    `json:"detail_payload"`
	ImportedBy     *int64    `json:"imported_by"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
	SourceJobID    *int64    `json:"source_job_id"`
}

type GroupDetail struct {
	QuestionGroup
	Questions []Question `json:"questions"`
}

type CreateGroupInput struct {
	Title        string
	Instructions *string
	GroupTypeID  string
	ContentMode  *string
	Status       string
}

type UpdateGroupInput struct {
	Title        *string
	Instructions *string
	ContentMode  *string
}

type GroupQuestionLink struct {
	ID                int64     `json:"id"`
	GroupID           int64     `json:"group_id"`
	QuestionID        int64     `json:"question_id"`
	GroupSubjectID    string    `json:"group_subject_id"`
	QuestionSubjectID string    `json:"question_subject_id"`
	SortOrder         int       `json:"sort_order"`
	QuestionNo        *string   `json:"question_no"`
	CreatedAt         time.Time `json:"created_at"`
	UpdatedAt         time.Time `json:"updated_at"`
}

type ReorderGroupQuestionItem struct {
	QuestionID int64
	SortOrder  int
}

func CreateGroup(ctx context.Context, db *pgxpool.Pool, user *auth.User, bankID int64, input CreateGroupInput) (*QuestionGroup, error) {
	bank, err := RequireBankOwner(ctx, db, user, bankID)
	if err != nil {
		return nil, err
	}
	groupTypeID, err := ResolveQuestionTypeIDForSubject(ctx, db, bank.Subject, input.GroupTypeID, nil, "group")
	if err != nil {
		return nil, err
	}
	status, err := normalizeQuestionStatusOrDefault(input.Status, "draft")
	if err != nil {
		return nil, err
	}
	group, err := withTx(ctx, db, func(tx pgx.Tx) (*QuestionGroup, error) {
		if _, err := tx.Exec(ctx, `SELECT id FROM question_banks WHERE id = $1 FOR UPDATE`, bankID); err != nil {
			return nil, err
		}
		var nextSort int
		if err := tx.QueryRow(ctx, `
			SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort
			FROM bank_group_links
			WHERE bank_id = $1
		`, bankID).Scan(&nextSort); err != nil {
			return nil, err
		}
		contentMode := input.ContentMode
		if contentMode == nil {
			defaultMode := "text_only"
			contentMode = &defaultMode
		}
		row := tx.QueryRow(ctx, `
			INSERT INTO question_groups (
				subject_id,
				group_type_id,
				title,
				instructions,
				content_mode,
				imported_by
			)
			VALUES ($1, $2, $3, $4, $5, $6)
			RETURNING `+questionGroupColumns+`
		`, bank.Subject, groupTypeID, strings.TrimSpace(input.Title), input.Instructions, contentMode, user.ID)
		created, err := scanQuestionGroup(row)
		if err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO bank_group_links (bank_id, group_id, sort_order, status, added_by)
			VALUES ($1, $2, $3, $4, $5)
		`, bankID, created.ID, nextSort, status, user.ID); err != nil {
			return nil, err
		}
		return &created, nil
	})
	if err != nil {
		return nil, err
	}
	return group, nil
}

func GetGroup(ctx context.Context, db *pgxpool.Pool, user *auth.User, groupID int64) (*GroupDetail, error) {
	var group QuestionGroup
	var questionsRaw []byte
	err := db.QueryRow(ctx, `
		SELECT
			`+questionGroupColumns+`,
			COALESCE(
				(
					SELECT json_agg(q.* ORDER BY gql.sort_order)
					FROM group_question_links gql
					JOIN questions q ON q.id = gql.question_id
					WHERE gql.group_id = g.id
				),
				'[]'::json
			) AS questions
		FROM question_groups g
		WHERE g.id = $1
		  AND EXISTS (
			SELECT 1
			FROM bank_group_links bgl
			JOIN question_banks b ON b.id = bgl.bank_id
			LEFT JOIN user_bank_links ubl ON ubl.bank_id = b.id AND ubl.user_id = $2
			WHERE bgl.group_id = g.id
			  AND (b.is_public = true OR ubl.id IS NOT NULL)
		  )
		LIMIT 1
	`, groupID, user.ID).Scan(
		&group.ID,
		&group.BusinessType,
		&group.SubjectID,
		&group.GroupTypeID,
		&group.ParentGroupID,
		&group.HierarchyLevel,
		&group.HierarchyPath,
		&group.ChapterRef,
		&group.ChapterTitle,
		&group.ChapterOrder,
		&group.Title,
		&group.Instructions,
		&group.SourceRef,
		&group.ContentMode,
		&group.DetailPayload,
		&group.ImportedBy,
		&group.CreatedAt,
		&group.UpdatedAt,
		&group.SourceJobID,
		&questionsRaw,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, api.NewError(404, "NOT_FOUND", "Group not found", nil)
		}
		return nil, err
	}
	detail := &GroupDetail{QuestionGroup: group}
	if err := json.Unmarshal(questionsRaw, &detail.Questions); err != nil {
		return nil, fmt.Errorf("decode group questions: %w", err)
	}
	return detail, nil
}

func UpdateGroup(ctx context.Context, db *pgxpool.Pool, user *auth.User, groupID int64, input UpdateGroupInput) (*QuestionGroup, error) {
	if err := EnsureGroupEditable(ctx, db, user, groupID); err != nil {
		return nil, err
	}
	row := db.QueryRow(ctx, `
		UPDATE question_groups
		SET
			title = COALESCE($2, title),
			instructions = COALESCE($3, instructions),
			content_mode = COALESCE($4, content_mode)
		WHERE id = $1
		RETURNING `+questionGroupColumns+`
	`, groupID, input.Title, input.Instructions, input.ContentMode)
	group, err := scanQuestionGroup(row)
	if err != nil {
		return nil, err
	}
	return &group, nil
}

func AddQuestionToGroup(ctx context.Context, db *pgxpool.Pool, user *auth.User, groupID int64, questionID int64, sortOrder *int) (*GroupQuestionLink, error) {
	if err := EnsureGroupEditable(ctx, db, user, groupID); err != nil {
		return nil, err
	}
	if err := EnsureQuestionEditable(ctx, db, user, questionID); err != nil {
		return nil, err
	}
	resolvedSort := 0
	if sortOrder != nil {
		resolvedSort = *sortOrder
	} else if err := db.QueryRow(ctx, `
		SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort
		FROM group_question_links
		WHERE group_id = $1
	`, groupID).Scan(&resolvedSort); err != nil {
		return nil, err
	}
	row := db.QueryRow(ctx, `
		INSERT INTO group_question_links (group_id, question_id, sort_order)
		VALUES ($1, $2, $3)
		RETURNING id, group_id, question_id, group_subject_id, question_subject_id, sort_order, question_no, created_at, updated_at
	`, groupID, questionID, resolvedSort)
	link, err := scanGroupQuestionLink(row)
	if err != nil {
		return nil, err
	}
	return &link, nil
}

func ReorderGroupQuestions(ctx context.Context, db *pgxpool.Pool, user *auth.User, groupID int64, items []ReorderGroupQuestionItem) error {
	if err := EnsureGroupEditable(ctx, db, user, groupID); err != nil {
		return err
	}
	_, err := withTx(ctx, db, func(tx pgx.Tx) (struct{}, error) {
		var offset int
		if err := tx.QueryRow(ctx, `
			SELECT COALESCE(MAX(sort_order), 0) + 1000 AS offset_value
			FROM group_question_links
			WHERE group_id = $1
		`, groupID).Scan(&offset); err != nil {
			return struct{}{}, err
		}
		if _, err := tx.Exec(ctx, `UPDATE group_question_links SET sort_order = sort_order + $2 WHERE group_id = $1`, groupID, offset); err != nil {
			return struct{}{}, err
		}
		for _, item := range items {
			if _, err := tx.Exec(ctx, `
				UPDATE group_question_links
				SET sort_order = $3
				WHERE group_id = $1 AND question_id = $2
			`, groupID, item.QuestionID, item.SortOrder); err != nil {
				return struct{}{}, err
			}
		}
		return struct{}{}, nil
	})
	return err
}

func RemoveQuestionFromGroup(ctx context.Context, db *pgxpool.Pool, user *auth.User, groupID int64, questionID int64) error {
	if err := EnsureGroupEditable(ctx, db, user, groupID); err != nil {
		return err
	}
	_, err := db.Exec(ctx, `
		DELETE FROM group_question_links
		WHERE group_id = $1 AND question_id = $2
	`, groupID, questionID)
	return err
}

func EnsureGroupEditable(ctx context.Context, db *pgxpool.Pool, user *auth.User, groupID int64) error {
	var id int64
	err := db.QueryRow(ctx, `
		SELECT g.id
		FROM question_groups g
		JOIN bank_group_links bgl ON bgl.group_id = g.id
		JOIN user_bank_links ubl ON ubl.bank_id = bgl.bank_id
		WHERE g.id = $1
		  AND ubl.user_id = $2
		  AND ubl.is_owner = true
		LIMIT 1
	`, groupID, user.ID).Scan(&id)
	if err == nil {
		return nil
	}
	if err == pgx.ErrNoRows {
		return api.NewError(403, "FORBIDDEN", "Group editor access required", nil)
	}
	return err
}

func scanQuestionGroup(row rowScanner) (QuestionGroup, error) {
	var group QuestionGroup
	err := row.Scan(
		&group.ID,
		&group.BusinessType,
		&group.SubjectID,
		&group.GroupTypeID,
		&group.ParentGroupID,
		&group.HierarchyLevel,
		&group.HierarchyPath,
		&group.ChapterRef,
		&group.ChapterTitle,
		&group.ChapterOrder,
		&group.Title,
		&group.Instructions,
		&group.SourceRef,
		&group.ContentMode,
		&group.DetailPayload,
		&group.ImportedBy,
		&group.CreatedAt,
		&group.UpdatedAt,
		&group.SourceJobID,
	)
	return group, err
}

func scanGroupQuestionLink(row rowScanner) (GroupQuestionLink, error) {
	var link GroupQuestionLink
	err := row.Scan(&link.ID, &link.GroupID, &link.QuestionID, &link.GroupSubjectID, &link.QuestionSubjectID, &link.SortOrder, &link.QuestionNo, &link.CreatedAt, &link.UpdatedAt)
	return link, err
}
