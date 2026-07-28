package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"practiq/internal/api"
)

func TestRegisterCreatesUserSetsSessionCookieAndReturnsCreatedEnvelope(t *testing.T) {
	server := useAuthRateLimitRedis(t)
	seedEmailCode(t, server, "alice@example.com", "123456")
	email := "alice@example.com"
	createdUser := &User{
		ID:         41,
		Username:   "alice",
		Email:      &email,
		IsActive:   true,
		Role:       "user",
		Membership: "free",
	}

	var gotUsername string
	var gotEmail *string
	var gotPassword string
	var sessionUserID int

	handler := Register(HandlerDependencies{
		RegisterUser: func(_ context.Context, username string, email *string, password string) (*User, error) {
			gotUsername = username
			gotEmail = email
			gotPassword = password
			return createdUser, nil
		},
		SetSession: func(w http.ResponseWriter, userID int) error {
			sessionUserID = userID
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "registered-token", Path: "/", HttpOnly: true})
			return nil
		},
	})

	rr := httptest.NewRecorder()
	req := authRequestWithID(t, http.MethodPost, "/api/v1/auth/register", `{"username":"alice","email":"alice@example.com","password":"correct horse battery staple","code":"123456"}`, "req-register-123")

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusCreated)
	}
	if gotUsername != "alice" {
		t.Fatalf("username = %q, want %q", gotUsername, "alice")
	}
	if gotEmail == nil || *gotEmail != email {
		t.Fatalf("email = %#v, want %q", gotEmail, email)
	}
	if gotPassword != "correct horse battery staple" {
		t.Fatalf("password = %q, want original plaintext for hashing", gotPassword)
	}
	if sessionUserID != createdUser.ID {
		t.Fatalf("session user id = %d, want %d", sessionUserID, createdUser.ID)
	}
	assertCookieContains(t, rr, "session=registered-token")

	body := decodeAuthJSONBody(t, rr.Body.Bytes())
	assertEnvelopeUser(t, body, map[string]any{
		"id":         float64(createdUser.ID),
		"username":   createdUser.Username,
		"email":      email,
		"is_active":  true,
		"membership": createdUser.Membership,
		"token":      "registered-token",
	})
	assertMetaRequestID(t, body, "req-register-123")
}

func TestRegisterRejectsInvalidRegistrationDetails(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{name: "invalid username", body: `{"username":"a!","email":"alice@example.com","password":"correct horse battery staple"}`},
		{name: "invalid email", body: `{"username":"alice","email":"not-an-email","password":"correct horse battery staple"}`},
		{name: "email over limit", body: `{"username":"alice","email":"` + strings.Repeat("a", 243) + `@example.com","password":"correct horse battery staple"}`},
		{name: "short password", body: `{"username":"alice","email":"alice@example.com","password":"short"}`},
		{name: "password over byte limit", body: `{"username":"alice","email":"alice@example.com","password":"` + strings.Repeat("中", 25) + `"}`},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			handler := Register(HandlerDependencies{
				RegisterUser: func(context.Context, string, *string, string) (*User, error) {
					t.Fatal("RegisterUser should not be called")
					return nil, nil
				},
			})

			rr := httptest.NewRecorder()
			req := authRequestWithID(t, http.MethodPost, "/api/v1/auth/register", testCase.body, "req-register-validation")

			handler.ServeHTTP(rr, req)

			assertAuthErrorEnvelope(t, rr, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "Invalid request", "req-register-validation")
		})
	}
}

func TestValidateRegisterRequestAccepts72BytePassword(t *testing.T) {
	email := "alice@example.com"
	if err := validateRegisterRequest(&registerRequest{
		Username: "alice",
		Email:    &email,
		Password: strings.Repeat("中", 24),
	}); err != nil {
		t.Fatalf("validateRegisterRequest() error = %v, want nil", err)
	}
}

