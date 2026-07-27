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

const bankColumns = `
	id,
	name,
	description,
	subject,
	total_count,
	created_by,
	is_public,
	created_at,
	updated_at
`

const bankSelectColumns = `
	b.id,
	b.name,
	b.description,
	b.subject,
	b.total_count,
	b.created_by,
	b.is_public,
	b.created_at,
	b.updated_at
`

type QuestionBank struct {
	ID          int64     `json:"id"`
	Name        string    `json:"name"`
	Description *string   `json:"description"`
	Subject     string    `json:"subject"`
	TotalCount  int       `json:"total_count"`
	CreatedBy   int64     `json:"created_by"`
	IsPublic    bool      `json:"is_public"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
	IsOwner     bool      `json:"is_owner,omitempty"`
	IsFavorite  bool      `json:"is_favorite,omitempty"`
}

type BankOwner struct {
	ID      int64  `json:"id"`
	Subject string `json:"subject"`
}

type ListBanksParams struct {
	Scope   string
	Subject string
	Query   string
	Limit   int
	Cursor  string
}

type CreateBankInput struct {
	Name        string
	Description *string
	Subject     string
	IsPublic    bool
}

type UpdateBankInput struct {
	Name           *string
	Description    *string
	DescriptionSet bool
	IsPublic       *bool
}

type ListBankItemsParams struct {
	Status         string
	Type           string
	Limit          int
	IncludeAnswers bool
	Cursor         string
}

type ReorderBankItem struct {
	QuestionID *int64
	GroupID    *int64
	SortOrder  int
}

func withTx[T any](ctx context.Context, db *pgxpool.Pool, fn func(pgx.Tx) (T, error)) (T, error) {
	var zero T
	tx, err := db.Begin(ctx)
	if err != nil {
		return zero, err
	}
	defer tx.Rollback(ctx)

	value, err := fn(tx)
	if err != nil {
		return zero, err
	}
	if err := tx.Commit(ctx); err != nil {
		return zero, err
	}
	return value, nil
}

func ListBanks(ctx context.Context, db queryer, user *auth.User, params ListBanksParams) (Page[QuestionBank], error) {
	scope, err := normalizeBankScope(params.Scope)
	if err != nil {
		return Page[QuestionBank]{}, err
	}
	subject := trimmedOrNil(params.Subject)
	query := nullableILike(params.Query)
	limit := clampPositive(params.Limit, 30, 100)
	offset, err := parsePageCursor(params.Cursor)
	if err != nil {
		return Page[QuestionBank]{}, err
	}

	rows, err := db.Query(ctx, `
		SELECT
			`+bankSelectColumns+`,
			COALESCE(ubl.is_owner, false) AS is_owner,
			COALESCE(ubl.is_favorite, false) AS is_favorite
		FROM question_banks b
		LEFT JOIN user_bank_links ubl
			ON ubl.bank_id = b.id
		   AND ubl.user_id = $1
		WHERE
			(
				$2 = 'public' AND b.is_public = true
				OR $2 = 'favorites' AND ubl.is_favorite = true
				OR $2 = 'mine' AND COALESCE(ubl.is_owner, false) = true
				OR $2 = 'all' AND (b.is_public = true OR ubl.id IS NOT NULL)
			)
			AND ($3::text IS NULL OR b.subject = $3)
			AND ($4::text IS NULL OR b.name ILIKE $4)
		ORDER BY b.updated_at DESC, b.id DESC
		LIMIT $5 OFFSET $6
	`, user.ID, scope, subject, query, limit+1, offset)
	if err != nil {
		return Page[QuestionBank]{}, err
	}
	defer rows.Close()

	items := []QuestionBank{}
	for rows.Next() {
		item, err := scanQuestionBankWithFlags(rows)
		if err != nil {
			return Page[QuestionBank]{}, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return Page[QuestionBank]{}, err
	}
	return buildPage(items, limit, offset), nil
}

func GetBank(ctx context.Context, db *pgxpool.Pool, user *auth.User, bankID int64) (*QuestionBank, error) {
	row := db.QueryRow(ctx, `
		SELECT
			`+bankSelectColumns+`,
			COALESCE(ubl.is_owner, false) AS is_owner,
			COALESCE(ubl.is_favorite, false) AS is_favorite
		FROM question_banks b
		LEFT JOIN user_bank_links ubl
			ON ubl.bank_id = b.id
		   AND ubl.user_id = $2
		WHERE b.id = $1
		  AND (b.is_public = true OR ubl.id IS NOT NULL)
		LIMIT 1
	`, bankID, user.ID)

	bank, err := scanQuestionBankWithFlags(row)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, api.NewError(404, "NOT_FOUND", "Question bank not found", nil)
		}
		return nil, err
	}
	return &bank, nil
}

func RequireBankOwner(ctx context.Context, db *pgxpool.Pool, user *auth.User, bankID int64) (*BankOwner, error) {
	row := db.QueryRow(ctx, `
		SELECT b.id, b.subject
		FROM question_banks b
		JOIN user_bank_links ubl ON ubl.bank_id = b.id
		WHERE b.id = $1
		  AND ubl.user_id = $2
		  AND ubl.is_owner = true
		LIMIT 1
	`, bankID, user.ID)

	var owner BankOwner
	if err := row.Scan(&owner.ID, &owner.Subject); err != nil {
		if err == pgx.ErrNoRows {
			return nil, api.NewError(403, "FORBIDDEN", "Bank owner access required", nil)
		}
		return nil, err
	}
	return &owner, nil
}

func CreateBank(ctx context.Context, db *pgxpool.Pool, user *auth.User, input CreateBankInput) (*QuestionBank, error) {
	bank, err := withTx(ctx, db, func(tx pgx.Tx) (*QuestionBank, error) {
		row := tx.QueryRow(ctx, `
			INSERT INTO question_banks (name, description, subject, created_by, is_public)
			VALUES ($1, $2, $3, $4, $5)
			RETURNING `+bankColumns+`
		`, strings.TrimSpace(input.Name), input.Description, strings.TrimSpace(input.Subject), user.ID, input.IsPublic)
		created, err := scanQuestionBank(row)
		if err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO user_bank_links (user_id, bank_id, is_owner)
			VALUES ($1, $2, true)
		`, user.ID, created.ID); err != nil {
			return nil, err
		}
		return &created, nil
	})
	if err != nil {
		return nil, err
	}
	return bank, nil
}

