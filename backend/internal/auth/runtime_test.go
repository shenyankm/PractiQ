package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/jackc/pgx/v5/pgxpool"
	"openwook/internal/api"
)

func TestSetSessionIssuesRevocableJTIAndClearSessionRevokesIt(t *testing.T) {
	t.Setenv("NODE_ENV", "test")
	t.Setenv("AUTH_SECRET", "runtime-secret")
	server := useAuthRedis(t)

	setRecorder := httptest.NewRecorder()
	if err := SetSession(setRecorder, 41); err != nil {
		t.Fatalf("SetSession returned error: %v", err)
	}

	sessionCookie := findSessionCookie(t, setRecorder.Result().Cookies())
	payload, err := VerifySessionToken(sessionCookie.Value)
	if err != nil {
		t.Fatalf("VerifySessionToken returned error: %v", err)
	}
	if strings.TrimSpace(payload.JTI) == "" {
		t.Fatal("SetSession must issue a non-empty jti so logout can revoke the session")
	}

	clearRecorder := httptest.NewRecorder()
	clearRequest := httptest.NewRequest(http.MethodPost, "https://app.example.test/api/v1/auth/logout", nil)
	clearRequest.AddCookie(sessionCookie)
	if err := ClearSession(clearRecorder, clearRequest); err != nil {
		t.Fatalf("ClearSession returned error: %v", err)
	}

	clearedCookie := findSessionCookie(t, clearRecorder.Result().Cookies())
	if clearedCookie.Value != "" {
		t.Fatalf("cleared session cookie value = %q, want empty", clearedCookie.Value)
	}
	if got := clearRecorder.Header().Get("Set-Cookie"); !strings.Contains(got, "Max-Age=0") {
		t.Fatalf("Set-Cookie = %q, want Max-Age=0", got)
	}

	key := sessionRevocationKey(payload.JTI)
	if raw, err := server.Get(key); err != nil || raw != "true" {
		t.Fatalf("revocation entry = (%q, %v), want (true, nil)", raw, err)
	}
	ttl := server.TTL(key)
	if remaining := time.Until(parseExpiry(payload.Expires)); ttl <= 0 || ttl > remaining+time.Second {
		t.Fatalf("revocation TTL = %s, want positive and bounded by token lifetime %s", ttl, remaining)
	}
	server.FastForward(ttl + time.Nanosecond)
	if server.Exists(key) {
		t.Fatalf("revocation entry %q outlived its TTL", key)
	}
}

func TestSetSessionUsesConfiguredTTLForCookieAndToken(t *testing.T) {
	t.Setenv("NODE_ENV", "test")
	t.Setenv("AUTH_SECRET", "runtime-secret")
	t.Setenv("SESSION_TTL_MS", "120000")

	before := time.Now().UTC()
	recorder := httptest.NewRecorder()
	if err := SetSession(recorder, 41); err != nil {
		t.Fatalf("SetSession returned error: %v", err)
	}
	after := time.Now().UTC()

	cookie := findSessionCookie(t, recorder.Result().Cookies())
	payload, err := VerifySessionToken(cookie.Value)
	if err != nil {
		t.Fatalf("VerifySessionToken returned error: %v", err)
	}
	expiresAt, err := time.Parse(time.RFC3339, payload.Expires)
	if err != nil {
		t.Fatalf("Parse(%q) returned error: %v", payload.Expires, err)
	}
	wantMin := before.Add(2 * time.Minute)
	wantMax := after.Add(2 * time.Minute)
	if expiresAt.Before(wantMin.Add(-2*time.Second)) || expiresAt.After(wantMax.Add(2*time.Second)) {
		t.Fatalf("token expiry = %s, want about 2 minutes from now", expiresAt)
	}
	if !cookie.Expires.Equal(expiresAt) {
		t.Fatalf("cookie expiry = %s, want token expiry %s", cookie.Expires, expiresAt)
	}
}

func TestClearSessionKeepsCookieWhenRevocationCannotBeStored(t *testing.T) {
	t.Setenv("NODE_ENV", "test")
	t.Setenv("AUTH_SECRET", "runtime-secret")
	server := useAuthRedis(t)

	setRecorder := httptest.NewRecorder()
	if err := SetSession(setRecorder, 41); err != nil {
		t.Fatalf("SetSession returned error: %v", err)
	}
	server.SetError("ERR unavailable")

	clearRecorder := httptest.NewRecorder()
	clearRequest := httptest.NewRequest(http.MethodPost, "https://app.example.test/api/v1/auth/logout", nil)
	clearRequest.AddCookie(findSessionCookie(t, setRecorder.Result().Cookies()))
	err := ClearSession(clearRecorder, clearRequest)
	assertSessionStoreUnavailable(t, err)
	if cookies := clearRecorder.Result().Cookies(); len(cookies) != 0 {
		t.Fatalf("ClearSession emitted cookies %#v after failed revocation", cookies)
	}
}

func TestCurrentUserFromRequestFailsClosedWhenRevocationCheckFails(t *testing.T) {
	t.Setenv("NODE_ENV", "test")
	t.Setenv("AUTH_SECRET", "runtime-secret")
	server := useAuthRedis(t)
	server.SetError("ERR unavailable")

	token, err := SignSessionToken(SessionPayload{
		User:    SessionUser{ID: 41},
		Expires: time.Now().UTC().Add(time.Hour).Format(time.RFC3339),
		JTI:     "session-jti",
	})
	if err != nil {
		t.Fatalf("SignSessionToken returned error: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "https://app.example.test/api/v1/auth/me", nil)
	req.AddCookie(&http.Cookie{Name: "session", Value: token})

	user, err := CurrentUserFromRequest(closedPoolForAuthTest(t))(req)
	if user != nil {
		t.Fatalf("CurrentUserFromRequest returned user %#v, want nil", user)
	}
	assertSessionStoreUnavailable(t, err)
}

func useAuthRedis(t *testing.T) *miniredis.Miniredis {
	t.Helper()
	server := miniredis.RunT(t)
	t.Setenv("REDIS_URL", "redis://"+server.Addr()+"/0")
	return server
}

func assertSessionStoreUnavailable(t *testing.T, err error) {
	t.Helper()
	apiErr, ok := err.(*api.Error)
	if !ok {
		t.Fatalf("error = %T (%v), want session-store API error", err, err)
	}
	if apiErr.Status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", apiErr.Status, http.StatusServiceUnavailable)
	}
	if apiErr.Code != "SESSION_STORE_UNAVAILABLE" {
		t.Fatalf("code = %q, want SESSION_STORE_UNAVAILABLE", apiErr.Code)
	}
}

func closedPoolForAuthTest(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), "postgres://localhost:5432/openwook")
	if err != nil {
		t.Fatalf("pgxpool.New returned error: %v", err)
	}
	pool.Close()
	return pool
}

func findSessionCookie(t *testing.T, cookies []*http.Cookie) *http.Cookie {
	t.Helper()
	for _, cookie := range cookies {
		if cookie.Name == "session" {
			return cookie
		}
	}
	t.Fatal("session cookie not found")
	return nil
}
