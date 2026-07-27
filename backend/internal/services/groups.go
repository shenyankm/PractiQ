package services

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

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

type GroupQuestion struct {
	ID             int64   `json:"id"`
	SubjectID      string  `json:"subject_id"`
	QuestionTypeID string  `json:"question_type_id"`
	AnswerMode     string  `json:"answer_mode"`
	ChoiceVariant  *string `json:"choice_variant"`
	Stem           string  `json:"stem"`
	Analysis       *string `json:"analysis,omitempty"`
	Status         string  `json:"status"`
}

type GroupDetail struct {
	QuestionGroup
	Questions []GroupQuestion `json:"questions"`
	CanEdit   bool            `json:"can_edit"`
}

type CreateGroupInput struct {
	Title        string
	Instructions *string
	GroupTypeID  string
	ContentMode  *string
	Status       string
	SourceJobID  *int64
}

type UpdateGroupInput struct {
	Title           *string
	Instructions    *string
	InstructionsSet bool
	ContentMode     *string
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

type BankGroup struct {
	ID            int64   `json:"id"`
	GroupTypeID   string  `json:"group_type_id"`
	Title         *string `json:"title"`
	Instructions  *string `json:"instructions"`
	ContentMode   *string `json:"content_mode"`
	Status        string  `json:"status"`
	SortOrder     int     `json:"sort_order"`
	QuestionCount int     `json:"question_count"`
	CanEdit       bool    `json:"can_edit"`
}

func ListBankGroups(ctx context.Context, db *pgxpool.Pool, user *auth.User, bankID int64, limit int, cursor string) (Page[BankGroup], error) {
	bank, err := GetBank(ctx, db, user, bankID)
	if err != nil {
		return Page[BankGroup]{}, err
	}
	limit = clampPositive(limit, 30, 100)
	offset, err := parsePageCursor(cursor)
	if err != nil {
		return Page[BankGroup]{}, err
	}
	rows, err := db.Query(ctx, `
		SELECT
			g.id,
			g.group_type_id,
			g.title,
			g.instructions,
			g.content_mode,
			bgl.status,
			bgl.sort_order,
			COUNT(gql.question_id)::int
		FROM bank_group_links bgl
		JOIN question_groups g ON g.id = bgl.group_id
		LEFT JOIN group_question_links gql ON gql.group_id = g.id
		WHERE bgl.bank_id = $1
		  AND ($2 OR bgl.status = 'active')
		GROUP BY g.id, bgl.status, bgl.sort_order
		ORDER BY bgl.sort_order, g.id
		LIMIT $3 OFFSET $4
	`, bankID, bank.IsOwner, limit+1, offset)
	if err != nil {
		return Page[BankGroup]{}, err
	}
	defer rows.Close()
	items := []BankGroup{}
	for rows.Next() {
		var item BankGroup
		if err := rows.Scan(&item.ID, &item.GroupTypeID, &item.Title, &item.Instructions, &item.ContentMode, &item.Status, &item.SortOrder, &item.QuestionCount); err != nil {
			return Page[BankGroup]{}, err
		}
		item.CanEdit = bank.IsOwner
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return Page[BankGroup]{}, err
	}
	return buildPage(items, limit, offset), nil
}

func CreateGroup(ctx context.Context, db *pgxpool.Pool, user *auth.User, bankID int64, input CreateGroupInput) (*QuestionGroup, error) {
	title := strings.TrimSpace(input.Title)
	var details []api.ValidationDetail
	if title == "" || utf8.RuneCountInString(title) > 1000 {
		details = append(details, api.ValidationDetail{Field: "title", Message: "must be 1-1000 characters"})
	}
	input.Title = title
	if input.Instructions != nil {
		instructions := strings.TrimSpace(*input.Instructions)
		input.Instructions = &instructions
		if utf8.RuneCountInString(instructions) > 20000 {
			details = append(details, api.ValidationDetail{Field: "instructions", Message: "must be no more than 20000 characters"})
		}
	}
	if err := validateGroupContentMode(input.ContentMode); err != nil {
		details = append(details, *err)
	}
	if len(details) > 0 {
		return nil, api.ValidationError(details)
	}
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
				imported_by,
				source_job_id
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			RETURNING `+questionGroupColumns+`
		`, bank.Subject, groupTypeID, strings.TrimSpace(input.Title), input.Instructions, contentMode, user.ID, input.SourceJobID)
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
	var canEdit bool
	err := db.QueryRow(ctx, `
		WITH access AS (
			SELECT
				COUNT(*) > 0 AS has_access,
				COALESCE(BOOL_OR(COALESCE(ubl.is_owner, false)), false) AS can_edit
			FROM bank_group_links bgl
			JOIN question_banks b ON b.id = bgl.bank_id
			LEFT JOIN user_bank_links ubl ON ubl.bank_id = b.id AND ubl.user_id = $2
			WHERE bgl.group_id = $1
			  AND (b.is_public = true OR ubl.id IS NOT NULL)
			  AND (COALESCE(ubl.is_owner, false) OR bgl.status = 'active')
		)
		SELECT
			`+questionGroupColumns+`,
			access.can_edit,
			COALESCE(
				(
					SELECT jsonb_agg(
						jsonb_strip_nulls(jsonb_build_object(
							'id', q.id,
							'subject_id', q.subject_id,
							'question_type_id', q.question_type_id,
							'answer_mode', q.answer_mode,
							'choice_variant', q.choice_variant,
							'stem', q.stem,
							'analysis', CASE WHEN access.can_edit THEN q.analysis ELSE NULL END,
							'status', q.status
						))
						ORDER BY gql.sort_order
					)
					FROM group_question_links gql
					JOIN questions q ON q.id = gql.question_id
					WHERE gql.group_id = g.id
					  AND (access.can_edit OR q.status = 'active')
				),
				'[]'::json
			) AS questions
		FROM question_groups g
		CROSS JOIN access
		WHERE g.id = $1
		  AND access.has_access
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
		&canEdit,
		&questionsRaw,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, api.NewError(404, "NOT_FOUND", "Group not found", nil)
		}
		return nil, err
	}
	detail := &GroupDetail{QuestionGroup: group, CanEdit: canEdit}
	if err := json.Unmarshal(questionsRaw, &detail.Questions); err != nil {
		return nil, fmt.Errorf("decode group questions: %w", err)
	}
	return detail, nil
}