func TestLoginSetsSessionCookieAndReturnsUserEnvelope(t *testing.T) {
	useAuthRateLimitRedis(t)
	email := "alice@example.com"
	loggedInUser := &User{
		ID:         7,
		Username:   "Alice",
		Email:      &email,
		IsActive:   true,
		Role:       "user",
		Membership: "plus",
	}

	var gotLogin string
	var gotPassword string
	var sessionUserID int

	handler := Login(HandlerDependencies{
		AuthenticateUser: func(_ context.Context, login string, password string) (*User, error) {
			gotLogin = login
			gotPassword = password
			return loggedInUser, nil
		},
		SetSession: func(w http.ResponseWriter, userID int) error {
			sessionUserID = userID
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "login-token", Path: "/", HttpOnly: true})
			return nil
		},
	})

	rr := httptest.NewRecorder()
	req := authRequestWithID(t, http.MethodPost, "/api/v1/auth/login", `{"login":"ALICE@example.com","password":"correct horse battery staple"}`, "req-login-456")

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusOK)
	}
	if gotLogin != "ALICE@example.com" {
		t.Fatalf("login = %q, want original login", gotLogin)
	}
	if gotPassword != "correct horse battery staple" {
		t.Fatalf("password = %q, want original plaintext", gotPassword)
	}
	if sessionUserID != loggedInUser.ID {
		t.Fatalf("session user id = %d, want %d", sessionUserID, loggedInUser.ID)
	}
	assertCookieContains(t, rr, "session=login-token")

	body := decodeAuthJSONBody(t, rr.Body.Bytes())
	assertEnvelopeUser(t, body, map[string]any{
		"id":         float64(loggedInUser.ID),
		"username":   loggedInUser.Username,
		"email":      email,
		"is_active":  true,
		"membership": loggedInUser.Membership,
		"token":      "login-token",
	})
	assertMetaRequestID(t, body, "req-login-456")
}

func TestSessionTokenFromRequestPrefersCookieAndFallsBackToBearer(t *testing.T) {
	bearerOnly := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	bearerOnly.Header.Set("Authorization", "Bearer mobile-token")
	if got := sessionTokenFromRequest(bearerOnly); got != "mobile-token" {
		t.Fatalf("bearer token = %q, want %q", got, "mobile-token")
	}

	both := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	both.AddCookie(&http.Cookie{Name: "session", Value: "cookie-token"})
	both.Header.Set("Authorization", "Bearer mobile-token")
	if got := sessionTokenFromRequest(both); got != "cookie-token" {
		t.Fatalf("token = %q, want cookie to win", got)
	}

	neither := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	neither.Header.Set("Authorization", "Basic something")
	if got := sessionTokenFromRequest(neither); got != "" {
		t.Fatalf("token = %q, want empty", got)
	}
}

func TestLoginReturnsUSERINACTIVEWhenAuthenticatedUserIsDisabled(t *testing.T) {
	useAuthRateLimitRedis(t)
	setSessionCalled := false

	handler := Login(HandlerDependencies{
		AuthenticateUser: func(context.Context, string, string) (*User, error) {
			return nil, api.NewError(http.StatusForbidden, "USER_INACTIVE", "User account is disabled", nil)
		},
		SetSession: func(http.ResponseWriter, int) error {
			setSessionCalled = true
			return nil
		},
	})

	rr := httptest.NewRecorder()
	req := authRequestWithID(t, http.MethodPost, "/api/v1/auth/login", `{"login":"alice","password":"correct horse battery staple"}`, "req-login-inactive")

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusForbidden)
	}
	if setSessionCalled {
		t.Fatal("set session called for inactive user")
	}

	body := decodeAuthJSONBody(t, rr.Body.Bytes())
	errorBody, ok := body["error"].(map[string]any)
	if !ok {
		t.Fatalf("error = %#v, want object", body["error"])
	}
	if got := errorBody["code"]; got != "USER_INACTIVE" {
		t.Fatalf("error.code = %#v, want USER_INACTIVE", got)
	}
	if got := errorBody["message"]; got != "User account is disabled" {
		t.Fatalf("error.message = %#v, want User account is disabled", got)
	}
	if got := errorBody["requestId"]; got != "req-login-inactive" {
		t.Fatalf("error.requestId = %#v, want req-login-inactive", got)
	}
}

