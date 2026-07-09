package httpserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"openwook/internal/api"
	"openwook/internal/auth"
)

func TestNewServerRegistersPracticeAnalyticsAndSearchRoutes(t *testing.T) {
	handler := newPracticeAnalyticsSearchServerUnderTest(t, PracticeHandlers{
		List: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.OK(w, r, map[string]any{"route": "practice-list"}, nil)
		}),
		Start: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.Created(w, r, map[string]any{"route": "practice-start"}, nil)
		}),
		Get: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.OK(w, r, map[string]any{"route": "practice-get"}, nil)
		}),
		QuestionPage: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.OK(w, r, map[string]any{"route": "practice-question-page"}, nil)
		}),
		Questions: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.OK(w, r, map[string]any{"route": "practice-questions"}, nil)
		}),
		Results: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.OK(w, r, map[string]any{"route": "practice-results"}, nil)
		}),
		SubmitAnswer: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.Created(w, r, map[string]any{"route": "practice-answer"}, nil)
		}),
		Complete: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.OK(w, r, map[string]any{"route": "practice-complete"}, nil)
		}),
		Abandon: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.OK(w, r, map[string]any{"route": "practice-abandon"}, nil)
		}),
	}, AnalyticsHandlers{
		MeSummary: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.OK(w, r, map[string]any{"route": "analytics-summary"}, nil)
		}),
		MeSnapshot: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.OK(w, r, map[string]any{"route": "analytics-snapshot"}, nil)
		}),
		Bank: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.OK(w, r, map[string]any{"route": "analytics-bank"}, nil)
		}),
		BankLeaderboard: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.OK(w, r, map[string]any{"route": "analytics-bank-leaderboard"}, nil)
		}),
		Import: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.OK(w, r, map[string]any{"route": "analytics-import"}, nil)
		}),
	}, SearchHandlers{
		Kind: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.OK(w, r, map[string]any{"route": "search-kind", "path": r.URL.Path}, nil)
		}),
	})

	tests := []struct {
		name       string
		method     string
		target     string
		body       string
		wantStatus int
		wantRoute  string
	}{
		{name: "practice list", method: http.MethodGet, target: "/api/v1/practice-sessions", wantStatus: http.StatusOK, wantRoute: "practice-list"},
		{name: "practice start", method: http.MethodPost, target: "/api/v1/practice-sessions", body: `{}`, wantStatus: http.StatusCreated, wantRoute: "practice-start"},
		{name: "practice get", method: http.MethodGet, target: "/api/v1/practice-sessions/14", wantStatus: http.StatusOK, wantRoute: "practice-get"},
		{name: "practice question page", method: http.MethodGet, target: "/api/v1/practice-sessions/14/question-page", wantStatus: http.StatusOK, wantRoute: "practice-question-page"},
		{name: "practice questions", method: http.MethodGet, target: "/api/v1/practice-sessions/14/questions", wantStatus: http.StatusOK, wantRoute: "practice-questions"},
		{name: "practice results", method: http.MethodGet, target: "/api/v1/practice-sessions/14/results", wantStatus: http.StatusOK, wantRoute: "practice-results"},
		{name: "practice answer", method: http.MethodPost, target: "/api/v1/practice-sessions/14/answers", body: `{}`, wantStatus: http.StatusCreated, wantRoute: "practice-answer"},
		{name: "practice complete", method: http.MethodPost, target: "/api/v1/practice-sessions/14/complete", body: `{}`, wantStatus: http.StatusOK, wantRoute: "practice-complete"},
		{name: "practice abandon", method: http.MethodPost, target: "/api/v1/practice-sessions/14/abandon", body: `{}`, wantStatus: http.StatusOK, wantRoute: "practice-abandon"},
		{name: "analytics summary", method: http.MethodGet, target: "/api/v1/analytics/me/summary", wantStatus: http.StatusOK, wantRoute: "analytics-summary"},
		{name: "analytics snapshot", method: http.MethodGet, target: "/api/v1/analytics/me/snapshot", wantStatus: http.StatusOK, wantRoute: "analytics-snapshot"},
		{name: "analytics bank", method: http.MethodGet, target: "/api/v1/analytics/banks/8", wantStatus: http.StatusOK, wantRoute: "analytics-bank"},
		{name: "analytics leaderboard", method: http.MethodGet, target: "/api/v1/analytics/banks/8/leaderboard", wantStatus: http.StatusOK, wantRoute: "analytics-bank-leaderboard"},
		{name: "analytics import", method: http.MethodGet, target: "/api/v1/analytics/imports/9", wantStatus: http.StatusOK, wantRoute: "analytics-import"},
		{name: "search kind", method: http.MethodGet, target: "/api/v1/search/questions?q=algebra", wantStatus: http.StatusOK, wantRoute: "search-kind"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rr := httptest.NewRecorder()
			req := httptest.NewRequest(tt.method, "https://app.example.test"+tt.target, strings.NewReader(tt.body))

			handler.ServeHTTP(rr, req)

			if rr.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d", rr.Code, tt.wantStatus)
			}
			body := decodeJSONBody(t, rr.Body.Bytes())
			data := mustObject(t, body["data"], "data")
			if got := data["route"]; got != tt.wantRoute {
				t.Fatalf("route = %#v, want %q", got, tt.wantRoute)
			}
		})
	}
}

