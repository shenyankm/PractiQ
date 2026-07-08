package services

import (
	"context"
	"encoding/json"
	"net/url"
	"strings"
	"time"

	"openwook/internal/api"
	"openwook/internal/auth"
)

type AdminOverview struct {
	TotalUsers      int `json:"total_users"`
	ActiveUsers     int `json:"active_users"`
	AdminUsers      int `json:"admin_users"`
	PlusUsers       int `json:"plus_users"`
	TotalBanks      int `json:"total_banks"`
	TotalQuestions  int `json:"total_questions"`
	ImportJobs      int `json:"import_jobs"`
	OpenReviewItems int `json:"open_review_items"`
	KnowledgePoints int `json:"knowledge_points"`
}

type AdminUser struct {
	UserRecord
	BankCount            int `json:"bank_count"`
	ImportJobCount       int `json:"import_job_count"`
	PracticeSessionCount int `json:"practice_session_count"`
}

type KnowledgePointInput struct {
	SubjectID   string         `json:"subject_id"`
	Code        string         `json:"code"`
	DisplayName string         `json:"display_name"`
	ParentID    *int64         `json:"parent_id"`
	Metadata    map[string]any `json:"metadata"`
}

type KnowledgePointUpdate struct {
	Code        *string        `json:"code"`
	DisplayName *string        `json:"display_name"`
	ParentID    *int64         `json:"parent_id"`
	Metadata    map[string]any `json:"metadata"`
	MetadataSet bool           `json:"-"`
}

type UserAccessUpdate struct {
	Role       *string `json:"role"`
	Membership *string `json:"membership"`
}

