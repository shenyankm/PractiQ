package services

import (
	"context"
	"fmt"
	"strings"
	"time"

	"openwook/internal/api"
	"openwook/internal/auth"
)

type UserRecord struct {
	ID              int64   `json:"id"`
	Username        string  `json:"username"`
	Email           *string `json:"email"`
	AvatarURL       *string `json:"avatar_url"`
	IsActive        bool    `json:"is_active"`
	Role            string  `json:"role"`
	Membership      string  `json:"membership"`
	PlusTrialEndsAt *string `json:"plus_trial_ends_at"`
	PlusExpiresAt   *string `json:"plus_expires_at"`
	CreatedAt       string  `json:"created_at"`
	UpdatedAt       string  `json:"updated_at"`
}

type UserUpdateInput struct {
	Username     *string `json:"username"`
	Email        *string `json:"email"`
	PasswordHash *string `json:"password_hash"`
	AvatarURL    *string `json:"avatar_url"`
	AvatarURLSet bool    `json:"-"`
}

type entitlementRecord struct {
	Username        string
	Role            string
	Membership      string
	PlusTrialEndsAt *time.Time
	PlusExpiresAt   *time.Time
}

type analyticsSummary struct {
	OwnedBanks     int
	FavoriteBanks  int
	Attempts       int
	Correct        int
	Wrong          int
	Sessions       int
	ActiveSessions int
	ActiveImports  int
	Accuracy       int
}

func UpdateCurrentUser(ctx context.Context, db queryer, user auth.User, input UserUpdateInput) (*UserRecord, error) {
	rows, err := db.Query(ctx, userRecordColumns(`
		UPDATE users
		SET
		  username = COALESCE($1, username),
		  email = COALESCE($2, email),
		  password_hash = COALESCE($3, password_hash),
		  avatar_url = CASE
		    WHEN $4::boolean THEN $5
		    ELSE avatar_url
		  END
		WHERE id = $6
		RETURNING %s
	`), nullableStringPointer(input.Username), nullableStringPointer(input.Email), nullableStringPointer(input.PasswordHash), input.AvatarURLSet, nullableStringPointer(input.AvatarURL), user.ID)
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
	invalidateUserCache(ctx, int64(user.ID))
	return &item, rows.Err()
}

func ExportUserSummaryPDF(ctx context.Context, db queryer, user auth.User) ([]byte, error) {
	viewer, err := loadEntitlementRecord(ctx, db, int64(user.ID))
	if err != nil {
		return nil, err
	}
	if viewer == nil {
		return nil, api.NewError(404, "NOT_FOUND", "User not found", nil)
	}
	if err := requirePlusEntitlement(*viewer, time.Now().UTC(), "PDF export"); err != nil {
		return nil, err
	}
	summary, err := loadAnalyticsSummary(ctx, db, int64(user.ID))
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	lines := []string{
		"OpenWook User Summary",
		fmt.Sprintf("User: %s", viewer.Username),
		fmt.Sprintf("Role: %s", viewer.Role),
		fmt.Sprintf("Membership: %s", viewer.Membership),
		fmt.Sprintf("Plus trial ends: %s", nullableTimeLine(viewer.PlusTrialEndsAt)),
		"",
		fmt.Sprintf("Owned banks: %d", summary.OwnedBanks),
		fmt.Sprintf("Favorite banks: %d", summary.FavoriteBanks),
		fmt.Sprintf("Practice sessions: %d", summary.Sessions),
		fmt.Sprintf("Active sessions: %d", summary.ActiveSessions),
		fmt.Sprintf("Answer attempts: %d", summary.Attempts),
		fmt.Sprintf("Correct answers: %d", summary.Correct),
		fmt.Sprintf("Wrong answers: %d", summary.Wrong),
		fmt.Sprintf("Accuracy: %d%%", summary.Accuracy),
		fmt.Sprintf("Active imports: %d", summary.ActiveImports),
		"",
		fmt.Sprintf("Generated at: %s", formatTimestamp(now)),
	}
	return buildSimplePDF(lines, now), nil
}

func userRecordColumns(query string) string {
	return fmt.Sprintf(query, `
		id,
		username,
		email,
		avatar_url,
		is_active,
		role,
		membership,
		plus_trial_ends_at,
		plus_expires_at,
		created_at,
		updated_at
	`)
}

func scanUserRecord(row interface{ Scan(...any) error }) (UserRecord, error) {
	var item UserRecord
	var plusTrialEndsAt *time.Time
	var plusExpiresAt *time.Time
	var createdAt time.Time
	var updatedAt time.Time
	if err := row.Scan(
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
	); err != nil {
		return UserRecord{}, err
	}
	item.PlusTrialEndsAt = formatNullableTimestamp(plusTrialEndsAt)
	item.PlusExpiresAt = formatNullableTimestamp(plusExpiresAt)
	item.CreatedAt = formatTimestamp(createdAt)
	item.UpdatedAt = formatTimestamp(updatedAt)
	return item, nil
}