func UpdateGroup(ctx context.Context, db *pgxpool.Pool, user *auth.User, groupID int64, input UpdateGroupInput) (*QuestionGroup, error) {
	if input.Title == nil && !input.InstructionsSet && input.ContentMode == nil {
		return nil, api.ValidationError([]api.ValidationDetail{{Field: "body", Message: "must include a field to update"}})
	}
	var details []api.ValidationDetail
	if input.Title != nil {
		title := strings.TrimSpace(*input.Title)
		input.Title = &title
		if title == "" || utf8.RuneCountInString(title) > 1000 {
			details = append(details, api.ValidationDetail{Field: "title", Message: "must be 1-1000 characters"})
		}
	}
	if input.InstructionsSet && input.Instructions != nil {
		instructions := strings.TrimSpace(*input.Instructions)
		input.Instructions = &instructions
		if utf8.RuneCountInString(instructions) > 20000 {
			details = append(details, api.ValidationDetail{Field: "instructions", Message: "must be no more than 20000 characters"})
		}
	}
	if err := validateGroupContentMode(input.ContentMode); err != nil {
		details = append(details, *err)
	}
	if len(details) > 0 {
		return nil, api.ValidationError(details)
	}
	if err := EnsureGroupEditable(ctx, db, user, groupID); err != nil {
		return nil, err
	}
	row := db.QueryRow(ctx, `
		UPDATE question_groups
		SET
			title = COALESCE($2, title),
			instructions = CASE WHEN $4 THEN $3 ELSE instructions END,
			content_mode = COALESCE($5, content_mode)
		WHERE id = $1
		RETURNING `+questionGroupColumns+`
	`, groupID, input.Title, input.Instructions, input.InstructionsSet, input.ContentMode)
	group, err := scanQuestionGroup(row)
	if err != nil {
		return nil, err
	}
	return &group, nil
}

func SetGroupStatus(ctx context.Context, db *pgxpool.Pool, user *auth.User, groupID int64, status string) (*GroupDetail, error) {
	normalized, err := normalizeQuestionStatusOrDefault(status, "")
	if err != nil {
		return nil, err
	}
	if err := EnsureGroupEditable(ctx, db, user, groupID); err != nil {
		return nil, err
	}
	if normalized == "active" {
		var total, active int
		if err := db.QueryRow(ctx, `
			SELECT COUNT(*)::int, COUNT(*) FILTER (WHERE q.status = 'active')::int
			FROM group_question_links gql
			JOIN questions q ON q.id = gql.question_id
			WHERE gql.group_id = $1
		`, groupID).Scan(&total, &active); err != nil {
			return nil, err
		}
		if total == 0 || active != total {
			return nil, api.NewError(409, "GROUP_NOT_PUBLISHABLE", "Publish every question before publishing the group", nil)
		}
	}
	result, err := db.Exec(ctx, `
		UPDATE bank_group_links bgl
		SET status = $3
		FROM user_bank_links ubl
		WHERE bgl.group_id = $1
		  AND ubl.bank_id = bgl.bank_id
		  AND ubl.user_id = $2
		  AND ubl.is_owner = true
	`, groupID, user.ID, normalized)
	if err != nil {
		return nil, err
	}
	if result.RowsAffected() == 0 {
		return nil, api.NewError(404, "NOT_FOUND", "Group not found", nil)
	}
	return GetGroup(ctx, db, user, groupID)
}