func UpdateBank(ctx context.Context, db *pgxpool.Pool, user *auth.User, bankID int64, input UpdateBankInput) (*QuestionBank, error) {
	if input.Name == nil && !input.DescriptionSet && input.IsPublic == nil {
		return nil, api.ValidationError([]api.ValidationDetail{{Field: "body", Message: "must include a field to update"}})
	}
	if _, err := RequireBankOwner(ctx, db, user, bankID); err != nil {
		return nil, err
	}
	row := db.QueryRow(ctx, `
		UPDATE question_banks
		SET
			name = COALESCE($2, name),
			description = CASE WHEN $4 THEN $3 ELSE description END,
			is_public = COALESCE($5, is_public)
		WHERE id = $1
		RETURNING `+bankColumns+`
	`, bankID, input.Name, input.Description, input.DescriptionSet, input.IsPublic)

	bank, err := scanQuestionBank(row)
	if err != nil {
		return nil, err
	}
	return &bank, nil
}

func DeleteBank(ctx context.Context, db *pgxpool.Pool, user *auth.User, bankID int64) error {
	if _, err := RequireBankOwner(ctx, db, user, bankID); err != nil {
		return err
	}
	_, err := db.Exec(ctx, `DELETE FROM question_banks WHERE id = $1`, bankID)
	return err
}