func loadEntitlementRecord(ctx context.Context, db queryer, userID int64) (*entitlementRecord, error) {
	rows, err := db.Query(ctx, `
		SELECT username, role, membership, plus_trial_ends_at, plus_expires_at
		FROM users
		WHERE id = $1
		LIMIT 1
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	var item entitlementRecord
	if err := rows.Scan(&item.Username, &item.Role, &item.Membership, &item.PlusTrialEndsAt, &item.PlusExpiresAt); err != nil {
		return nil, err
	}
	return &item, rows.Err()
}

func requirePlusEntitlement(user entitlementRecord, now time.Time, feature string) error {
	if user.Role == "admin" {
		return nil
	}
	if user.Membership == "plus" || user.Membership == "enterprise" {
		if user.PlusExpiresAt == nil {
			return nil
		}
		if user.PlusExpiresAt.After(now) {
			return nil
		}
	} else if user.PlusTrialEndsAt != nil && user.PlusTrialEndsAt.After(now) {
		return nil
	}
	return api.NewError(403, "PLUS_REQUIRED", feature+" requires Plus or Enterprise membership", nil)
}

func RequirePlusEntitlement(ctx context.Context, db queryer, user auth.User, feature string) error {
	record, err := loadEntitlementRecord(ctx, db, int64(user.ID))
	if err != nil {
		return err
	}
	if record == nil {
		return api.NewError(404, "NOT_FOUND", "User not found", nil)
	}
	return requirePlusEntitlement(*record, time.Now().UTC(), feature)
}

func loadAnalyticsSummary(ctx context.Context, db queryer, userID int64) (*analyticsSummary, error) {
	rows, err := db.Query(ctx, `
		SELECT
		  (SELECT COUNT(*)::int FROM user_bank_links WHERE user_id = $1 AND is_owner = true) AS owned_banks,
		  (SELECT COUNT(*)::int FROM user_bank_links WHERE user_id = $1 AND is_favorite = true) AS favorite_banks,
		  COALESCE((SELECT SUM(attempt_count)::int FROM user_question_stats WHERE user_id = $1), 0) AS attempts,
		  COALESCE((SELECT SUM(correct_count)::int FROM user_question_stats WHERE user_id = $1), 0) AS correct,
		  COALESCE((SELECT SUM(wrong_count)::int FROM user_question_stats WHERE user_id = $1), 0) AS wrong,
		  (SELECT COUNT(*)::int FROM user_practice_sessions WHERE user_id = $1) AS sessions,
		  (SELECT COUNT(*)::int FROM user_practice_sessions WHERE user_id = $1 AND status = 'active') AS active_sessions,
		  (SELECT COUNT(*)::int FROM question_import_jobs WHERE created_by = $1 AND status IN ('queued', 'processing')) AS active_imports
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return &analyticsSummary{}, rows.Err()
	}
	var item analyticsSummary
	if err := rows.Scan(&item.OwnedBanks, &item.FavoriteBanks, &item.Attempts, &item.Correct, &item.Wrong, &item.Sessions, &item.ActiveSessions, &item.ActiveImports); err != nil {
		return nil, err
	}
	if item.Attempts > 0 {
		item.Accuracy = int((float64(item.Correct)/float64(item.Attempts))*100 + 0.5)
	}
	return &item, rows.Err()
}

func buildSimplePDF(lines []string, _ time.Time) []byte {
	content := strings.Join(append(append([]string{
		"BT",
		"/F1 18 Tf",
		"72 760 Td",
		fmt.Sprintf("(%s) Tj", escapePDFText(firstLine(lines))),
		"/F1 11 Tf",
	}, bodyPDFLines(lines[1:])...), "ET"), "\n")
	objects := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(content), content),
	}
	pdf := "%PDF-1.4\n"
	offsets := make([]int, 0, len(objects))
	for index, object := range objects {
		offsets = append(offsets, len(pdf))
		pdf += fmt.Sprintf("%d 0 obj\n%s\nendobj\n", index+1, object)
	}
	xrefOffset := len(pdf)
	pdf += fmt.Sprintf("xref\n0 %d\n", len(objects)+1)
	pdf += "0000000000 65535 f \n"
	for _, offset := range offsets {
		pdf += fmt.Sprintf("%010d 00000 n \n", offset)
	}
	pdf += fmt.Sprintf("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objects)+1, xrefOffset)
	return []byte(pdf)
}

func firstLine(lines []string) string {
	if len(lines) == 0 {
		return "OpenWook Export"
	}
	return lines[0]
}

func bodyPDFLines(lines []string) []string {
	items := make([]string, 0, len(lines)*2)
	for _, line := range lines {
		items = append(items, "0 -18 Td", fmt.Sprintf("(%s) Tj", escapePDFText(line)))
	}
	return items
}

func escapePDFText(value string) string {
	replaced := strings.Map(func(r rune) rune {
		if r < 0x20 || r > 0x7e {
			return '?'
		}
		return r
	}, value)
	replaced = strings.ReplaceAll(replaced, `\`, `\\`)
	replaced = strings.ReplaceAll(replaced, `(`, `\(`)
	replaced = strings.ReplaceAll(replaced, `)`, `\)`)
	return replaced
}

func nullableTimeLine(value *time.Time) string {
	if value == nil {
		return "none"
	}
	return formatTimestamp(*value)
}