func TestAuthHandlersReturnErrorEnvelopeForBadJSONAndSessionFailures(t *testing.T) {
	t.Run("register invalid json", func(t *testing.T) {
		handler := Register(HandlerDependencies{
			RegisterUser: func(context.Context, string, *string, string) (*User, error) {
				t.Fatal("RegisterUser should not be called")
				return nil, nil
			},
		})

		rr := httptest.NewRecorder()
		req := authRequestWithID(t, http.MethodPost, "/api/v1/auth/register", `{`, "req-register-bad-json")

		handler.ServeHTTP(rr, req)

		assertAuthErrorEnvelope(t, rr, http.StatusBadRequest, "INVALID_JSON", "Request body must be valid JSON", "req-register-bad-json")
	})

	t.Run("login invalid json", func(t *testing.T) {
		handler := Login(HandlerDependencies{
			AuthenticateUser: func(context.Context, string, string) (*User, error) {
				t.Fatal("AuthenticateUser should not be called")
				return nil, nil
			},
		})

		rr := httptest.NewRecorder()
		req := authRequestWithID(t, http.MethodPost, "/api/v1/auth/login", `{`, "req-login-bad-json")

		handler.ServeHTTP(rr, req)

		assertAuthErrorEnvelope(t, rr, http.StatusBadRequest, "INVALID_JSON", "Request body must be valid JSON", "req-login-bad-json")
	})

	t.Run("register set session failure", func(t *testing.T) {
		server := useAuthRateLimitRedis(t)
		seedEmailCode(t, server, "alice@example.com", "123456")
		handler := Register(HandlerDependencies{
			RegisterUser: func(context.Context, string, *string, string) (*User, error) {
				return &User{ID: 41, Username: "alice", IsActive: true, Membership: "free"}, nil
			},
			SetSession: func(http.ResponseWriter, int) error {
				return api.NewError(http.StatusInternalServerError, "SESSION_ERROR", "Could not create session", nil)
			},
		})

		rr := httptest.NewRecorder()
		req := authRequestWithID(t, http.MethodPost, "/api/v1/auth/register", `{"username":"alice","email":"alice@example.com","password":"correct horse battery staple","code":"123456"}`, "req-register-session-error")

		handler.ServeHTTP(rr, req)

		assertAuthErrorEnvelope(t, rr, http.StatusInternalServerError, "SESSION_ERROR", "Could not create session", "req-register-session-error")
	})
}