func TestBuildPracticeAnalyticsAndSearchHandlersKeepErrorEnvelope(t *testing.T) {
	resolver := func(*http.Request) (*auth.User, error) {
		return &auth.User{ID: 7, Username: "alice", IsActive: true, Membership: "free"}, nil
	}
	handler := newPracticeAnalyticsSearchServerUnderTest(
		t,
		BuildPracticeHandlers(nil, resolver),
		BuildAnalyticsHandlers(nil, resolver),
		BuildSearchHandlers(nil, resolver),
	)

	tests := []struct {
		name       string
		method     string
		target     string
		body       string
		wantStatus int
		wantCode   string
		wantMsg    string
	}{
		{name: "practice start invalid json", method: http.MethodPost, target: "/api/v1/practice-sessions", body: `{`, wantStatus: http.StatusBadRequest, wantCode: "INVALID_JSON", wantMsg: "Request body must be valid JSON"},
		{name: "practice start validation", method: http.MethodPost, target: "/api/v1/practice-sessions", body: `{}`, wantStatus: http.StatusUnprocessableEntity, wantCode: "VALIDATION_ERROR", wantMsg: "Invalid request"},
		{name: "practice session invalid id", method: http.MethodGet, target: "/api/v1/practice-sessions/nope", wantStatus: http.StatusUnprocessableEntity, wantCode: "VALIDATION_ERROR", wantMsg: "Invalid sessionId"},
		{name: "practice answer validation", method: http.MethodPost, target: "/api/v1/practice-sessions/4/answers", body: `{}`, wantStatus: http.StatusUnprocessableEntity, wantCode: "VALIDATION_ERROR", wantMsg: "Invalid request"},
		{name: "analytics bank invalid id", method: http.MethodGet, target: "/api/v1/analytics/banks/nope", wantStatus: http.StatusUnprocessableEntity, wantCode: "VALIDATION_ERROR", wantMsg: "Invalid bankId"},
		{name: "analytics import invalid id", method: http.MethodGet, target: "/api/v1/analytics/imports/nope", wantStatus: http.StatusUnprocessableEntity, wantCode: "VALIDATION_ERROR", wantMsg: "Invalid jobId"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rr := httptest.NewRecorder()
			req := httptest.NewRequest(tt.method, "https://app.example.test"+tt.target, strings.NewReader(tt.body))

			handler.ServeHTTP(rr, req)

			if rr.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d", rr.Code, tt.wantStatus)
			}
			requestID := rr.Header().Get("X-Request-ID")
			if requestID == "" {
				t.Fatal("X-Request-ID header missing")
			}
			body := decodeJSONBody(t, rr.Body.Bytes())
			errorBody := mustObject(t, body["error"], "error")
			if got := errorBody["code"]; got != tt.wantCode {
				t.Fatalf("error.code = %#v, want %q", got, tt.wantCode)
			}
			if got := errorBody["message"]; got != tt.wantMsg {
				t.Fatalf("error.message = %#v, want %q", got, tt.wantMsg)
			}
			if got := errorBody["requestId"]; got != requestID {
				t.Fatalf("error.requestId = %#v, want %q", got, requestID)
			}
		})
	}
}

func TestBuildPracticeAnalyticsAndSearchHandlersRejectUnauthenticatedAndInvalidRoutes(t *testing.T) {
	t.Run("search requires authentication before service", func(t *testing.T) {
		handler := newPracticeAnalyticsSearchServerUnderTest(
			t,
			PracticeHandlers{},
			AnalyticsHandlers{},
			BuildSearchHandlers(nil, func(*http.Request) (*auth.User, error) { return nil, nil }),
		)

		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "https://app.example.test/api/v1/search/questions?q=algebra", nil)

		handler.ServeHTTP(rr, req)

		assertErrorEnvelope(t, rr, http.StatusUnauthorized, "UNAUTHENTICATED", "Authentication required")
	})

	t.Run("practice complete invalid session id", func(t *testing.T) {
		handler := newPracticeAnalyticsSearchServerUnderTest(
			t,
			BuildPracticeHandlers(nil, func(*http.Request) (*auth.User, error) {
				return &auth.User{ID: 7, Username: "alice", IsActive: true, Membership: "free"}, nil
			}),
			AnalyticsHandlers{},
			SearchHandlers{},
		)

		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "https://app.example.test/api/v1/practice-sessions/nope/complete", strings.NewReader(`{}`))

		handler.ServeHTTP(rr, req)

		assertErrorEnvelope(t, rr, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "Invalid sessionId")
	})
}

func newPracticeAnalyticsSearchServerUnderTest(t *testing.T, practice PracticeHandlers, analytics AnalyticsHandlers, search SearchHandlers) http.Handler {
	t.Helper()

	distDir := t.TempDir()
	writeServerTestFile(t, distDir, "index.html", "<!doctype html><html><body>placeholder</body></html>")

	return NewServer(ServerConfig{
		NodeEnv:   "test",
		AppOrigin: "https://app.example.test",
		DistDir:   distDir,
	}, ServerDependencies{
		CheckPostgres: func(context.Context) error {
			return nil
		},
		CheckRedis: func(context.Context) (bool, error) {
			return true, nil
		},
		UptimeSeconds: func() int64 {
			return 1
		},
		Practice:  practice,
		Analytics: analytics,
		Search:    search,
	})
}