func DeleteGroup(ctx context.Context, db *pgxpool.Pool, user *auth.User, groupID int64) error {
	if err := EnsureGroupEditable(ctx, db, user, groupID); err != nil {
		return err
	}
	_, err := withTx(ctx, db, func(tx pgx.Tx) (struct{}, error) {
		if _, err := tx.Exec(ctx, `
			WITH owner_banks AS (
				SELECT bgl.bank_id
				FROM bank_group_links bgl
				JOIN user_bank_links ubl ON ubl.bank_id = bgl.bank_id
				WHERE bgl.group_id = $1
				  AND ubl.user_id = $2
				  AND ubl.is_owner = true
			),
			missing AS (
				SELECT
					ob.bank_id,
					gql.question_id,
					q.status,
					ROW_NUMBER() OVER (PARTITION BY ob.bank_id ORDER BY gql.sort_order, gql.question_id)::int AS row_no
				FROM owner_banks ob
				JOIN group_question_links gql ON gql.group_id = $1
				JOIN questions q ON q.id = gql.question_id
				WHERE NOT EXISTS (
					SELECT 1 FROM bank_question_links direct
					WHERE direct.bank_id = ob.bank_id AND direct.question_id = gql.question_id
				)
				  AND NOT EXISTS (
					SELECT 1
					FROM bank_group_links other_bank_group
					JOIN group_question_links other_group_question ON other_group_question.group_id = other_bank_group.group_id
					WHERE other_bank_group.bank_id = ob.bank_id
					  AND other_bank_group.group_id <> $1
					  AND other_group_question.question_id = gql.question_id
				)
			),
			bases AS (
				SELECT ob.bank_id, COALESCE(MAX(bql.sort_order), 0) AS base_sort
				FROM owner_banks ob
				LEFT JOIN bank_question_links bql ON bql.bank_id = ob.bank_id
				GROUP BY ob.bank_id
			)
			INSERT INTO bank_question_links (bank_id, question_id, sort_order, status, added_by)
			SELECT missing.bank_id, missing.question_id, bases.base_sort + missing.row_no, missing.status, $2
			FROM missing
			JOIN bases ON bases.bank_id = missing.bank_id
			ON CONFLICT (bank_id, question_id) DO NOTHING
		`, groupID, user.ID); err != nil {
			return struct{}{}, err
		}
		if _, err := tx.Exec(ctx, `
			DELETE FROM bank_group_links bgl
			USING user_bank_links ubl
			WHERE bgl.group_id = $1
			  AND ubl.bank_id = bgl.bank_id
			  AND ubl.user_id = $2
			  AND ubl.is_owner = true
		`, groupID, user.ID); err != nil {
			return struct{}{}, err
		}
		if _, err := tx.Exec(ctx, `
			DELETE FROM question_groups g
			WHERE g.id = $1
			  AND NOT EXISTS (SELECT 1 FROM bank_group_links bgl WHERE bgl.group_id = g.id)
		`, groupID); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, nil
	})
	return err
}