func GetAdminOverview(ctx context.Context, db queryer, user auth.User) (*AdminOverview, error) {
	if err := requireAdminRole(user); err != nil {
		return nil, err
	}
	rows, err := db.Query(ctx, `
		SELECT
		  (SELECT COUNT(*)::int FROM users) AS total_users,
		  (SELECT COUNT(*)::int FROM users WHERE is_active = true) AS active_users,
		  (SELECT COUNT(*)::int FROM users WHERE role = 'admin') AS admin_users,
		  (SELECT COUNT(*)::int FROM users WHERE membership IN ('plus', 'enterprise')) AS plus_users,
		  (SELECT COUNT(*)::int FROM question_banks) AS total_banks,
		  (SELECT COUNT(*)::int FROM questions) AS total_questions,
		  (SELECT COUNT(*)::int FROM question_import_jobs) AS import_jobs,
		  (SELECT COUNT(*)::int FROM question_import_job_review_items WHERE status = 'open') AS open_review_items,
		  (SELECT COUNT(*)::int FROM knowledge_points) AS knowledge_points
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return &AdminOverview{}, rows.Err()
	}
	var item AdminOverview
	if err := rows.Scan(
		&item.TotalUsers,
		&item.ActiveUsers,
		&item.AdminUsers,
		&item.PlusUsers,
		&item.TotalBanks,
		&item.TotalQuestions,
		&item.ImportJobs,
		&item.OpenReviewItems,
		&item.KnowledgePoints,
	); err != nil {
		return nil, err
	}
	return &item, rows.Err()
}

func ListAdminUsers(ctx context.Context, db queryer, user auth.User, params url.Values) ([]AdminUser, error) {
	if err := requireAdminRole(user); err != nil {
		return nil, err
	}
	q := strings.TrimSpace(params.Get("q"))
	status := params.Get("status")
	if status == "" {
		status = "all"
	}
	role := params.Get("role")
	if role == "" {
		role = "all"
	}
	rows, err := db.Query(ctx, `
		SELECT
		  u.id, u.username, u.email, u.avatar_url, u.is_active, u.role, u.membership,
		  u.plus_trial_ends_at, u.plus_expires_at, u.created_at, u.updated_at,
		  COALESCE(bank_counts.bank_count, 0)::int AS bank_count,
		  COALESCE(import_counts.import_job_count, 0)::int AS import_job_count,
		  COALESCE(session_counts.practice_session_count, 0)::int AS practice_session_count
		FROM users u
		LEFT JOIN (
		  SELECT user_id, COUNT(*)::int AS bank_count
		  FROM user_bank_links
		  WHERE is_owner = true
		  GROUP BY user_id
		) bank_counts ON bank_counts.user_id = u.id
		LEFT JOIN (
		  SELECT created_by, COUNT(*)::int AS import_job_count
		  FROM question_import_jobs
		  GROUP BY created_by
		) import_counts ON import_counts.created_by = u.id
		LEFT JOIN (
		  SELECT user_id, COUNT(*)::int AS practice_session_count
		  FROM user_practice_sessions
		  GROUP BY user_id
		) session_counts ON session_counts.user_id = u.id
		WHERE
		  ($1::text IS NULL OR u.username ILIKE $2 OR u.email ILIKE $2)
		  AND ($3 = 'all' OR ($3 = 'active' AND u.is_active = true) OR ($3 = 'inactive' AND u.is_active = false))
		  AND ($4 = 'all' OR u.role = $4)
		ORDER BY u.created_at DESC, u.id DESC
		LIMIT 100
	`, trimmedStringOrNil(q), ilikeOrNil(q), status, role)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]AdminUser, 0)
	for rows.Next() {
		var item AdminUser
		var plusTrialEndsAt *time.Time
		var plusExpiresAt *time.Time
		var createdAt time.Time
		var updatedAt time.Time
		if err := rows.Scan(
			&item.ID,
			&item.Username,
			&item.Email,
			&item.AvatarURL,
			&item.IsActive,
			&item.Role,
			&item.Membership,
			&plusTrialEndsAt,
			&plusExpiresAt,
			&createdAt,
			&updatedAt,
			&item.BankCount,
			&item.ImportJobCount,
			&item.PracticeSessionCount,
		); err != nil {
			return nil, err
		}
		item.PlusTrialEndsAt = formatNullableTimestamp(plusTrialEndsAt)
		item.PlusExpiresAt = formatNullableTimestamp(plusExpiresAt)
		item.CreatedAt = formatTimestamp(createdAt)
		item.UpdatedAt = formatTimestamp(updatedAt)
		items = append(items, item)
	}
	return items, rows.Err()
}

func ListAdminKnowledgePoints(ctx context.Context, db queryer, user auth.User, params url.Values) ([]KnowledgePoint, error) {
	if err := requireAdminRole(user); err != nil {
		return nil, err
	}
	subject := strings.TrimSpace(params.Get("subject"))
	q := strings.TrimSpace(params.Get("q"))
	rows, err := db.Query(ctx, `
		SELECT id, subject_id, code, display_name, parent_id, metadata_json, created_at, updated_at
		FROM knowledge_points
		WHERE
		  ($1::text IS NULL OR subject_id = $1)
		  AND ($2::text IS NULL OR code ILIKE $3 OR display_name ILIKE $3)
		ORDER BY subject_id, code
		LIMIT 200
	`, trimmedStringOrNil(subject), trimmedStringOrNil(q), ilikeOrNil(q))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]KnowledgePoint, 0)
	for rows.Next() {
		item, err := scanKnowledgePoint(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func CreateKnowledgePoint(ctx context.Context, db queryer, user auth.User, input KnowledgePointInput) (*KnowledgePoint, error) {
	if err := requireAdminRole(user); err != nil {
		return nil, err
	}
	var metadataJSON []byte
	if input.Metadata == nil {
		metadataJSON = []byte("{}")
	} else {
		payload, err := json.Marshal(input.Metadata)
		if err != nil {
			return nil, err
		}
		metadataJSON = payload
	}
	rows, err := db.Query(ctx, `
		INSERT INTO knowledge_points (subject_id, code, display_name, parent_id, metadata_json)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, subject_id, code, display_name, parent_id, metadata_json, created_at, updated_at
	`, input.SubjectID, input.Code, input.DisplayName, nullableInt64Pointer(input.ParentID), string(metadataJSON))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	item, err := scanKnowledgePoint(rows)
	if err != nil {
		return nil, err
	}
	bumpSliceCacheVersion(ctx, "knowledge-points")
	return &item, rows.Err()
}

func UpdateKnowledgePoint(ctx context.Context, db queryer, user auth.User, id int64, input KnowledgePointUpdate) (*KnowledgePoint, error) {
	if err := requireAdminRole(user); err != nil {
		return nil, err
	}
	var metadata any
	if input.MetadataSet && input.Metadata != nil {
		payload, err := json.Marshal(input.Metadata)
		if err != nil {
			return nil, err
		}
		metadata = string(payload)
	}
	rows, err := db.Query(ctx, `
		UPDATE knowledge_points
		SET
		  code = COALESCE($1, code),
		  display_name = COALESCE($2, display_name),
		  parent_id = COALESCE($3, parent_id),
		  metadata_json = COALESCE($4, metadata_json)
		WHERE id = $5
		RETURNING id, subject_id, code, display_name, parent_id, metadata_json, created_at, updated_at
	`, nullableStringPointer(input.Code), nullableStringPointer(input.DisplayName), nullableInt64Pointer(input.ParentID), metadata, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, api.NewError(404, "NOT_FOUND", "Knowledge point not found", nil)
	}
	item, err := scanKnowledgePoint(rows)
	if err != nil {
		return nil, err
	}
	bumpSliceCacheVersion(ctx, "knowledge-points")
	return &item, rows.Err()
}

func SetUserStatus(ctx context.Context, db queryer, user auth.User, targetUserID int64, isActive bool) (*UserRecord, error) {
	if err := requireAdminRole(user); err != nil {
		return nil, err
	}
	if int64(user.ID) == targetUserID && !isActive {
		return nil, api.NewError(409, "INVALID_STATE", "Administrators cannot disable their own account", nil)
	}
	rows, err := db.Query(ctx, userRecordColumns(`
		UPDATE users
		SET is_active = $1
		WHERE id = $2
		RETURNING %s
	`), isActive, targetUserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, api.NewError(404, "NOT_FOUND", "User not found", nil)
	}
	item, err := scanUserRecord(rows)
	if err != nil {
		return nil, err
	}
	invalidateUserCache(ctx, targetUserID)
	return &item, rows.Err()
}

func UpdateUserAccess(ctx context.Context, db queryer, user auth.User, targetUserID int64, input UserAccessUpdate) (*UserRecord, error) {
	if err := requireAdminRole(user); err != nil {
		return nil, err
	}
	if int64(user.ID) == targetUserID && input.Role != nil && *input.Role == "user" {
		return nil, api.NewError(409, "INVALID_STATE", "Administrators cannot remove their own admin role", nil)
	}
	rows, err := db.Query(ctx, userRecordColumns(`
		UPDATE users
		SET
		  role = COALESCE($1, role),
		  membership = COALESCE($2, membership),
		  plus_expires_at = CASE
		    WHEN $2 = 'free' THEN NULL
		    ELSE plus_expires_at
		  END
		WHERE id = $3
		RETURNING %s
	`), nullableStringPointer(input.Role), nullableStringPointer(input.Membership), targetUserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, api.NewError(404, "NOT_FOUND", "User not found", nil)
	}
	item, err := scanUserRecord(rows)
	if err != nil {
		return nil, err
	}
	invalidateUserCache(ctx, targetUserID)
	return &item, rows.Err()
}

func scanKnowledgePoint(row interface{ Scan(...any) error }) (KnowledgePoint, error) {
	var item KnowledgePoint
	var createdAt time.Time
	var updatedAt time.Time
	if err := row.Scan(&item.ID, &item.SubjectID, &item.Code, &item.DisplayName, &item.ParentID, &item.MetadataJSON, &createdAt, &updatedAt); err != nil {
		return KnowledgePoint{}, err
	}
	item.CreatedAt = formatTimestamp(createdAt)
	item.UpdatedAt = formatTimestamp(updatedAt)
	return item, nil
}
