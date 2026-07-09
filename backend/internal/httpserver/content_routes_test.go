package httpserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"openwook/internal/api"
	"openwook/internal/auth"
)

func TestNewServerRegistersContentRoutes(t *testing.T) {
	handler := newContentServerUnderTest(t, ContentHandlers{
		Banks: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.OK(w, r, map[string]any{"route": "banks"}, nil)
		}),
		BankItems: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.OK(w, r, map[string]any{"route": "bank-items", "bankId": r.PathValue("bankId")}, nil)
		}),
		QuestionGet: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.OK(w, r, map[string]any{"route": "question-get", "questionId": r.PathValue("questionId")}, nil)
		}),
		GroupQuestionDelete: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.OK(w, r, map[string]any{"route": "group-question-delete", "groupId": r.PathValue("groupId"), "questionId": r.PathValue("questionId")}, nil)
		}),
	})

	tests := []struct {
		name      string
		method    string
		target    string
		wantRoute string
	}{
		{name: "banks root", method: http.MethodGet, target: "/api/v1/banks", wantRoute: "banks"},
		{name: "bank items", method: http.MethodGet, target: "/api/v1/banks/12/items", wantRoute: "bank-items"},
		{name: "question get", method: http.MethodGet, target: "/api/v1/questions/7", wantRoute: "question-get"},
		{name: "group question delete", method: http.MethodDelete, target: "/api/v1/groups/9/questions/10", wantRoute: "group-question-delete"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rr := httptest.NewRecorder()
			req := httptest.NewRequest(tt.method, "https://app.example.test"+tt.target, nil)

			handler.ServeHTTP(rr, req)

			if rr.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d", rr.Code, http.StatusOK)
			}
			body := decodeContentJSONBody(t, rr.Body.Bytes())
			data := mustContentObject(t, body["data"], "data")
			if got := data["route"]; got != tt.wantRoute {
				t.Fatalf("route = %#v, want %q", got, tt.wantRoute)
			}
		})
	}
}

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
			body := decodeContentJSONBody(t, rr.Body.Bytes())
			errorBody := mustContentObject(t, body["error"], "error")
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

func newContentServerUnderTest(t *testing.T, handlers ContentHandlers) http.Handler {
	t.Helper()

	distDir := t.TempDir()
	contentWriteServerTestFile(t, distDir, "index.html", "<!doctype html><html><body>placeholder</body></html>")

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
		MetricsHandler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		}),
		UptimeSeconds: func() int64 {
			return 1
		},
		Content: handlers,
	})
}

func contentWriteServerTestFile(t *testing.T, root string, relativePath string, content string) {
	t.Helper()
	fullPath := filepath.Join(root, relativePath)
	if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(fullPath), err)
	}
	if err := os.WriteFile(fullPath, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", fullPath, err)
	}
}

func decodeContentJSONBody(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("unmarshal body: %v", err)
	}
	return decoded
}

func mustContentObject(t *testing.T, raw any, name string) map[string]any {
	t.Helper()
	object, ok := raw.(map[string]any)
	if !ok {
		t.Fatalf("%s = %#v, want object", name, raw)
	}
	return object
}