func TestAuthHandlersRejectOversizedJSONBodies(t *testing.T) {
	tests := []struct {
		name    string
		handler http.Handler
		body    string
	}{
		{
			name: "register",
			handler: Register(HandlerDependencies{
				RegisterUser: func(context.Context, string, *string, string) (*User, error) {
					t.Fatal("RegisterUser should not be called")
					return nil, nil
				},
			}),
			body: `{"username":"alice","email":"alice@example.com","password":"correct horse battery staple","padding":"` + strings.Repeat("x", 32*1024) + `"}`,
		},
		{
			name: "login",
			handler: Login(HandlerDependencies{
				AuthenticateUser: func(context.Context, string, string) (*User, error) {
					t.Fatal("AuthenticateUser should not be called")
					return nil, nil
				},
			}),
			body: `{"login":"alice","password":"correct horse battery staple","padding":"` + strings.Repeat("x", 32*1024) + `"}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rr := httptest.NewRecorder()
			req := authRequestWithID(t, http.MethodPost, "/api/v1/auth/"+tt.name, tt.body, "req-oversized-"+tt.name)

			tt.handler.ServeHTTP(rr, req)

			assertAuthErrorEnvelope(t, rr, http.StatusRequestEntityTooLarge, "REQUEST_TOO_LARGE", "Request body is too large", "req-oversized-"+tt.name)
		})
	}
}

func TestAuthHandlersRejectTrailingJSON(t *testing.T) {
	useAuthRateLimitRedis(t)
	handler := Login(HandlerDependencies{
		AuthenticateUser: func(context.Context, string, string) (*User, error) {
			return &User{ID: 7, Username: "alice", IsActive: true, Membership: "free"}, nil
		},
	})

	for _, tt := range []struct {
		name       string
		trailing   string
		wantStatus int
		wantCode   string
	}{
		{name: "second value", trailing: `{}`, wantStatus: http.StatusBadRequest, wantCode: "INVALID_JSON"},
		{name: "oversized second value", trailing: `"` + strings.Repeat("x", 32*1024) + `"`, wantStatus: http.StatusRequestEntityTooLarge, wantCode: "REQUEST_TOO_LARGE"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			rr := httptest.NewRecorder()
			req := authRequestWithID(t, http.MethodPost, "/api/v1/auth/login", `{"login":"alice","password":"correct horse battery staple"}`+tt.trailing, "req-trailing-json")

			handler.ServeHTTP(rr, req)

			assertAuthErrorEnvelope(t, rr, tt.wantStatus, tt.wantCode, map[int]string{
				http.StatusBadRequest:            "Request body must be valid JSON",
				http.StatusRequestEntityTooLarge: "Request body is too large",
			}[tt.wantStatus], "req-trailing-json")
		})
	}
}

func TestAuthHandlersFailClosedWhenRateLimitRedisIsUnavailable(t *testing.T) {
	server := useAuthRateLimitRedis(t)
	server.SetError("ERR unavailable")
	tests := []struct {
		name    string
		handler http.Handler
		body    string
	}{
		{
			name: "register",
			handler: Register(HandlerDependencies{
				RegisterUser: func(context.Context, string, *string, string) (*User, error) {
					t.Fatal("RegisterUser should not be called")
					return nil, nil
				},
			}),
			body: `{"username":"alice","email":"alice@example.com","password":"correct horse battery staple"}`,
		},
		{
			name: "login",
			handler: Login(HandlerDependencies{
				AuthenticateUser: func(context.Context, string, string) (*User, error) {
					t.Fatal("AuthenticateUser should not be called")
					return nil, nil
				},
			}),
			body: `{"login":"alice","password":"correct horse battery staple"}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rr := httptest.NewRecorder()
			req := authRequestWithID(t, http.MethodPost, "/api/v1/auth/"+tt.name, tt.body, "req-rate-limit-"+tt.name)

			tt.handler.ServeHTTP(rr, req)

			assertAuthErrorEnvelope(t, rr, http.StatusServiceUnavailable, "AUTH_RATE_LIMIT_UNAVAILABLE", "Authentication service is temporarily unavailable", "req-rate-limit-"+tt.name)
		})
	}
}

func TestLoginRateLimitsRequestsWithRedis(t *testing.T) {
	useAuthRateLimitRedis(t)
	handler := Login(HandlerDependencies{
		AuthenticateUser: func(context.Context, string, string) (*User, error) {
			return &User{ID: 7, Username: "alice", IsActive: true, Membership: "free"}, nil
		},
	})

	for range 10 {
		rr := httptest.NewRecorder()
		req := authRequestWithID(t, http.MethodPost, "/api/v1/auth/login", `{"login":"alice","password":"correct horse battery staple"}`, "req-rate-limit-ok")
		req.RemoteAddr = "192.0.2.1:1234"
		handler.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("status = %d before limit, want %d", rr.Code, http.StatusOK)
		}
	}

	rr := httptest.NewRecorder()
	req := authRequestWithID(t, http.MethodPost, "/api/v1/auth/login", `{"login":"alice","password":"correct horse battery staple"}`, "req-rate-limit-blocked")
	req.RemoteAddr = "192.0.2.1:1234"
	handler.ServeHTTP(rr, req)
	assertAuthErrorEnvelope(t, rr, http.StatusTooManyRequests, "RATE_LIMITED", "Too many authentication attempts", "req-rate-limit-blocked")
}

