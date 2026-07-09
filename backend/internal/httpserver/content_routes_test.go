package httpserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"openwook/internal/api"
	"openwook/internal/auth"
)

func TestNewServerRegistersContentRoutes(t *testing.T) {
	handler := newContentServerUnderTest(t, ContentHandlers{
		Banks:                    contentRouteHandler("banks"),
		BankGet:                  contentRouteHandler("bank-get", "bankId"),
		BankUpdate:               contentRouteHandler("bank-update", "bankId"),
		BankDelete:               contentRouteHandler("bank-delete", "bankId"),
		BankItems:                contentRouteHandler("bank-items", "bankId"),
		BankItemsReorder:         contentRouteHandler("bank-items-reorder", "bankId"),
		BankFavoriteCreate:       contentRouteHandler("bank-favorite-create", "bankId"),
		BankFavoriteDelete:       contentRouteHandler("bank-favorite-delete", "bankId"),
		BankQuestionCreate:       contentRouteHandler("bank-question-create", "bankId"),
		BankGroupCreate:          contentRouteHandler("bank-group-create", "bankId"),
		QuestionGet:              contentRouteHandler("question-get", "questionId"),
		QuestionUpdate:           contentRouteHandler("question-update", "questionId"),
		QuestionDelete:           contentRouteHandler("question-delete", "questionId"),
		QuestionPublish:          contentRouteHandler("question-publish", "questionId"),
		QuestionArchive:          contentRouteHandler("question-archive", "questionId"),
		QuestionOptionCreate:     contentRouteHandler("question-option-create", "questionId"),
		QuestionOptionUpdate:     contentRouteHandler("question-option-update", "questionId", "optionId"),
		QuestionAnswerKeyPut:     contentRouteHandler("question-answer-key-put", "questionId"),
		QuestionMetadataPut:      contentRouteHandler("question-metadata-put", "questionId"),
		QuestionKnowledgePut:     contentRouteHandler("question-knowledge-put", "questionId"),
		QuestionContentBlocksPut: contentRouteHandler("question-content-blocks-put", "questionId"),
		GroupGet:                 contentRouteHandler("group-get", "groupId"),
		GroupUpdate:              contentRouteHandler("group-update", "groupId"),
		GroupQuestionCreate:      contentRouteHandler("group-question-create", "groupId"),
		GroupQuestionsReorder:    contentRouteHandler("group-questions-reorder", "groupId"),
		GroupQuestionDelete:      contentRouteHandler("group-question-delete", "groupId", "questionId"),
	})

	tests := []struct {
		name      string
		method    string
		target    string
		wantRoute string
	}{
		{name: "banks root", method: http.MethodGet, target: "/api/v1/banks", wantRoute: "banks"},
		{name: "bank get", method: http.MethodGet, target: "/api/v1/banks/12", wantRoute: "bank-get"},
		{name: "bank update", method: http.MethodPatch, target: "/api/v1/banks/12", wantRoute: "bank-update"},
		{name: "bank delete", method: http.MethodDelete, target: "/api/v1/banks/12", wantRoute: "bank-delete"},
		{name: "bank items", method: http.MethodGet, target: "/api/v1/banks/12/items", wantRoute: "bank-items"},
		{name: "bank items reorder", method: http.MethodPatch, target: "/api/v1/banks/12/items/reorder", wantRoute: "bank-items-reorder"},
		{name: "bank favorite create", method: http.MethodPost, target: "/api/v1/banks/12/favorite", wantRoute: "bank-favorite-create"},
		{name: "bank favorite delete", method: http.MethodDelete, target: "/api/v1/banks/12/favorite", wantRoute: "bank-favorite-delete"},
		{name: "bank question create", method: http.MethodPost, target: "/api/v1/banks/12/questions", wantRoute: "bank-question-create"},
		{name: "bank group create", method: http.MethodPost, target: "/api/v1/banks/12/groups", wantRoute: "bank-group-create"},
		{name: "question get", method: http.MethodGet, target: "/api/v1/questions/7", wantRoute: "question-get"},
		{name: "question update", method: http.MethodPatch, target: "/api/v1/questions/7", wantRoute: "question-update"},
		{name: "question delete", method: http.MethodDelete, target: "/api/v1/questions/7", wantRoute: "question-delete"},
		{name: "question publish", method: http.MethodPost, target: "/api/v1/questions/7/publish", wantRoute: "question-publish"},
		{name: "question archive", method: http.MethodPost, target: "/api/v1/questions/7/archive", wantRoute: "question-archive"},
		{name: "question option create", method: http.MethodPost, target: "/api/v1/questions/7/options", wantRoute: "question-option-create"},
		{name: "question option update", method: http.MethodPatch, target: "/api/v1/questions/7/options/8", wantRoute: "question-option-update"},
		{name: "question answer key put", method: http.MethodPut, target: "/api/v1/questions/7/answer-key", wantRoute: "question-answer-key-put"},
		{name: "question metadata put", method: http.MethodPut, target: "/api/v1/questions/7/metadata", wantRoute: "question-metadata-put"},
		{name: "question knowledge put", method: http.MethodPut, target: "/api/v1/questions/7/knowledge-points", wantRoute: "question-knowledge-put"},
		{name: "question content blocks put", method: http.MethodPut, target: "/api/v1/questions/7/content-blocks", wantRoute: "question-content-blocks-put"},
		{name: "group get", method: http.MethodGet, target: "/api/v1/groups/9", wantRoute: "group-get"},
		{name: "group update", method: http.MethodPatch, target: "/api/v1/groups/9", wantRoute: "group-update"},
		{name: "group question create", method: http.MethodPost, target: "/api/v1/groups/9/questions", wantRoute: "group-question-create"},
		{name: "group questions reorder", method: http.MethodPatch, target: "/api/v1/groups/9/questions/reorder", wantRoute: "group-questions-reorder"},
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
		{name: "question knowledge validation", method: http.MethodPut, target: "/api/v1/questions/7/knowledge-points", body: `{"knowledgePointIds":[1,0]}`, wantStatus: http.StatusUnprocessableEntity, wantCode: "VALIDATION_ERROR", wantMsg: "Invalid request"},
		{name: "group reorder validation", method: http.MethodPatch, target: "/api/v1/groups/9/questions/reorder", body: `{"items":[{"questionId":0,"sortOrder":1}]}`, wantStatus: http.StatusUnprocessableEntity, wantCode: "VALIDATION_ERROR", wantMsg: "Invalid request"},
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

func contentRouteHandler(route string, pathValueNames ...string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data := map[string]any{"route": route}
		for _, name := range pathValueNames {
			data[name] = r.PathValue(name)
		}
		api.OK(w, r, data, nil)
	})
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
