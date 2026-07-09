package auth

import (
	"context"
	"encoding/json"
	"net/http"

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
	Username string  `json:"username"`
	Email    *string `json:"email"`
	Password string  `json:"password"`
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