func AddQuestionToGroup(ctx context.Context, db *pgxpool.Pool, user *auth.User, groupID int64, questionID int64, sortOrder *int) (*GroupQuestionLink, error) {
	if sortOrder != nil && *sortOrder <= 0 {
		return nil, api.ValidationError([]api.ValidationDetail{{Field: "sortOrder", Message: "must be positive"}})
	}
	if err := EnsureGroupEditable(ctx, db, user, groupID); err != nil {
		return nil, err
	}
	if err := EnsureQuestionEditable(ctx, db, user, questionID); err != nil {
		return nil, err
	}
	return withTx(ctx, db, func(tx pgx.Tx) (*GroupQuestionLink, error) {
		type bankPresence struct {
			id  int64
			had bool
		}
		rows, err := tx.Query(ctx, `
			SELECT
				bgl.bank_id,
				EXISTS (
					SELECT 1
					FROM v_bank_question_items item
					WHERE item.bank_id = bgl.bank_id AND item.question_id = $2
				)
			FROM bank_group_links bgl
			JOIN user_bank_links ubl ON ubl.bank_id = bgl.bank_id
			WHERE bgl.group_id = $1
			  AND ubl.user_id = $3
			  AND ubl.is_owner = true
			FOR UPDATE OF bgl
		`, groupID, questionID, user.ID)
		if err != nil {
			return nil, err
		}
		banks := []bankPresence{}
		for rows.Next() {
			var item bankPresence
			if err := rows.Scan(&item.id, &item.had); err != nil {
				rows.Close()
				return nil, err
			}
			banks = append(banks, item)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		resolvedSort := 0
		if sortOrder != nil {
			resolvedSort = *sortOrder
		} else if err := tx.QueryRow(ctx, `
			SELECT COALESCE(MAX(sort_order), 0) + 1
			FROM group_question_links
			WHERE group_id = $1
		`, groupID).Scan(&resolvedSort); err != nil {
			return nil, err
		}
		row := tx.QueryRow(ctx, `
			INSERT INTO group_question_links (group_id, question_id, sort_order)
			VALUES ($1, $2, $3)
			RETURNING id, group_id, question_id, group_subject_id, question_subject_id, sort_order, question_no, created_at, updated_at
		`, groupID, questionID, resolvedSort)
		link, err := scanGroupQuestionLink(row)
		if err != nil {
			return nil, err
		}
		for _, bank := range banks {
			if _, err := tx.Exec(ctx, `DELETE FROM bank_question_links WHERE bank_id = $1 AND question_id = $2`, bank.id, questionID); err != nil {
				return nil, err
			}
			if !bank.had {
				if _, err := tx.Exec(ctx, `UPDATE question_banks SET total_count = total_count + 1 WHERE id = $1`, bank.id); err != nil {
					return nil, err
				}
			}
		}
		return &link, nil
	})
}

func ReorderGroupQuestions(ctx context.Context, db *pgxpool.Pool, user *auth.User, groupID int64, items []ReorderGroupQuestionItem) error {
	if err := EnsureGroupEditable(ctx, db, user, groupID); err != nil {
		return err
	}
	_, err := withTx(ctx, db, func(tx pgx.Tx) (struct{}, error) {
		var total int
		if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM group_question_links WHERE group_id = $1`, groupID).Scan(&total); err != nil {
			return struct{}{}, err
		}
		if total != len(items) {
			return struct{}{}, api.ValidationError([]api.ValidationDetail{{Field: "items", Message: "must include every group question exactly once"}})
		}
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
			result, err := tx.Exec(ctx, `
				UPDATE group_question_links
				SET sort_order = $3
				WHERE group_id = $1 AND question_id = $2
			`, groupID, item.QuestionID, item.SortOrder)
			if err != nil {
				return struct{}{}, err
			}
			if result.RowsAffected() != 1 {
				return struct{}{}, api.ValidationError([]api.ValidationDetail{{Field: "items", Message: "contains an unknown question"}})
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
	_, err := withTx(ctx, db, func(tx pgx.Tx) (struct{}, error) {
		result, err := tx.Exec(ctx, `
			DELETE FROM group_question_links
			WHERE group_id = $1 AND question_id = $2
		`, groupID, questionID)
		if err != nil {
			return struct{}{}, err
		}
		if result.RowsAffected() == 0 {
			return struct{}{}, api.NewError(404, "NOT_FOUND", "Group question link not found", nil)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO bank_question_links (bank_id, question_id, sort_order, status, added_by)
			SELECT
				bgl.bank_id,
				q.id,
				(SELECT COALESCE(MAX(existing.sort_order), 0) + 1 FROM bank_question_links existing WHERE existing.bank_id = bgl.bank_id),
				q.status,
				$3
			FROM bank_group_links bgl
			JOIN user_bank_links ubl ON ubl.bank_id = bgl.bank_id
			JOIN questions q ON q.id = $2
			WHERE bgl.group_id = $1
			  AND ubl.user_id = $3
			  AND ubl.is_owner = true
			  AND NOT EXISTS (
				SELECT 1
				FROM v_bank_question_items item
				WHERE item.bank_id = bgl.bank_id AND item.question_id = $2
			  )
			ON CONFLICT (bank_id, question_id) DO NOTHING
		`, groupID, questionID, user.ID); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, nil
	})
	return err
}

func validateGroupContentMode(value *string) *api.ValidationDetail {
	if value == nil {
		return nil
	}
	mode := strings.TrimSpace(*value)
	*value = mode
	switch mode {
	case "text_only", "mixed_media", "structured_rich":
		return nil
	default:
		return &api.ValidationDetail{Field: "contentMode", Message: "must be one of text_only, mixed_media, structured_rich"}
	}
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

func scanQuestionGroup(row pgx.Row) (QuestionGroup, error) {
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

func scanGroupQuestionLink(row pgx.Row) (GroupQuestionLink, error) {
	var link GroupQuestionLink
	err := row.Scan(&link.ID, &link.GroupID, &link.QuestionID, &link.GroupSubjectID, &link.QuestionSubjectID, &link.SortOrder, &link.QuestionNo, &link.CreatedAt, &link.UpdatedAt)
	return link, err
}