func TestLoginRateLimitDoesNotShareBudgetAcrossAccounts(t *testing.T) {
	useAuthRateLimitRedis(t)
	handler := Login(HandlerDependencies{
		AuthenticateUser: func(_ context.Context, login string, _ string) (*User, error) {
			return &User{ID: 7, Username: login, IsActive: true, Membership: "free"}, nil
		},
	})

	for range 10 {
		rr := httptest.NewRecorder()
		req := authRequestWithID(t, http.MethodPost, "/api/v1/auth/login", `{"login":"alice","password":"correct horse battery staple"}`, "req-rate-limit-alice")
		req.RemoteAddr = "192.0.2.1:1234"
		handler.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("alice status = %d before limit, want %d", rr.Code, http.StatusOK)
		}
	}

	rr := httptest.NewRecorder()
	req := authRequestWithID(t, http.MethodPost, "/api/v1/auth/login", `{"login":"bob","password":"correct horse battery staple"}`, "req-rate-limit-bob")
	req.RemoteAddr = "192.0.2.1:1234"
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("bob status = %d, want independent account budget status %d", rr.Code, http.StatusOK)
	}
}

func TestLoginRateLimitCapsRotatingIdentitiesPerAddress(t *testing.T) {
	useAuthRateLimitRedis(t)
	handler := Login(HandlerDependencies{
		AuthenticateUser: func(_ context.Context, login string, _ string) (*User, error) {
			return &User{ID: 7, Username: login, IsActive: true, Membership: "free"}, nil
		},
	})

	for index := range 100 {
		rr := httptest.NewRecorder()
		body := fmt.Sprintf(`{"login":"user-%d","password":"correct horse battery staple"}`, index)
		req := authRequestWithID(t, http.MethodPost, "/api/v1/auth/login", body, "req-rate-limit-rotating")
		req.RemoteAddr = "192.0.2.1:1234"
		handler.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("request %d status = %d before address limit, want %d", index+1, rr.Code, http.StatusOK)
		}
	}

	rr := httptest.NewRecorder()
	req := authRequestWithID(t, http.MethodPost, "/api/v1/auth/login", `{"login":"another-user","password":"correct horse battery staple"}`, "req-rate-limit-rotating-blocked")
	req.RemoteAddr = "192.0.2.1:1234"
	handler.ServeHTTP(rr, req)
	assertAuthErrorEnvelope(t, rr, http.StatusTooManyRequests, "RATE_LIMITED", "Too many authentication attempts", "req-rate-limit-rotating-blocked")
}

func useAuthRateLimitRedis(t *testing.T) *miniredis.Miniredis {
	t.Helper()
	server := miniredis.RunT(t)
	t.Setenv("REDIS_URL", "redis://"+server.Addr()+"/0")
	return server
}

func seedEmailCode(t *testing.T, server *miniredis.Miniredis, email string, code string) {
	t.Helper()
	if err := server.Set(emailCodeKey(email), code); err != nil {
		t.Fatalf("seed email code: %v", err)
	}
}

func TestLogoutClearsSessionCookieAndReturnsNoContent(t *testing.T) {
	clearCalled := false

	handler := Logout(HandlerDependencies{
		ClearSession: func(w http.ResponseWriter, r *http.Request) error {
			clearCalled = true
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "", Path: "/", MaxAge: -1, HttpOnly: true})
			return nil
		},
	})

	rr := httptest.NewRecorder()
	req := authRequestWithID(t, http.MethodPost, "/api/v1/auth/logout", "", "req-logout-789")

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusNoContent)
	}
	if !clearCalled {
		t.Fatal("clear session not called")
	}
	assertCookieContains(t, rr, "session=")
	assertCookieContains(t, rr, "Max-Age=0")
	if body := rr.Body.String(); body != "" {
		t.Fatalf("body = %q, want empty body", body)
	}
	if got := rr.Header().Get("X-Request-ID"); got != "req-logout-789" {
		t.Fatalf("x-request-id = %q, want %q", got, "req-logout-789")
	}
}

