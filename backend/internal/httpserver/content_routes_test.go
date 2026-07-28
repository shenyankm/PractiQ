package httpserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"practiq/internal/auth"
)

func TestBuildContentHandlersKeepsErrorEnvelopeForPathParsing(t *testing.T) {
	handler := newContentServerUnderTest(t, BuildContentHandlers(nil, func(*http.Request) (*auth.User, error) {
		return &auth.User{ID: 7, Username: "alice", IsActive: true, Membership: "free"}, nil
	}))

	tests := []struct {
		name       string
		method     string
		target     string
		wantStatus int
		wantCode   string
		wantMsg    string
	}{
		{name: "invalid bank id", method: http.MethodGet, target: "/api/v1/banks/nope", wantStatus: http.StatusUnprocessableEntity, wantCode: "VALIDATION_ERROR", wantMsg: "Invalid bankId"},
		{name: "invalid page limit", method: http.MethodGet, target: "/api/v1/banks?limit=nope", wantStatus: http.StatusUnprocessableEntity, wantCode: "VALIDATION_ERROR", wantMsg: "Invalid request"},
		{name: "unknown question subpath", method: http.MethodPost, target: "/api/v1/questions/7/unknown", wantStatus: http.StatusNotFound, wantCode: "NOT_FOUND", wantMsg: "Endpoint not found"},
		{name: "invalid group question id", method: http.MethodDelete, target: "/api/v1/groups/5/questions/nope", wantStatus: http.StatusUnprocessableEntity, wantCode: "VALIDATION_ERROR", wantMsg: "Invalid questionId"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rr := httptest.NewRecorder()
			req := httptest.NewRequest(tt.method, "https://app.example.test"+tt.target, nil)

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

func TestBuildContentHandlersRejectInvalidMutationPayloadsBeforeService(t *testing.T) {
	handler := newContentServerUnderTest(t, BuildContentHandlers(nil, func(*http.Request) (*auth.User, error) {
		return &auth.User{ID: 7, Username: "alice", IsActive: true, Membership: "free"}, nil
	}))

	tests := []struct {
		name       string
		method     string
		target     string
		body       string
		wantStatus int
		wantCode   string
		wantMsg    string
	}{
		{name: "bank create validation", method: http.MethodPost, target: "/api/v1/banks", body: `{}`, wantStatus: http.StatusUnprocessableEntity, wantCode: "VALIDATION_ERROR", wantMsg: "Invalid request"},
		{name: "bank reorder validation", method: http.MethodPatch, target: "/api/v1/banks/12/items/reorder", body: `{"items":[{"sortOrder":0}]}`, wantStatus: http.StatusUnprocessableEntity, wantCode: "VALIDATION_ERROR", wantMsg: "Invalid request"},
		{name: "group reorder validation", method: http.MethodPatch, target: "/api/v1/groups/9/questions/reorder", body: `{"items":[{"questionId":0,"sortOrder":1}]}`, wantStatus: http.StatusUnprocessableEntity, wantCode: "VALIDATION_ERROR", wantMsg: "Invalid request"},
		{name: "unknown field", method: http.MethodPatch, target: "/api/v1/banks/12", body: `{"extra":true}`, wantStatus: http.StatusBadRequest, wantCode: "INVALID_JSON", wantMsg: "Request body must be valid JSON"},
		{name: "trailing json", method: http.MethodPatch, target: "/api/v1/groups/9", body: `{} {}`, wantStatus: http.StatusBadRequest, wantCode: "INVALID_JSON", wantMsg: "Request body must be valid JSON"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rr := httptest.NewRecorder()
			req := httptest.NewRequest(tt.method, "https://app.example.test"+tt.target, strings.NewReader(tt.body))

			handler.ServeHTTP(rr, req)

			assertErrorEnvelope(t, rr, tt.wantStatus, tt.wantCode, tt.wantMsg)
		})
	}
}

func newContentServerUnderTest(t *testing.T, handlers ContentHandlers) http.Handler {
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
		Content: handlers,
	})
}
