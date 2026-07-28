package services

import (
	"context"
	"net/url"
	"strconv"
	"strings"

	"practiq/internal/api"
	"practiq/internal/auth"
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
	CanEdit        bool    `json:"can_edit"`
}

func Search(ctx context.Context, db queryer, user auth.User, target string, params url.Values) (Page[SearchQuestion], error) {
	if target != "questions" {
		return Page[SearchQuestion]{}, api.NewError(422, "VALIDATION_ERROR", "Search kind must be questions", nil)
	}
	return searchQuestions(ctx, db, user, params, strings.TrimSpace(params.Get("q")))
}

func searchQuestions(ctx context.Context, db queryer, user auth.User, params url.Values, normalizedQuery string) (Page[SearchQuestion], error) {
	var bankID any
	if raw := strings.TrimSpace(params.Get("bankId")); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed < 1 {
			return Page[SearchQuestion]{}, api.ValidationError([]api.ValidationDetail{{Field: "bankId", Message: "must be a positive integer"}})
		}
		bankID = parsed
	}
	typeFilter := trimmedStringOrNil(params.Get("type"))
	statusFilter := trimmedStringOrNil(params.Get("status"))
	if statusFilter != nil {
		switch statusFilter {
		case "draft", "active", "archived":
		default:
			return Page[SearchQuestion]{}, api.ValidationError([]api.ValidationDetail{{Field: "status", Message: "must be one of draft, active, archived"}})
		}
	}
	limit := 50
	if raw := strings.TrimSpace(params.Get("limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 100 {
			return Page[SearchQuestion]{}, api.ValidationError([]api.ValidationDetail{{Field: "limit", Message: "must be between 1 and 100"}})
		}
		limit = parsed
	}
	offset, err := parsePageCursor(params.Get("cursor"))
	if err != nil {
		return Page[SearchQuestion]{}, err
	}
	term := trimmedStringOrNil(normalizedQuery)
	rows, err := db.Query(ctx, `
		WITH visible_question_ids AS MATERIALIZED (
		  SELECT item.question_id, BOOL_OR(COALESCE(ubl.is_owner, false)) AS can_edit
		  FROM v_bank_question_items item
		  JOIN question_banks b ON b.id = item.bank_id
		  LEFT JOIN user_bank_links ubl ON ubl.bank_id = b.id AND ubl.user_id = $1
		  WHERE ($2::bigint IS NULL OR item.bank_id = $2)
		    AND (
		      COALESCE(ubl.is_owner, false) = true
		      OR (
		        (b.is_public = true OR ubl.id IS NOT NULL)
		        AND item.question_status = 'active'
		        AND item.bank_link_status = 'active'
		      )
		    )
		  GROUP BY item.question_id
		),
		searchable_questions AS MATERIALIZED (
		  SELECT q.*, vq.can_edit
		  FROM visible_question_ids vq
		  JOIN questions q ON q.id = vq.question_id
		  WHERE ($3::text IS NULL OR q.question_type_id = $3)
		    AND ($4::text IS NULL OR q.status = $4)
		    AND (vq.can_edit OR q.status = 'active')
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
		       sq.stem, CASE WHEN sq.can_edit THEN sq.analysis ELSE NULL END, sq.status, sq.can_edit
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
		LIMIT $6 OFFSET $7
	`, user.ID, bankID, typeFilter, statusFilter, term, limit+1, offset)
	if err != nil {
		return Page[SearchQuestion]{}, err
	}
	defer rows.Close()
	items := make([]SearchQuestion, 0)
	for rows.Next() {
		var item SearchQuestion
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
			&item.CanEdit,
		); err != nil {
			return Page[SearchQuestion]{}, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return Page[SearchQuestion]{}, err
	}
	return buildPage(items, limit, offset), nil
}