func TestMeReturnsCurrentUserOrAuthenticationError(t *testing.T) {
	email := "alice@example.com"
	tests := []struct {
		name        string
		currentUser func(*http.Request) (*User, error)
		wantData    any
		wantStatus  int
	}{
		{
			name: "current user",
			currentUser: func(*http.Request) (*User, error) {
				return &User{
					ID:         9,
					Username:   "alice",
					Email:      &email,
					IsActive:   true,
					Role:       "admin",
					Membership: "enterprise",
				}, nil
			},
			wantData: map[string]any{
				"id":         float64(9),
				"username":   "alice",
				"email":      email,
				"is_active":  true,
				"membership": "enterprise",
			},
			wantStatus: http.StatusOK,
		},
		{
			name: "missing user",
			currentUser: func(*http.Request) (*User, error) {
				return nil, nil
			},
			wantStatus: http.StatusUnauthorized,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			handler := Me(HandlerDependencies{CurrentUser: tt.currentUser})

			rr := httptest.NewRecorder()
			req := authRequestWithID(t, http.MethodGet, "/api/v1/auth/me", "", "req-me-321")

			handler.ServeHTTP(rr, req)

			if rr.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d", rr.Code, tt.wantStatus)
			}

			body := decodeAuthJSONBody(t, rr.Body.Bytes())
			if tt.wantData == nil {
				errorBody, ok := body["error"].(map[string]any)
				if !ok || errorBody["code"] != "UNAUTHENTICATED" {
					t.Fatalf("body = %#v, want UNAUTHENTICATED error", body)
				}
				if errorBody["requestId"] != "req-me-321" {
					t.Fatalf("error.requestId = %#v, want req-me-321", errorBody["requestId"])
				}
			} else {
				assertEnvelopeUser(t, body, tt.wantData.(map[string]any))
				assertMetaRequestID(t, body, "req-me-321")
			}
		})
	}
}

func TestAuthHandlersRejectUnknownFields(t *testing.T) {
	handler := Login(HandlerDependencies{
		AuthenticateUser: func(context.Context, string, string) (*User, error) {
			t.Fatal("AuthenticateUser should not be called")
			return nil, nil
		},
	})
	rr := httptest.NewRecorder()
	req := authRequestWithID(t, http.MethodPost, "/api/v1/auth/login", `{"login":"alice","password":"correct horse battery staple","admin":true}`, "req-unknown-field")

	handler.ServeHTTP(rr, req)

	assertAuthErrorEnvelope(t, rr, http.StatusBadRequest, "INVALID_JSON", "Request body must be valid JSON", "req-unknown-field")
}

func TestValidateUpdateMeRequestPreservesNullableEmail(t *testing.T) {
	input, err := validateUpdateMeRequest(updateMeRequest{Email: json.RawMessage("null")})
	if err != nil || !input.EmailSet || input.Email != nil {
		t.Fatalf("input = %#v, error = %v; want explicitly cleared email", input, err)
	}
	_, err = validateUpdateMeRequest(updateMeRequest{})
	status, code, _, _ := api.ValidationErrorEnvelope(err)
	if status != http.StatusUnprocessableEntity || code != "VALIDATION_ERROR" {
		t.Fatalf("empty update error = (%d, %s), want 422 VALIDATION_ERROR", status, code)
	}
}

