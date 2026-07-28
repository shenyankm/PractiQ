package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestEmailCodeStoresCodeAndSendsEmail(t *testing.T) {
	server := useAuthRateLimitRedis(t)
	var sentEmail, sentCode string
	originalSend := sendEmailCode
	sendEmailCode = func(email string, code string) error {
		sentEmail, sentCode = email, code
		return nil
	}
	t.Cleanup(func() { sendEmailCode = originalSend })

	rr := httptest.NewRecorder()
	req := authRequestWithID(t, http.MethodPost, "/api/v1/auth/email-code", `{"email":"alice@example.com"}`, "req-email-code")
	EmailCode().ServeHTTP(rr, req)

	if rr.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d (body=%s)", rr.Code, http.StatusNoContent, rr.Body.String())
	}
	if sentEmail != "alice@example.com" || len(sentCode) != 6 {
		t.Fatalf("sent = (%q, %q), want alice@example.com and a 6-digit code", sentEmail, sentCode)
	}
	stored, err := server.Get(emailCodeKey("alice@example.com"))
	if err != nil || stored != sentCode {
		t.Fatalf("stored code = (%q, %v), want %q", stored, err, sentCode)
	}
	if ttl := server.TTL(emailCodeKey("alice@example.com")); ttl <= 0 || ttl > emailCodeTTL {
		t.Fatalf("code TTL = %s, want within %s", ttl, emailCodeTTL)
	}
}

func TestRegisterRejectsWrongCodeAndConsumesCodeOnSuccess(t *testing.T) {
	server := useAuthRateLimitRedis(t)
	seedEmailCode(t, server, "alice@example.com", "123456")

	handler := Register(HandlerDependencies{
		RegisterUser: func(context.Context, string, *string, string) (*User, error) {
			return &User{ID: 41, Username: "alice", IsActive: true, Membership: "free"}, nil
		},
	})
	registerBody := func(code string) string {
		return fmt.Sprintf(`{"username":"alice","email":"alice@example.com","password":"correct horse battery staple","code":"%s"}`, code)
	}

	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, authRequestWithID(t, http.MethodPost, "/api/v1/auth/register", registerBody("000000"), "req-wrong-code"))
	assertAuthErrorEnvelope(t, rr, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "Invalid request", "req-wrong-code")

	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, authRequestWithID(t, http.MethodPost, "/api/v1/auth/register", registerBody("123456"), "req-good-code"))
	if rr.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d (body=%s)", rr.Code, http.StatusCreated, rr.Body.String())
	}

	// The code is single-use: replaying the same registration must fail.
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, authRequestWithID(t, http.MethodPost, "/api/v1/auth/register", registerBody("123456"), "req-replayed-code"))
	assertAuthErrorEnvelope(t, rr, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "Invalid request", "req-replayed-code")
}

func TestGoogleStartRedirectsWithStateCookieOrReturnsDisabled(t *testing.T) {
	t.Setenv("GOOGLE_CLIENT_ID", "")
	rr := httptest.NewRecorder()
	GoogleStart().ServeHTTP(rr, authRequestWithID(t, http.MethodGet, "/api/v1/auth/google/start", "", "req-google-disabled"))
	assertAuthErrorEnvelope(t, rr, http.StatusNotFound, "GOOGLE_AUTH_DISABLED", "Google sign-in is not configured", "req-google-disabled")

	t.Setenv("GOOGLE_CLIENT_ID", "web-client-id")
	t.Setenv("APP_ORIGIN", "https://app.example.test")
	rr = httptest.NewRecorder()
	GoogleStart().ServeHTTP(rr, authRequestWithID(t, http.MethodGet, "/api/v1/auth/google/start", "", "req-google-start"))
	if rr.Code != http.StatusFound {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusFound)
	}
	location := rr.Header().Get("Location")
	if !strings.Contains(location, "client_id=web-client-id") || !strings.Contains(location, "redirect_uri=https%3A%2F%2Fapp.example.test%2Fapi%2Fv1%2Fauth%2Fgoogle%2Fcallback") {
		t.Fatalf("Location = %q, want client_id and redirect_uri", location)
	}
	var stateCookie *http.Cookie
	for _, cookie := range rr.Result().Cookies() {
		if cookie.Name == googleStateCookieName {
			stateCookie = cookie
		}
	}
	if stateCookie == nil || stateCookie.Value == "" || !stateCookie.HttpOnly {
		t.Fatalf("state cookie = %#v, want non-empty HttpOnly cookie", stateCookie)
	}
	if !strings.Contains(location, "state="+stateCookie.Value) {
		t.Fatalf("Location = %q, want state matching cookie %q", location, stateCookie.Value)
	}
}