func SetFavorite(ctx context.Context, db *pgxpool.Pool, user *auth.User, bankID int64, favorite bool) error {
	if _, err := GetBank(ctx, db, user, bankID); err != nil {
		return err
	}
	if favorite {
		_, err := db.Exec(ctx, `
			INSERT INTO user_bank_links (user_id, bank_id, is_favorite)
			VALUES ($1, $2, true)
			ON CONFLICT (user_id, bank_id)
			DO UPDATE SET is_favorite = true
		`, user.ID, bankID)
		return err
	}
	if _, err := db.Exec(ctx, `
		DELETE FROM user_bank_links
		WHERE user_id = $1
		  AND bank_id = $2
		  AND is_owner = false
	`, user.ID, bankID); err != nil {
		return err
	}
	_, err := db.Exec(ctx, `
		UPDATE user_bank_links
		SET is_favorite = false
		WHERE user_id = $1
		  AND bank_id = $2
		  AND is_owner = true
	`, user.ID, bankID)
	return err
}

func ListBankItems(ctx context.Context, db *pgxpool.Pool, user *auth.User, bankID int64, params ListBankItemsParams) (Page[BankQuestionItem], error) {
	bank, err := GetBank(ctx, db, user, bankID)
	if err != nil {
		return Page[BankQuestionItem]{}, err
	}
	return listBankItemsForBank(ctx, db, bankID, params, bank.IsOwner, bank.IsOwner && params.IncludeAnswers)
}

func ReorderBankItems(ctx context.Context, db *pgxpool.Pool, user *auth.User, bankID int64, items []ReorderBankItem) error {
	if _, err := RequireBankOwner(ctx, db, user, bankID); err != nil {
		return err
	}
	_, err := withTx(ctx, db, func(tx pgx.Tx) (struct{}, error) {
		var total int
		if err := tx.QueryRow(ctx, `
			SELECT
				(SELECT COUNT(*) FROM bank_question_links WHERE bank_id = $1)
				+ (SELECT COUNT(*) FROM bank_group_links WHERE bank_id = $1)
		`, bankID).Scan(&total); err != nil {
			return struct{}{}, err
		}
		if total != len(items) {
			return struct{}{}, api.ValidationError([]api.ValidationDetail{{Field: "items", Message: "must include every bank item exactly once"}})
		}
		var offset int
		if err := tx.QueryRow(ctx, `
			SELECT COALESCE(MAX(sort_order), 0) + 1000 AS offset_value
			FROM (
				SELECT sort_order FROM bank_question_links WHERE bank_id = $1
				UNION ALL
				SELECT sort_order FROM bank_group_links WHERE bank_id = $1
			) s
		`, bankID).Scan(&offset); err != nil {
			return struct{}{}, err
		}
		if _, err := tx.Exec(ctx, `UPDATE bank_question_links SET sort_order = sort_order + $2 WHERE bank_id = $1`, bankID, offset); err != nil {
			return struct{}{}, err
		}
		if _, err := tx.Exec(ctx, `UPDATE bank_group_links SET sort_order = sort_order + $2 WHERE bank_id = $1`, bankID, offset); err != nil {
			return struct{}{}, err
		}
		for _, item := range items {
			if item.QuestionID != nil {
				result, err := tx.Exec(ctx, `
					UPDATE bank_question_links
					SET sort_order = $3
					WHERE bank_id = $1 AND question_id = $2
				`, bankID, *item.QuestionID, item.SortOrder)
				if err != nil {
					return struct{}{}, err
				}
				if result.RowsAffected() != 1 {
					return struct{}{}, api.ValidationError([]api.ValidationDetail{{Field: "items", Message: "contains an unknown question"}})
				}
			}
			if item.GroupID != nil {
				result, err := tx.Exec(ctx, `
					UPDATE bank_group_links
					SET sort_order = $3
					WHERE bank_id = $1 AND group_id = $2
				`, bankID, *item.GroupID, item.SortOrder)
				if err != nil {
					return struct{}{}, err
				}
				if result.RowsAffected() != 1 {
					return struct{}{}, api.ValidationError([]api.ValidationDetail{{Field: "items", Message: "contains an unknown group"}})
				}
			}
		}
		return struct{}{}, nil
	})
	return err
}

