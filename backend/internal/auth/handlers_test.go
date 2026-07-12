package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"openwook/internal/api"
)

func TestRegisterCreatesUserSetsSessionCookieAndReturnsCreatedEnvelope(t *testing.T) {
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
	req := authRequestWithID(t, http.MethodPost, "/api/v1/auth/register", `{"username":"alice","email":"alice@example.com","password":"correct horse battery staple"}`, "req-register-123")

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
	})
	assertMetaRequestID(t, body, "req-login-456")
}

func TestLoginReturnsUSERINACTIVEWhenAuthenticatedUserIsDisabled(t *testing.T) {
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
		handler := Register(HandlerDependencies{
			RegisterUser: func(context.Context, string, *string, string) (*User, error) {
				return &User{ID: 41, Username: "alice", IsActive: true, Membership: "free"}, nil
			},
			SetSession: func(http.ResponseWriter, int) error {
				return api.NewError(http.StatusInternalServerError, "SESSION_ERROR", "Could not create session", nil)
			},
		})

		rr := httptest.NewRecorder()
		req := authRequestWithID(t, http.MethodPost, "/api/v1/auth/register", `{"username":"alice","email":"alice@example.com","password":"correct horse battery staple"}`, "req-register-session-error")

		handler.ServeHTTP(rr, req)

		assertAuthErrorEnvelope(t, rr, http.StatusInternalServerError, "SESSION_ERROR", "Could not create session", "req-register-session-error")
	})
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

func TestMeReturnsCurrentUserEnvelopeOrNull(t *testing.T) {
	email := "alice@example.com"
	tests := []struct {
		name        string
		currentUser func(*http.Request) (*User, error)
		wantData    any
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
		},
		{
			name: "null user",
			currentUser: func(*http.Request) (*User, error) {
				return nil, nil
			},
			wantData: nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			handler := Me(HandlerDependencies{CurrentUser: tt.currentUser})

			rr := httptest.NewRecorder()
			req := authRequestWithID(t, http.MethodGet, "/api/v1/auth/me", "", "req-me-321")

			handler.ServeHTTP(rr, req)

			if rr.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d", rr.Code, http.StatusOK)
			}

			body := decodeAuthJSONBody(t, rr.Body.Bytes())
			if tt.wantData == nil {
				if _, ok := body["data"]; !ok {
					t.Fatalf("body = %#v, want data key", body)
				}
				if body["data"] != nil {
					t.Fatalf("data = %#v, want null", body["data"])
				}
			} else {
				assertEnvelopeUser(t, body, tt.wantData.(map[string]any))
			}
			assertMetaRequestID(t, body, "req-me-321")
		})
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
