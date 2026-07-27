package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/mail"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"
	"openwook/internal/api"
	"openwook/internal/redisx"
)

const DummyPasswordHash = "$2y$10$bPkUrUZqKDqmW.xkPE5LBuqH6HB/QoOS4dYH42xQxevBJQMStTE0W"
const bcryptCost = 10
const maxAuthJSONBodyBytes int64 = 16 * 1024
const authRateLimit = 10
const authIPRateLimit = 100

var authRateLimitWindow = time.Minute

type User struct {
	ID         int     `json:"id"`
	Username   string  `json:"username"`
	Email      *string `json:"email"`
	IsActive   bool    `json:"is_active"`
	Role       string  `json:"role,omitempty"`
	Membership string  `json:"membership"`
}

type PasswordRow struct {
	ID           int
	PasswordHash string
}

type CurrentUserResolver func(*http.Request) (*User, error)

type HandlerDependencies struct {
	RegisterUser     func(context.Context, string, *string, string) (*User, error)
	AuthenticateUser func(context.Context, string, string) (*User, error)
	SetSession       func(http.ResponseWriter, int) error
	ClearSession     func(http.ResponseWriter, *http.Request) error
	CurrentUser      CurrentUserResolver
}

type registerRequest struct {
	Username string  `json:"username"`
	Email    *string `json:"email"`
	Password string  `json:"password"`
}

type loginRequest struct {
	Login    string `json:"login"`
	Password string `json:"password"`
}

// sessionResponse extends the user payload with the session JWT so mobile
// clients can authenticate with a bearer header instead of the cookie.
type sessionResponse struct {
	*User
	Token     string `json:"token,omitempty"`
	ExpiresAt string `json:"expiresAt,omitempty"`
}

func issuedSessionResponse(w http.ResponseWriter, user *User) sessionResponse {
	response := sessionResponse{User: user}
	for _, raw := range w.Header().Values("Set-Cookie") {
		cookie, err := http.ParseSetCookie(raw)
		if err != nil || cookie.Name != "session" || cookie.Value == "" {
			continue
		}
		response.Token = cookie.Value
		if !cookie.Expires.IsZero() {
			response.ExpiresAt = cookie.Expires.UTC().Format(time.RFC3339)
		}
	}
	return response
}

func HashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

func Register(deps HandlerDependencies) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body registerRequest
		if err := decodeAuthRequest(w, r, &body); err != nil {
			api.HandleError(w, r, err)
			return
		}
		if err := validateRegisterRequest(&body); err != nil {
			api.HandleError(w, r, err)
			return
		}
		if err := rateLimitAuth(r, ""); err != nil {
			api.HandleError(w, r, err)
			return
		}
		user, err := deps.RegisterUser(r.Context(), body.Username, body.Email, body.Password)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		if deps.SetSession != nil {
			if err := deps.SetSession(w, user.ID); err != nil {
				api.HandleError(w, r, err)
				return
			}
		}
		api.Created(w, r, issuedSessionResponse(w, user), nil)
	})
}

func validateRegisterRequest(body *registerRequest) error {
	details := make([]api.ValidationDetail, 0, 4)

	if len(body.Username) < 3 || len(body.Username) > 20 {
		details = append(details, api.ValidationDetail{Field: "username", Message: "Must be 3-20 letters, numbers, or underscores"})
	} else {
		for _, character := range body.Username {
			if character != '_' && (character < '0' || character > '9') && (character < 'A' || character > 'Z') && (character < 'a' || character > 'z') {
				details = append(details, api.ValidationDetail{Field: "username", Message: "Must be 3-20 letters, numbers, or underscores"})
				break
			}
		}
	}

	if body.Email == nil {
		details = append(details, api.ValidationDetail{Field: "email", Message: "Must be a valid email address"})
	} else {
		email := strings.TrimSpace(*body.Email)
		parsed, err := mail.ParseAddress(email)
		if err != nil || utf8.RuneCountInString(email) > 254 || parsed.Address != email {
			details = append(details, api.ValidationDetail{Field: "email", Message: "Must be a valid email address"})
		} else {
			body.Email = &email
		}
	}

	if len(body.Password) < 8 || len(body.Password) > 72 {
		details = append(details, api.ValidationDetail{Field: "password", Message: "Must be 8-72 bytes"})
	}
	if len(details) > 0 {
		return api.ValidationError(details)
	}
	return nil
}

