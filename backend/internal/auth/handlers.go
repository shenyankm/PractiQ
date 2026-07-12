package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/mail"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"
	"openwook/internal/api"
)

const DummyPasswordHash = "$2y$10$bPkUrUZqKDqmW.xkPE5LBuqH6HB/QoOS4dYH42xQxevBJQMStTE0W"
const bcryptCost = 10

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
	Username      string  `json:"username"`
	Email         *string `json:"email"`
	Password      string  `json:"password"`
}

type loginRequest struct {
	Login    string `json:"login"`
	Password string `json:"password"`
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
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			api.HandleError(w, r, api.NewError(http.StatusBadRequest, "INVALID_JSON", "Request body must be valid JSON", nil))
			return
		}
		if err := validateRegisterRequest(&body); err != nil {
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
		api.Created(w, r, user, nil)
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
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			api.HandleError(w, r, api.NewError(http.StatusBadRequest, "INVALID_JSON", "Request body must be valid JSON", nil))
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
		api.OK(w, r, user, nil)
	})
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