func TestRequireUserMapsMissingAndInactiveUsers(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)

	tests := []struct {
		name       string
		resolver   CurrentUserResolver
		wantStatus int
		wantCode   string
		wantMsg    string
	}{
		{
			name: "missing user",
			resolver: func(*http.Request) (*User, error) {
				return nil, nil
			},
			wantStatus: http.StatusUnauthorized,
			wantCode:   "UNAUTHENTICATED",
			wantMsg:    "Authentication required",
		},
		{
			name: "inactive user",
			resolver: func(*http.Request) (*User, error) {
				return &User{ID: 7, IsActive: false}, nil
			},
			wantStatus: http.StatusForbidden,
			wantCode:   "USER_INACTIVE",
			wantMsg:    "User account is disabled",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			user, err := RequireUser(req, tt.resolver)
			if err == nil {
				t.Fatal("RequireUser error = nil, want auth error")
			}
			if user != nil {
				t.Fatalf("user = %#v, want nil", user)
			}

			apiErr, ok := err.(*api.Error)
			if !ok {
				t.Fatalf("error = %T, want *api.Error", err)
			}
			if apiErr.Status != tt.wantStatus {
				t.Fatalf("status = %d, want %d", apiErr.Status, tt.wantStatus)
			}
			if apiErr.Code != tt.wantCode {
				t.Fatalf("code = %q, want %q", apiErr.Code, tt.wantCode)
			}
			if apiErr.Message != tt.wantMsg {
				t.Fatalf("message = %q, want %q", apiErr.Message, tt.wantMsg)
			}
		})
	}
}

func authRequestWithID(t *testing.T, method string, target string, body string, requestID string) *http.Request {
	t.Helper()

	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, reader)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	return req.WithContext(api.WithRequestID(req.Context(), requestID))
}

func decodeAuthJSONBody(t *testing.T, body []byte) map[string]any {
	t.Helper()

	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("json.Unmarshal returned error: %v\nbody=%s", err, string(body))
	}
	return decoded
}

func assertEnvelopeUser(t *testing.T, body map[string]any, want map[string]any) {
	t.Helper()

	data, ok := body["data"].(map[string]any)
	if !ok {
		t.Fatalf("data = %#v, want object", body["data"])
	}
	for key, wantValue := range want {
		if got := data[key]; got != wantValue {
			t.Fatalf("data[%q] = %#v, want %#v", key, got, wantValue)
		}
	}
}

func assertMetaRequestID(t *testing.T, body map[string]any, want string) {
	t.Helper()

	meta, ok := body["meta"].(map[string]any)
	if !ok {
		t.Fatalf("meta = %#v, want object", body["meta"])
	}
	if got := meta["requestId"]; got != want {
		t.Fatalf("meta.requestId = %#v, want %q", got, want)
	}
}

func assertCookieContains(t *testing.T, rr *httptest.ResponseRecorder, want string) {
	t.Helper()

	for _, value := range rr.Result().Header.Values("Set-Cookie") {
		if strings.Contains(value, want) {
			return
		}
	}
	t.Fatalf("set-cookie headers = %#v, want entry containing %q", rr.Result().Header.Values("Set-Cookie"), want)
}

func assertAuthErrorEnvelope(t *testing.T, rr *httptest.ResponseRecorder, wantStatus int, wantCode string, wantMsg string, wantRequestID string) {
	t.Helper()
	if rr.Code != wantStatus {
		t.Fatalf("status = %d, want %d", rr.Code, wantStatus)
	}
	body := decodeAuthJSONBody(t, rr.Body.Bytes())
	errorBody, ok := body["error"].(map[string]any)
	if !ok {
		t.Fatalf("error = %#v, want object", body["error"])
	}
	if got := errorBody["code"]; got != wantCode {
		t.Fatalf("error.code = %#v, want %q", got, wantCode)
	}
	if got := errorBody["message"]; got != wantMsg {
		t.Fatalf("error.message = %#v, want %q", got, wantMsg)
	}
	if got := errorBody["requestId"]; got != wantRequestID {
		t.Fatalf("error.requestId = %#v, want %q", got, wantRequestID)
	}
}