func Login(deps HandlerDependencies) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body loginRequest
		if err := decodeAuthRequest(w, r, &body); err != nil {
			api.HandleError(w, r, err)
			return
		}
		if err := rateLimitAuth(r, body.Login); err != nil {
			api.HandleError(w, r, err)
			return
		}
		user, err := deps.AuthenticateUser(r.Context(), body.Login, body.Password)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		if deps.SetSession != nil {
			if err := deps.SetSession(w, user.ID); err != nil {
				api.HandleError(w, r, err)
				return
			}
		}
		api.OK(w, r, issuedSessionResponse(w, user), nil)
	})
}

func decodeAuthRequest(w http.ResponseWriter, r *http.Request, body any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxAuthJSONBodyBytes)
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(body); err != nil {
		return authJSONError(err)
	}
	var extra struct{}
	if err := decoder.Decode(&extra); err != io.EOF {
		return authJSONError(err)
	}
	return nil
}

func authJSONError(err error) error {
	var maxBytesErr *http.MaxBytesError
	if errors.As(err, &maxBytesErr) {
		return api.NewError(http.StatusRequestEntityTooLarge, "REQUEST_TOO_LARGE", "Request body is too large", nil)
	}
	return api.NewError(http.StatusBadRequest, "INVALID_JSON", "Request body must be valid JSON", nil)
}

func rateLimitAuth(r *http.Request, identity string) error {
	rdb := redisx.Client()
	if rdb == nil {
		return authRateLimitUnavailable()
	}
	address := r.RemoteAddr
	if host, _, err := net.SplitHostPort(address); err == nil {
		address = host
	}
	if address == "" {
		address = "unknown"
	}
	normalizedIdentity := strings.ToLower(strings.TrimSpace(identity))
	ipLimit := int64(authIPRateLimit)
	if normalizedIdentity == "" {
		ipLimit = authRateLimit
	}
	result, err := redisx.IncrementRateLimit(r.Context(), rdb, redisx.RedisKey("rate-limit", "auth", r.URL.Path, "ip", address), ipLimit, authRateLimitWindow)
	if err != nil {
		return authRateLimitUnavailable()
	}
	if !result.Allowed {
		return api.NewError(http.StatusTooManyRequests, "RATE_LIMITED", "Too many authentication attempts", nil)
	}
	if normalizedIdentity != "" {
		digest := sha256.Sum256([]byte(normalizedIdentity))
		result, err = redisx.IncrementRateLimit(r.Context(), rdb, redisx.RedisKey("rate-limit", "auth", r.URL.Path, "identity", hex.EncodeToString(digest[:])), authRateLimit, authRateLimitWindow)
		if err != nil {
			return authRateLimitUnavailable()
		}
		if !result.Allowed {
			return api.NewError(http.StatusTooManyRequests, "RATE_LIMITED", "Too many authentication attempts", nil)
		}
	}
	return nil
}

func authRateLimitUnavailable() *api.Error {
	return api.NewError(http.StatusServiceUnavailable, "AUTH_RATE_LIMIT_UNAVAILABLE", "Authentication service is temporarily unavailable", nil)
}

func Logout(deps HandlerDependencies) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if deps.ClearSession != nil {
			if err := deps.ClearSession(w, r); err != nil {
				api.HandleError(w, r, err)
				return
			}
		}
		api.NoContent(w, r)
	})
}

func Me(deps HandlerDependencies) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, err := deps.CurrentUser(r)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		api.OK(w, r, user, nil)
	})
}

func RequireUser(r *http.Request, resolve CurrentUserResolver) (*User, error) {
	user, err := resolve(r)
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