func listBankItemsForBank(ctx context.Context, db *pgxpool.Pool, bankID int64, params ListBankItemsParams, canEdit, includeAnswers bool) (Page[BankQuestionItem], error) {
	statusValue := strings.TrimSpace(params.Status)
	if statusValue != "" && statusValue != "draft" && statusValue != "active" && statusValue != "archived" {
		return Page[BankQuestionItem]{}, api.ValidationError([]api.ValidationDetail{{Field: "status", Message: "must be one of draft, active, archived"}})
	}
	status := trimmedOrNil(statusValue)
	questionTypeID := trimmedOrNil(params.Type)
	limit := clampPositive(params.Limit, 50, 100)
	offset, err := parsePageCursor(params.Cursor)
	if err != nil {
		return Page[BankQuestionItem]{}, err
	}

	rows, err := db.Query(ctx, `
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
			CASE WHEN $5 THEN item.analysis ELSE NULL END,
			item.question_status,
			item.group_title,
			item.group_instructions,
			COALESCE(
				(
					SELECT jsonb_agg(
						jsonb_strip_nulls(jsonb_build_object(
							'id', qo.id,
							'question_id', qo.question_id,
							'option_label', qo.option_label,
							'sort_order', qo.sort_order,
							'content', qo.content,
							'is_correct', CASE WHEN $6 THEN qo.is_correct ELSE NULL END,
							'created_at', qo.created_at,
							'updated_at', qo.updated_at
						))
						ORDER BY qo.sort_order
					)
					FROM question_options qo
					WHERE qo.question_id = item.question_id
				),
				'[]'::json
			) AS options
		FROM v_bank_question_items item
		WHERE item.bank_id = $1
		  AND ($2::text IS NULL OR item.bank_link_status = $2)
		  AND ($3::text IS NULL OR item.question_type_id = $3)
		  AND ($5 OR (item.bank_link_status = 'active' AND item.question_status = 'active'))
		ORDER BY item.bank_sort_order, item.group_sort_order NULLS FIRST, item.question_id
		LIMIT $4 OFFSET $7
	`, bankID, status, questionTypeID, limit+1, canEdit, includeAnswers, offset)
	if err != nil {
		return Page[BankQuestionItem]{}, err
	}
	defer rows.Close()

	items := []BankQuestionItem{}
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
			return Page[BankQuestionItem]{}, err
		}
		if err := json.Unmarshal(optionsRaw, &item.Options); err != nil {
			return Page[BankQuestionItem]{}, fmt.Errorf("decode bank item options: %w", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return Page[BankQuestionItem]{}, err
	}
	return buildPage(items, limit, offset), nil
}

func scanQuestionBank(row pgx.Row) (QuestionBank, error) {
	var item QuestionBank
	err := row.Scan(
		&item.ID,
		&item.Name,
		&item.Description,
		&item.Subject,
		&item.TotalCount,
		&item.CreatedBy,
		&item.IsPublic,
		&item.CreatedAt,
		&item.UpdatedAt,
	)
	return item, err
}

func scanQuestionBankWithFlags(row pgx.Row) (QuestionBank, error) {
	var item QuestionBank
	err := row.Scan(
		&item.ID,
		&item.Name,
		&item.Description,
		&item.Subject,
		&item.TotalCount,
		&item.CreatedBy,
		&item.IsPublic,
		&item.CreatedAt,
		&item.UpdatedAt,
		&item.IsOwner,
		&item.IsFavorite,
	)
	return item, err
}

func normalizeBankScope(scope string) (string, error) {
	switch strings.TrimSpace(scope) {
	case "public", "favorites", "all":
		return strings.TrimSpace(scope), nil
	case "mine", "":
		return "mine", nil
	default:
		return "", api.ValidationError([]api.ValidationDetail{{Field: "scope", Message: "must be one of mine, public, favorites, all"}})
	}
}

func trimmedOrNil(value string) any {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return value
}

func nullableILike(value string) any {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return "%" + value + "%"
}

func clampPositive(value, fallback, max int) int {
	if value <= 0 {
		value = fallback
	}
	if value > max {
		return max
	}
	return value
}
