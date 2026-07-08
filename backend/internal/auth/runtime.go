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

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
	"openwook/internal/api"
	"openwook/internal/redisx"
)

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
		return nil, err
	}
	if user != nil {
		cacheUser(ctx, *user)
	}
	return user, nil
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
	expires := time.Now().UTC().Add(7 * 24 * time.Hour)
	token, err := SignSessionToken(SessionPayload{User: SessionUser{ID: userID}, Expires: expires.Format(time.RFC3339), JTI: newSessionJTI()})
	if err != nil {
		return err
	}
	http.SetCookie(w, SessionCookie(token, expires))
	return nil
}

func ClearSession(w http.ResponseWriter, r *http.Request) error {
	if cookie, err := r.Cookie("session"); err == nil {
		if payload, verifyErr := VerifySessionToken(cookie.Value); verifyErr == nil && payload.JTI != "" {
			if rdb := redisx.Client(); rdb != nil {
				ttl := time.Until(parseExpiry(payload.Expires))
				if ttl > 0 {
					_ = redisx.SetJSON(r.Context(), rdb, sessionRevocationKey(payload.JTI), true, ttl)
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

func CurrentUserFromRequest(pool *pgxpool.Pool) CurrentUserResolver {
	return func(r *http.Request) (*User, error) {
		cookie, err := r.Cookie("session")
		if err != nil {
			if errors.Is(err, http.ErrNoCookie) {
				return nil, nil
			}
			return nil, err
		}
		payload, err := VerifySessionToken(cookie.Value)
		if err != nil {
			return nil, nil
		}
		if payload.JTI != "" {
			if rdb := redisx.Client(); rdb != nil {
				if revoked, ok := redisx.GetJSON[bool](r.Context(), rdb, sessionRevocationKey(payload.JTI)); ok && revoked {
					return nil, nil
				}
			}
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
		if strings.Contains(err.Error(), "no rows") {
			return nil, nil
		}
		return nil, err
	}
	return &result, nil
}

type rowScanner interface{ Scan(...any) error }

func scanUser(row rowScanner) (*User, error) {
	var user User
	var email *string
	if err := row.Scan(&user.ID, &user.Username, &email, &user.IsActive, &user.Role, &user.Membership); err != nil {
		if strings.Contains(err.Error(), "no rows") {
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

func cacheUser(ctx context.Context, user User) {
	rdb := redisx.Client()
	if rdb == nil {
		return
	}
	_ = redisx.SetJSON(ctx, rdb, userCacheKey(user.ID), user, cacheTTL())
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

func newSessionJTI() string {
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