func TestGoogleCallbackRejectsStateMismatch(t *testing.T) {
	t.Setenv("GOOGLE_CLIENT_ID", "web-client-id")
	handler := GoogleCallback(HandlerDependencies{
		GoogleUser: func(context.Context, GoogleClaims) (*User, error) {
			t.Fatal("GoogleUser should not be called")
			return nil, nil
		},
	})

	rr := httptest.NewRecorder()
	req := authRequestWithID(t, http.MethodGet, "/api/v1/auth/google/callback?state=forged&code=abc", "", "req-google-state")
	req.AddCookie(&http.Cookie{Name: googleStateCookieName, Value: "expected"})
	handler.ServeHTTP(rr, req)
	assertAuthErrorEnvelope(t, rr, http.StatusUnauthorized, "GOOGLE_AUTH_FAILED", "Google sign-in failed", "req-google-state")
}

func googleTokeninfoStub(t *testing.T, payload map[string]string) {
	t.Helper()
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(payload)
	}))
	t.Cleanup(stub.Close)
	original := googleTokeninfoURL
	googleTokeninfoURL = stub.URL
	t.Cleanup(func() { googleTokeninfoURL = original })
}

func TestGoogleTokenRejectsAudienceMismatch(t *testing.T) {
	useAuthRateLimitRedis(t)
	t.Setenv("GOOGLE_CLIENT_ID", "web-client-id")
	t.Setenv("GOOGLE_MOBILE_CLIENT_IDS", "android-id, ios-id")
	googleTokeninfoStub(t, map[string]string{
		"aud":            "attacker-client-id",
		"iss":            "https://accounts.google.com",
		"sub":            "google-sub-1",
		"email":          "alice@example.com",
		"email_verified": "true",
		"exp":            fmt.Sprintf("%d", time.Now().Add(time.Hour).Unix()),
	})

	handler := GoogleToken(HandlerDependencies{
		GoogleUser: func(context.Context, GoogleClaims) (*User, error) {
			t.Fatal("GoogleUser should not be called")
			return nil, nil
		},
	})
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, authRequestWithID(t, http.MethodPost, "/api/v1/auth/google/token", `{"idToken":"fake"}`, "req-google-aud"))
	assertAuthErrorEnvelope(t, rr, http.StatusUnauthorized, "GOOGLE_AUTH_FAILED", "Google sign-in failed", "req-google-aud")
}

func TestGoogleTokenSignsInVerifiedMobileUser(t *testing.T) {
	useAuthRateLimitRedis(t)
	t.Setenv("GOOGLE_CLIENT_ID", "web-client-id")
	t.Setenv("GOOGLE_MOBILE_CLIENT_IDS", "android-id")
	googleTokeninfoStub(t, map[string]string{
		"aud":            "android-id",
		"iss":            "accounts.google.com",
		"sub":            "google-sub-1",
		"email":          "alice@example.com",
		"email_verified": "true",
		"exp":            fmt.Sprintf("%d", time.Now().Add(time.Hour).Unix()),
	})

	email := "alice@example.com"
	var gotClaims GoogleClaims
	handler := GoogleToken(HandlerDependencies{
		GoogleUser: func(_ context.Context, claims GoogleClaims) (*User, error) {
			gotClaims = claims
			return &User{ID: 41, Username: "alice", Email: &email, IsActive: true, Membership: "free"}, nil
		},
		SetSession: func(w http.ResponseWriter, userID int) error {
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "google-token", Path: "/", HttpOnly: true})
			return nil
		},
	})
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, authRequestWithID(t, http.MethodPost, "/api/v1/auth/google/token", `{"idToken":"fake"}`, "req-google-ok"))

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (body=%s)", rr.Code, http.StatusOK, rr.Body.String())
	}
	if gotClaims != (GoogleClaims{Sub: "google-sub-1", Email: "alice@example.com", EmailVerified: true}) {
		t.Fatalf("claims = %#v, want verified alice claims", gotClaims)
	}
	body := decodeAuthJSONBody(t, rr.Body.Bytes())
	assertEnvelopeUser(t, body, map[string]any{
		"id":       float64(41),
		"username": "alice",
		"token":    "google-token",
	})
}

func TestGoogleUsernameProducesValidUsernames(t *testing.T) {
	for _, email := range []string{"alice@example.com", "a.b-c+tag@example.com", "北京用户@example.com", "verylongaddresslocalpart@example.com"} {
		username := googleUsername(email)
		if detail := usernameValidationDetail(username); detail != nil {
			t.Fatalf("googleUsername(%q) = %q, fails validation: %s", email, username, detail.Message)
		}
	}
}
