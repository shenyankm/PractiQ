package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"golang.org/x/crypto/bcrypt"
	"openwook/internal/api"
	"openwook/internal/config"
	"openwook/internal/redisx"
)

type UpdateUserInput struct {
	Username        *string
	Email           *string
	EmailSet        bool
	CurrentPassword *string
	NewPassword     *string
}

func ComparePassword(password string, passwordHash string) bool {
	return bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(password)) == nil
}

func RegisterUser(ctx context.Context, pool *pgxpool.Pool, username string, email *string, password string) (*User, error) {
	hash, err := HashPassword(password)
	if err != nil {
		return nil, err
	}
	row := pool.QueryRow(ctx, `
		INSERT INTO users (username, email, password_hash, role, membership)
		VALUES ($1, $2, $3, 'user', 'free')
		RETURNING id, username, email, is_active, role, membership
	`, username, nullableString(email), hash)
	user, err := scanUser(row)
	if err != nil {
		return nil, userConflictError(err)
	}
	if user != nil {
		cacheUser(ctx, *user)
	}
	return user, nil
}

func UpdateUser(ctx context.Context, pool *pgxpool.Pool, userID int, input UpdateUserInput) (*User, error) {
	var passwordHash *string
	if input.NewPassword != nil {
		var currentHash string
		if err := pool.QueryRow(ctx, `SELECT password_hash FROM users WHERE id = $1`, userID).Scan(&currentHash); err != nil {
			return nil, err
		}
		if input.CurrentPassword == nil || !ComparePassword(*input.CurrentPassword, currentHash) {
			return nil, api.ValidationError([]api.ValidationDetail{{Field: "currentPassword", Message: "is incorrect"}})
		}
		hash, err := HashPassword(*input.NewPassword)
		if err != nil {
			return nil, err
		}
		passwordHash = &hash
	}
	row := pool.QueryRow(ctx, `
		UPDATE users
		SET
			username = COALESCE($2, username),
			email = CASE WHEN $3 THEN $4 ELSE email END,
			password_hash = COALESCE($5, password_hash)
		WHERE id = $1
		RETURNING id, username, email, is_active, role, membership
	`, userID, nullableString(input.Username), input.EmailSet, nullableString(input.Email), nullableString(passwordHash))
	user, err := scanUser(row)
	if err != nil {
		return nil, userConflictError(err)
	}
	if user == nil {
		return nil, api.NewError(http.StatusNotFound, "NOT_FOUND", "User not found", nil)
	}
	invalidateUserCache(ctx, userID)
	cacheUser(ctx, *user)
	return user, nil
}

func userConflictError(err error) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23505" {
		return err
	}
	switch pgErr.ConstraintName {
	case "uq_users_username_lower":
		return api.NewError(http.StatusConflict, "USERNAME_TAKEN", "Username is already in use", nil)
	case "uq_users_email_lower":
		return api.NewError(http.StatusConflict, "EMAIL_TAKEN", "Email is already in use", nil)
	default:
		return api.NewError(http.StatusConflict, "USER_CONFLICT", "User details conflict with an existing account", nil)
	}
}

func AuthenticateUser(ctx context.Context, pool *pgxpool.Pool, login string, password string) (*User, error) {
	row, err := LookupUserPasswordByLoginPGX(ctx, pool, login)
	if err != nil {
		return nil, err
	}
	if row == nil {
		_ = bcrypt.CompareHashAndPassword([]byte(DummyPasswordHash), []byte(password))
		return nil, api.NewError(http.StatusUnauthorized, "UNAUTHENTICATED", "Authentication required", nil)
	}
	if !ComparePassword(password, row.PasswordHash) {
		return nil, api.NewError(http.StatusUnauthorized, "UNAUTHENTICATED", "Authentication required", nil)
	}
	user, err := CurrentUserByID(ctx, pool, row.ID)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, api.NewError(http.StatusUnauthorized, "UNAUTHENTICATED", "Authentication required", nil)
	}
	if !user.IsActive {
		return nil, api.NewError(http.StatusForbidden, "USER_INACTIVE", "User account is disabled", nil)
	}
	return user, nil
}

func SetSession(w http.ResponseWriter, userID int) error {
	ttl, err := config.SessionTTL()
	if err != nil {
		return err
	}
	expires := time.Now().UTC().Add(ttl)
	token, err := SignSessionToken(SessionPayload{User: SessionUser{ID: userID}, Expires: expires.Format(time.RFC3339), JTI: NewUUID()})
	if err != nil {
		return err
	}
	http.SetCookie(w, SessionCookie(token, expires))
	return nil
}

