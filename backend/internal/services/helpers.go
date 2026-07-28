package services

import (
	"context"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"practiq/internal/api"
	"practiq/internal/auth"
	"practiq/internal/redisx"
)

type execer interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func requireAdminRole(user auth.User) error {
	if user.Role != "admin" {
		return api.NewError(403, "ADMIN_REQUIRED", "Administrator privileges required", nil)
	}
	return nil
}

func nullableStringPointer(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableInt64Pointer(value *int64) any {
	if value == nil {
		return nil
	}
	return *value
}

func trimmedStringOrNil(value string) any {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return trimmed
}

func ilikeOrNil(value string) any {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return "%" + trimmed + "%"
}

func invalidateUserCache(ctx context.Context, userID int64) {
	if rdb := redisx.Client(); rdb != nil {
		_ = rdb.Unlink(ctx, redisx.RedisKey("cache", "user", userID)).Err()
	}
}

func bumpSliceCacheVersion(ctx context.Context, scope string, id ...any) {
	if scope != "analytics" && scope != "bank-analytics" && scope != "leaderboard" {
		return
	}
	if rdb := redisx.Client(); rdb != nil {
		parts := append([]any{"cache-version", scope}, id...)
		_ = rdb.Incr(ctx, redisx.RedisKey(parts...)).Err()
	}
}

func formatTimestamp(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

func formatNullableTimestamp(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := formatTimestamp(*value)
	return &formatted
}
