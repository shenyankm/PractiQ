package services

import (
	"context"
	"net/url"
	"strconv"
	"strings"
	"time"

	"openwook/internal/auth"
)

type SearchQuestion struct {
	ID             int64   `json:"id"`
	BusinessType   string  `json:"business_type"`
	SubjectID      string  `json:"subject_id"`
	QuestionTypeID string  `json:"question_type_id"`
	AnswerMode     string  `json:"answer_mode"`
	ChoiceVariant  *string `json:"choice_variant"`
	Stem           string  `json:"stem"`
	Analysis       *string `json:"analysis"`
	Status         string  `json:"status"`
	SourceType     string  `json:"source_type"`
	SourceRef      *string `json:"source_ref"`
	SourceJobID    *int64  `json:"source_job_id"`
	ImportedBy     *int64  `json:"imported_by"`
	CreatedAt      string  `json:"created_at"`
	UpdatedAt      string  `json:"updated_at"`
}

type SearchBank struct {
	ID          int64   `json:"id"`
	Name        string  `json:"name"`
	Description *string `json:"description"`
	Subject     string  `json:"subject"`
	TotalCount  int     `json:"total_count"`
	CreatedBy   int64   `json:"created_by"`
	IsPublic    bool    `json:"is_public"`
	CreatedAt   string  `json:"created_at"`
	UpdatedAt   string  `json:"updated_at"`
	IsOwner     bool    `json:"is_owner"`
	IsFavorite  bool    `json:"is_favorite"`
}

func Search(ctx context.Context, db queryer, user auth.User, target string, params url.Values) (any, error) {
	q := params.Get("q")
	normalizedQuery := strings.TrimSpace(q)
	switch target {
	case "banks":
		return searchBanks(ctx, db, user, params.Get("scope"), q)
	case "questions":
		return searchQuestions(ctx, db, user, params, normalizedQuery)
	default:
		return ListKnowledgePoints(ctx, db, params.Get("subject"), nil)
	}
}