func ClearSession(w http.ResponseWriter, r *http.Request) error {
	if token := sessionTokenFromRequest(r); token != "" {
		if payload, verifyErr := VerifySessionToken(token); verifyErr == nil && payload.JTI != "" {
			ttl := time.Until(parseExpiry(payload.Expires))
			if ttl > 0 {
				rdb := redisx.Client()
				if rdb == nil {
					return sessionStoreUnavailable()
				}
				if err := rdb.Set(r.Context(), sessionRevocationKey(payload.JTI), "true", ttl).Err(); err != nil {
					return sessionStoreUnavailable()
				}
			}
		}
	}
	cookie := SessionCookie("", time.Unix(0, 0).UTC())
	cookie.MaxAge = -1
	http.SetCookie(w, cookie)
	return nil
}

func CurrentUserByID(ctx context.Context, pool *pgxpool.Pool, userID int) (*User, error) {
	if rdb := redisx.Client(); rdb != nil {
		if cached, ok := redisx.GetJSON[User](ctx, rdb, userCacheKey(userID)); ok {
			return &cached, nil
		}
	}
	row := pool.QueryRow(ctx, `
		SELECT id, username, email, is_active, role, membership
		FROM users
		WHERE id = $1
		LIMIT 1
	`, userID)
	user, err := scanUser(row)
	if err != nil {
		return nil, err
	}
	if user != nil {
		cacheUser(ctx, *user)
	}
	return user, nil
}

// sessionTokenFromRequest reads the session JWT from the session cookie or,
// for mobile clients that cannot use cookies, from an Authorization bearer header.
func sessionTokenFromRequest(r *http.Request) string {
	if cookie, err := r.Cookie("session"); err == nil && cookie.Value != "" {
		return cookie.Value
	}
	if token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer "); ok {
		return strings.TrimSpace(token)
	}
	return ""
}

func CurrentUserFromRequest(pool *pgxpool.Pool) CurrentUserResolver {
	return func(r *http.Request) (*User, error) {
		token := sessionTokenFromRequest(r)
		if token == "" {
			return nil, nil
		}
		payload, err := VerifySessionToken(token)
		if err != nil {
			return nil, nil
		}
		if payload.JTI == "" {
			return nil, nil
		}
		rdb := redisx.Client()
		if rdb == nil {
			return nil, sessionStoreUnavailable()
		}
		revoked, err := sessionRevoked(r.Context(), rdb, payload.JTI)
		if err != nil {
			return nil, sessionStoreUnavailable()
		}
		if revoked {
			return nil, nil
		}
		return CurrentUserByID(r.Context(), pool, payload.User.ID)
	}
}

func LookupUserPasswordByLoginPGX(ctx context.Context, pool *pgxpool.Pool, login string) (*PasswordRow, error) {
	row := pool.QueryRow(ctx, `
		SELECT id, password_hash
		FROM users
		WHERE lower(username) = lower($1)
		   OR lower(email) = lower($1)
		LIMIT 1
	`, login)
	var result PasswordRow
	if err := row.Scan(&result.ID, &result.PasswordHash); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &result, nil
}

func scanUser(row pgx.Row) (*User, error) {
	var user User
	var email *string
	if err := row.Scan(&user.ID, &user.Username, &email, &user.IsActive, &user.Role, &user.Membership); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	user.Email = email
	return &user, nil
}

func nullableString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func userCacheKey(userID int) string {
	return redisx.RedisKey("cache", "user", userID)
}

func sessionRevocationKey(jti string) string {
	return redisx.RedisKey("session", "revoked", jti)
}

func sessionRevoked(ctx context.Context, rdb *redis.Client, jti string) (bool, error) {
	exists, err := rdb.Exists(ctx, sessionRevocationKey(jti)).Result()
	if err != nil {
		return false, err
	}
	return exists > 0, nil
}

func sessionStoreUnavailable() *api.Error {
	return api.NewError(http.StatusServiceUnavailable, "SESSION_STORE_UNAVAILABLE", "Session service is temporarily unavailable", nil)
}

func cacheUser(ctx context.Context, user User) {
	rdb := redisx.Client()
	if rdb == nil {
		return
	}
	_ = redisx.SetJSON(ctx, rdb, userCacheKey(user.ID), user, cacheTTL())
}

func invalidateUserCache(ctx context.Context, userID int) {
	if rdb := redisx.Client(); rdb != nil {
		_ = rdb.Del(ctx, userCacheKey(userID)).Err()
	}
}

func cacheTTL() time.Duration {
	seconds, err := strconv.Atoi(strings.TrimSpace(os.Getenv("USER_CACHE_TTL_SECONDS")))
	if err != nil || seconds <= 0 {
		seconds = 60
	}
	return time.Duration(seconds) * time.Second
}

func parseExpiry(raw string) time.Time {
	expiresAt, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return time.Time{}
	}
	return expiresAt
}

func NewUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return strconv.FormatInt(time.Now().UTC().UnixNano(), 10)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	encoded := make([]byte, 32)
	hex.Encode(encoded, b[:])
	return string(encoded[0:8]) + "-" + string(encoded[8:12]) + "-" + string(encoded[12:16]) + "-" + string(encoded[16:20]) + "-" + string(encoded[20:32])
}
