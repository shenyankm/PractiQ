package services

import (
	"context"
	"fmt"
	"time"

	"practiq/internal/api"
	"practiq/internal/auth"
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

type entitlementRecord struct {
	Username        string
	Role            string
	Membership      string
	PlusTrialEndsAt *time.Time
	PlusExpiresAt   *time.Time
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