func searchBanks(ctx context.Context, db queryer, user auth.User, scope string, q string) ([]SearchBank, error) {
	resolvedScope := normalizeSearchScope(scope)
	rows, err := db.Query(ctx, `
		SELECT
		  b.id, b.name, b.description, b.subject, b.total_count, b.created_by, b.is_public, b.created_at, b.updated_at,
		  COALESCE(ubl.is_owner, false) AS is_owner,
		  COALESCE(ubl.is_favorite, false) AS is_favorite
		FROM question_banks b
		LEFT JOIN user_bank_links ubl
		  ON ubl.bank_id = b.id
		 AND ubl.user_id = $1
		WHERE (
		    $2 = 'public' AND b.is_public = true
		    OR $2 = 'favorites' AND ubl.is_favorite = true
		    OR $2 = 'mine' AND COALESCE(ubl.is_owner, false) = true
		    OR $2 = 'all' AND (b.is_public = true OR ubl.id IS NOT NULL)
		  )
		  AND ($3::text IS NULL OR b.name ILIKE $3)
		ORDER BY b.updated_at DESC, b.id DESC
		LIMIT 30
	`, user.ID, resolvedScope, ilikeOrNil(q))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]SearchBank, 0)
	for rows.Next() {
		item, err := scanSearchBank(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func searchQuestions(ctx context.Context, db queryer, user auth.User, params url.Values, normalizedQuery string) ([]SearchQuestion, error) {
	var bankID any
	if parsed, err := strconv.ParseInt(strings.TrimSpace(params.Get("bankId")), 10, 64); err == nil && parsed > 0 {
		bankID = parsed
	}
	typeFilter := trimmedStringOrNil(params.Get("type"))
	statusFilter := trimmedStringOrNil(params.Get("status"))
	term := trimmedStringOrNil(normalizedQuery)
	rows, err := db.Query(ctx, `
		WITH visible_question_ids AS MATERIALIZED (
		  SELECT bql.question_id
		  FROM bank_question_links bql
		  JOIN question_banks b ON b.id = bql.bank_id
		  LEFT JOIN user_bank_links ubl ON ubl.bank_id = b.id AND ubl.user_id = $1
		  WHERE ($2::bigint IS NULL OR bql.bank_id = $2)
		    AND (b.is_public = true OR ubl.id IS NOT NULL)
		
		  UNION
		
		  SELECT gql.question_id
		  FROM bank_group_links bgl
		  JOIN question_banks b ON b.id = bgl.bank_id
		  LEFT JOIN user_bank_links ubl ON ubl.bank_id = b.id AND ubl.user_id = $1
		  JOIN group_question_links gql ON gql.group_id = bgl.group_id
		  WHERE ($2::bigint IS NULL OR bgl.bank_id = $2)
		    AND (b.is_public = true OR ubl.id IS NOT NULL)
		),
		searchable_questions AS MATERIALIZED (
		  SELECT q.*
		  FROM visible_question_ids vq
		  JOIN questions q ON q.id = vq.question_id
		  WHERE ($3::text IS NULL OR q.question_type_id = $3)
		    AND ($4::text IS NULL OR q.status = $4)
		),
		query AS (
		  SELECT
		    $5::text AS term,
		    CASE
		      WHEN $5::text IS NULL THEN NULL
		      ELSE plainto_tsquery('simple', $5::text)
		    END AS tsq
		)
		SELECT sq.id, sq.business_type, sq.subject_id, sq.question_type_id, sq.answer_mode, sq.choice_variant,
		       sq.stem, sq.analysis, sq.status, sq.source_type, sq.source_ref, sq.source_job_id, sq.imported_by,
		       sq.created_at, sq.updated_at
		FROM searchable_questions sq
		CROSS JOIN query
		WHERE query.term IS NULL
		   OR sq.stem ILIKE '%' || query.term || '%'
		   OR to_tsvector('simple', COALESCE(sq.stem, '')) @@ query.tsq
		ORDER BY
		  CASE
		    WHEN query.tsq IS NULL THEN 0
		    ELSE ts_rank_cd(to_tsvector('simple', COALESCE(sq.stem, '')), query.tsq)
		  END DESC,
		  sq.updated_at DESC
		LIMIT 50
	`, user.ID, bankID, typeFilter, statusFilter, term)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]SearchQuestion, 0)
	for rows.Next() {
		var item SearchQuestion
		var createdAt time.Time
		var updatedAt time.Time
		if err := rows.Scan(
			&item.ID,
			&item.BusinessType,
			&item.SubjectID,
			&item.QuestionTypeID,
			&item.AnswerMode,
			&item.ChoiceVariant,
			&item.Stem,
			&item.Analysis,
			&item.Status,
			&item.SourceType,
			&item.SourceRef,
			&item.SourceJobID,
			&item.ImportedBy,
			&createdAt,
			&updatedAt,
		); err != nil {
			return nil, err
		}
		item.CreatedAt = formatTimestamp(createdAt)
		item.UpdatedAt = formatTimestamp(updatedAt)
		items = append(items, item)
	}
	return items, rows.Err()
}

func normalizeSearchScope(scope string) string {
	switch strings.TrimSpace(scope) {
	case "public", "favorites", "mine", "all":
		return strings.TrimSpace(scope)
	default:
		return "all"
	}
}

func scanSearchBank(row interface{ Scan(...any) error }) (SearchBank, error) {
	var item SearchBank
	var createdAt time.Time
	var updatedAt time.Time
	if err := row.Scan(
		&item.ID,
		&item.Name,
		&item.Description,
		&item.Subject,
		&item.TotalCount,
		&item.CreatedBy,
		&item.IsPublic,
		&createdAt,
		&updatedAt,
		&item.IsOwner,
		&item.IsFavorite,
	); err != nil {
		return SearchBank{}, err
	}
	item.CreatedAt = formatTimestamp(createdAt)
	item.UpdatedAt = formatTimestamp(updatedAt)
	return item, nil
}
