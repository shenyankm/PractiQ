package services

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"openwook/internal/api"
	"openwook/internal/auth"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
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

type rowScanner interface {
	Scan(...any) error
}

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
}

type CreateBankInput struct {
	Name        string
	Description *string
	Subject     string
	IsPublic    bool
}

type UpdateBankInput struct {
	Name        *string
	Description *string
	IsPublic    *bool
}

type ListBankItemsParams struct {
	Status string
	Type   string
	Limit  int
}


type BankWithItems struct {
	Bank  *QuestionBank      `json:"bank"`
	Items []BankQuestionItem `json:"items"`
}

type BankPracticeSummary struct {
	Bank        *QuestionBank   `json:"bank"`
	ActiveCount int             `json:"activeCount"`
	WrongCount  int             `json:"wrongCount"`
	TypeCounts  map[string]int  `json:"typeCounts"`
	ModeCounts  map[string]int  `json:"modeCounts"`
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

func ListBanks(ctx context.Context, db *pgxpool.Pool, user *auth.User, params ListBanksParams) ([]QuestionBank, error) {
	scope := normalizeBankScope(params.Scope)
	subject := trimmedOrNil(params.Subject)
	query := nullableILike(params.Query)
	limit := clampPositive(params.Limit, 30, 100)

	rows, err := db.Query(ctx, `
		SELECT
			`+bankColumns+`,
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
		LIMIT $5
	`, user.ID, scope, subject, query, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := []QuestionBank{}
	for rows.Next() {
		item, err := scanQuestionBankWithFlags(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func GetBank(ctx context.Context, db *pgxpool.Pool, user *auth.User, bankID int64) (*QuestionBank, error) {
	row := db.QueryRow(ctx, `
		SELECT
			`+bankColumns+`,
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
	if _, err := RequireBankOwner(ctx, db, user, bankID); err != nil {
		return nil, err
	}
	row := db.QueryRow(ctx, `
		UPDATE question_banks
		SET
			name = COALESCE($2, name),
			description = COALESCE($3, description),
			is_public = COALESCE($4, is_public)
		WHERE id = $1
		RETURNING `+bankColumns+`
	`, bankID, input.Name, input.Description, input.IsPublic)

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

func ListBankItems(ctx context.Context, db *pgxpool.Pool, user *auth.User, bankID int64, params ListBankItemsParams) ([]BankQuestionItem, error) {
	if _, err := GetBank(ctx, db, user, bankID); err != nil {
		return nil, err
	}
	return listBankItemsForBank(ctx, db, bankID, params)
}

func GetBankWithItems(ctx context.Context, db *pgxpool.Pool, user *auth.User, bankID int64, params ListBankItemsParams) (*BankWithItems, error) {
	bank, err := GetBank(ctx, db, user, bankID)
	if err != nil {
		return nil, err
	}
	items, err := listBankItemsForBank(ctx, db, bankID, params)
	if err != nil {
		return nil, err
	}
	return &BankWithItems{Bank: bank, Items: items}, nil
}

func GetBankPracticeSummary(ctx context.Context, db *pgxpool.Pool, user *auth.User, bankID int64) (*BankPracticeSummary, error) {
	bank, err := GetBank(ctx, db, user, bankID)
	if err != nil {
		return nil, err
	}

	var activeCount int
	var wrongCount int
	var typeCountsRaw []byte
	var modeCountsRaw []byte
	if err := db.QueryRow(ctx, `
		WITH active_questions AS (
			SELECT
				q.id AS question_id,
				q.question_type_id,
				q.answer_mode
			FROM bank_question_links bql
			JOIN questions q ON q.id = bql.question_id
			WHERE bql.bank_id = $1
			  AND bql.status = 'active'
			  AND q.status = 'active'

			UNION

			SELECT
				q.id AS question_id,
				q.question_type_id,
				q.answer_mode
			FROM bank_group_links bgl
			JOIN group_question_links gql ON gql.group_id = bgl.group_id
			JOIN questions q ON q.id = gql.question_id
			WHERE bgl.bank_id = $1
			  AND bgl.status = 'active'
			  AND q.status = 'active'
		)
		SELECT
			(SELECT COUNT(*)::int FROM active_questions) AS active_count,
			COALESCE(
				(
					SELECT jsonb_object_agg(question_type_id, total)
					FROM (
						SELECT question_type_id, COUNT(*)::int AS total
						FROM active_questions
						GROUP BY question_type_id
					) type_counts
				),
				'{}'::jsonb
			) AS type_counts,
			COALESCE(
				(
					SELECT jsonb_object_agg(answer_mode, total)
					FROM (
						SELECT answer_mode, COUNT(*)::int AS total
						FROM active_questions
						GROUP BY answer_mode
					) mode_counts
				),
				'{}'::jsonb
			) AS mode_counts,
			(
				SELECT COUNT(*)::int
				FROM active_questions aq
				JOIN user_question_stats uqs
				  ON uqs.question_id = aq.question_id
				 AND uqs.user_id = $2
				WHERE uqs.wrong_count > 0 OR uqs.last_is_correct IS FALSE
			) AS wrong_count
	`, bankID, user.ID).Scan(&activeCount, &typeCountsRaw, &modeCountsRaw, &wrongCount); err != nil {
		return nil, err
	}

	return &BankPracticeSummary{
		Bank:        bank,
		ActiveCount: activeCount,
		WrongCount:  wrongCount,
		TypeCounts:  countMapFromDB(typeCountsRaw),
		ModeCounts:  countMapFromDB(modeCountsRaw),
	}, nil
}

func ReorderBankItems(ctx context.Context, db *pgxpool.Pool, user *auth.User, bankID int64, items []ReorderBankItem) error {
	if _, err := RequireBankOwner(ctx, db, user, bankID); err != nil {
		return err
	}
	_, err := withTx(ctx, db, func(tx pgx.Tx) (struct{}, error) {
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
				if _, err := tx.Exec(ctx, `
					UPDATE bank_question_links
					SET sort_order = $3
					WHERE bank_id = $1 AND question_id = $2
				`, bankID, *item.QuestionID, item.SortOrder); err != nil {
					return struct{}{}, err
				}
			}
			if item.GroupID != nil {
				if _, err := tx.Exec(ctx, `
					UPDATE bank_group_links
					SET sort_order = $3
					WHERE bank_id = $1 AND group_id = $2
				`, bankID, *item.GroupID, item.SortOrder); err != nil {
					return struct{}{}, err
				}
			}
		}
		return struct{}{}, nil
	})
	return err
}

func listBankItemsForBank(ctx context.Context, db *pgxpool.Pool, bankID int64, params ListBankItemsParams) ([]BankQuestionItem, error) {
	status := trimmedOrNil(params.Status)
	questionTypeID := trimmedOrNil(params.Type)
	limit := clampPositive(params.Limit, 50, 100)

	rows, err := db.Query(ctx, `
		SELECT
			ids.bank_id,
			ids.group_id,
			ids.question_id,
			ids.item_scope,
			ids.bank_sort_order,
			ids.group_sort_order,
			ids.question_no,
			ids.bank_link_status,
			q.business_type,
			q.subject_id,
			q.question_type_id,
			q.answer_mode,
			q.choice_variant,
			q.content_mode,
			q.stem,
			q.analysis,
			q.status AS question_status,
			g.title AS group_title,
			g.instructions AS group_instructions,
			COALESCE(
				(
					SELECT json_agg(
						json_build_object(
							'id', qo.id,
							'question_id', qo.question_id,
							'option_label', qo.option_label,
							'sort_order', qo.sort_order,
							'content', qo.content,
							'is_correct', qo.is_correct,
							'created_at', qo.created_at,
							'updated_at', qo.updated_at
						)
						ORDER BY qo.sort_order
					)
					FROM question_options qo
					WHERE qo.question_id = ids.question_id
				),
				'[]'::json
			) AS options
		FROM (
			SELECT
				bql.bank_id,
				NULL::bigint AS group_id,
				bql.question_id,
				'standalone'::text AS item_scope,
				bql.sort_order AS bank_sort_order,
				NULL::integer AS group_sort_order,
				bql.question_no,
				bql.status AS bank_link_status
			FROM bank_question_links bql
			WHERE bql.bank_id = $1
			  AND ($2::text IS NULL OR bql.status = $2)

			UNION ALL

			SELECT
				bgl.bank_id,
				bgl.group_id,
				gql.question_id,
				'grouped'::text AS item_scope,
				bgl.sort_order AS bank_sort_order,
				gql.sort_order AS group_sort_order,
				gql.question_no,
				bgl.status AS bank_link_status
			FROM bank_group_links bgl
			JOIN group_question_links gql ON gql.group_id = bgl.group_id
			WHERE bgl.bank_id = $1
			  AND ($2::text IS NULL OR bgl.status = $2)
		) ids
		JOIN questions q ON q.id = ids.question_id
		LEFT JOIN question_groups g ON g.id = ids.group_id
		WHERE ($3::text IS NULL OR q.question_type_id = $3)
		ORDER BY ids.bank_sort_order, ids.group_sort_order NULLS FIRST, ids.question_id
		LIMIT $4
	`, bankID, status, questionTypeID, limit)
	if err != nil {
		return nil, err
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
			return nil, err
		}
		if err := json.Unmarshal(optionsRaw, &item.Options); err != nil {
			return nil, fmt.Errorf("decode bank item options: %w", err)
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func scanQuestionBank(row rowScanner) (QuestionBank, error) {
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

func scanQuestionBankWithFlags(row rowScanner) (QuestionBank, error) {
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

func normalizeBankScope(scope string) string {
	switch strings.TrimSpace(scope) {
	case "public", "favorites", "all":
		return strings.TrimSpace(scope)
	case "mine", "":
		return "mine"
	default:
		return strings.TrimSpace(scope)
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

func countMapFromDB(value any) map[string]int {
	if value == nil {
		return map[string]int{}
	}
	switch raw := value.(type) {
	case []byte:
		return decodeCountMap(raw)
	case string:
		return decodeCountMap([]byte(raw))
	default:
		encoded, err := json.Marshal(raw)
		if err != nil {
			return map[string]int{}
		}
		return decodeCountMap(encoded)
	}
}

func decodeCountMap(raw []byte) map[string]int {
	if len(raw) == 0 {
		return map[string]int{}
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return map[string]int{}
	}
	result := make(map[string]int, len(decoded))
	for key, value := range decoded {
		switch count := value.(type) {
		case float64:
			result[key] = int(count)
		case int:
			result[key] = count
		case int32:
			result[key] = int(count)
		case int64:
			result[key] = int(count)
		}
	}
	return result
}
