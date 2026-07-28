package httpserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"practiq/internal/aiclient"
	"practiq/internal/api"
	"practiq/internal/auth"
)

func TestNewServerRoutesImportMethodsAndPathValues(t *testing.T) {
	handlers := ImportHandlers{
		ImportJobs: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(r.Method))
		}),
		ImportJobAction: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(r.PathValue("jobId") + ":" + r.PathValue("action")))
		}),
		ImportJobChildren: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(r.PathValue("jobId") + ":" + r.PathValue("kind")))
		}),
	}

	tests := []struct {
		method string
		target string
		want   string
	}{
		{method: http.MethodGet, target: "/api/v1/import-jobs", want: http.MethodGet},
		{method: http.MethodPost, target: "/api/v1/import-jobs", want: http.MethodPost},
		{method: http.MethodPost, target: "/api/v1/import-jobs/42/start", want: "42:start"},
		{method: http.MethodGet, target: "/api/v1/import-jobs/42/outputs", want: "42:outputs"},
	}

	handler := newImportsAIAndServerUnderTest(t, handlers, AIHandlers{})
	for _, tt := range tests {
		t.Run(tt.method+" "+tt.target, func(t *testing.T) {
			rr := httptest.NewRecorder()
			req := httptest.NewRequest(tt.method, "https://app.example.test"+tt.target, nil)

			handler.ServeHTTP(rr, req)

			if rr.Code != http.StatusOK || rr.Body.String() != tt.want {
				t.Fatalf("response = (%d, %q), want (200, %q)", rr.Code, rr.Body.String(), tt.want)
			}
		})
	}
}

func TestBuildImportHandlersRejectInvalidRequestsBeforeService(t *testing.T) {
	resolver := func(*http.Request) (*auth.User, error) {
		return &auth.User{ID: 7, Username: "alice", IsActive: true}, nil
	}
	handlers := BuildImportHandlers(nil, resolver)

	tests := []struct {
		name       string
		handler    http.Handler
		method     string
		target     string
		body       string
		pathValues map[string]string
		wantStatus int
		wantCode   string
		wantMsg    string
	}{
		{name: "create job invalid json", handler: handlers.ImportJobs, method: http.MethodPost, target: "/api/v1/import-jobs", body: `{`, wantStatus: http.StatusBadRequest, wantCode: "INVALID_JSON", wantMsg: "Request body must be valid JSON"},
		{name: "create job unknown field", handler: handlers.ImportJobs, method: http.MethodPost, target: "/api/v1/import-jobs", body: `{"extra":true}`, wantStatus: http.StatusBadRequest, wantCode: "INVALID_JSON", wantMsg: "Request body must be valid JSON"},
		{name: "create job trailing json", handler: handlers.ImportJobs, method: http.MethodPost, target: "/api/v1/import-jobs", body: `{} {}`, wantStatus: http.StatusBadRequest, wantCode: "INVALID_JSON", wantMsg: "Request body must be valid JSON"},
		{name: "create job service validation", handler: handlers.ImportJobs, method: http.MethodPost, target: "/api/v1/import-jobs", body: `{"sourceType":"xls"}`, wantStatus: http.StatusBadRequest, wantCode: "UNSUPPORTED_SOURCE_TYPE", wantMsg: "Only txt, docx, pdf, and xlsx imports are supported"},
		{name: "get job invalid id", handler: handlers.ImportJob, method: http.MethodGet, target: "/api/v1/import-jobs/nope", pathValues: map[string]string{"jobId": "nope"}, wantStatus: http.StatusUnprocessableEntity, wantCode: "VALIDATION_ERROR", wantMsg: "Invalid jobId"},
		{name: "unsupported artifact type", handler: handlers.ImportJobFile, method: http.MethodPost, target: "/api/v1/import-jobs/42/file", body: `{"artifactType":"metadata","content":{"text":"question"}}`, pathValues: map[string]string{"jobId": "42"}, wantStatus: http.StatusUnprocessableEntity, wantCode: "VALIDATION_ERROR", wantMsg: "Invalid request"},
		{name: "unknown job action", handler: handlers.ImportJobAction, method: http.MethodPost, target: "/api/v1/import-jobs/42/nope", pathValues: map[string]string{"jobId": "42", "action": "nope"}, wantStatus: http.StatusNotFound, wantCode: "NOT_FOUND", wantMsg: "Endpoint not found"},
		{name: "invalid child kind", handler: handlers.ImportJobChildren, method: http.MethodGet, target: "/api/v1/import-jobs/42/nope", pathValues: map[string]string{"jobId": "42", "kind": "nope"}, wantStatus: http.StatusUnprocessableEntity, wantCode: "VALIDATION_ERROR", wantMsg: "Invalid request"},
		{name: "removed review child kind", handler: handlers.ImportJobChildren, method: http.MethodGet, target: "/api/v1/import-jobs/42/review-items", pathValues: map[string]string{"jobId": "42", "kind": "review-items"}, wantStatus: http.StatusUnprocessableEntity, wantCode: "VALIDATION_ERROR", wantMsg: "Invalid request"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rr := httptest.NewRecorder()
			req := httptest.NewRequest(tt.method, "https://app.example.test"+tt.target, strings.NewReader(tt.body))
			for key, value := range tt.pathValues {
				req.SetPathValue(key, value)
			}

			RequestID(tt.handler).ServeHTTP(rr, req)

			assertErrorEnvelope(t, rr, tt.wantStatus, tt.wantCode, tt.wantMsg)
		})
	}
}

func TestBuildAIHandlersRejectUnauthenticatedAndInvalidPayloads(t *testing.T) {
	t.Run("route requires authentication before AI client", func(t *testing.T) {
		handler := BuildAIHandlers(nil, func(*http.Request) (*auth.User, error) { return nil, nil }, nil).AIGenerateAnswer

		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "https://app.example.test/api/v1/ai/generate-answer", strings.NewReader(`{}`))

		RequestID(handler).ServeHTTP(rr, req)

		assertErrorEnvelope(t, rr, http.StatusUnauthorized, "UNAUTHENTICATED", "Authentication required")
	})

	t.Run("answer generation payload validation", func(t *testing.T) {
		zero := 0
		_, err := validateAIAnswerRequest(aiAnswerRequest{QuestionID: &zero, AnswerMode: "essay"})
		assertAPIValidation(t, err, "stem", "answerMode", "questionId")
	})

	t.Run("learning report payload validation", func(t *testing.T) {
		zero, negative := 0, -1
		_, err := validateAILearningReportRequest(aiclient.LearningReportRequest{Scope: "team", UserID: &zero, BankID: &negative, PracticeSessionID: &zero})
		assertAPIValidation(t, err, "scope", "userId", "bankId", "practiceSessionId")
	})

	t.Run("learning report accepts bounded client stats", func(t *testing.T) {
		payload, err := validateAILearningReportRequest(aiclient.LearningReportRequest{Stats: map[string]any{"answers": 12}})
		if err != nil {
			t.Fatalf("validate stats: %v", err)
		}
		if payload.Stats["answers"] != 12 {
			t.Fatalf("stats = %#v, want passthrough", payload.Stats)
		}
		_, err = validateAILearningReportRequest(aiclient.LearningReportRequest{Stats: map[string]any{"blob": strings.Repeat("x", 100_001)}})
		assertAPIValidation(t, err, "stats")
	})

	t.Run("document payload validation", func(t *testing.T) {
		err := validateAIDocumentParseRequest(aiclient.DocumentParseRequest{SourceType: "xls"})
		assertAPIValidation(t, err, "sourceType", "text")
	})
}

func TestStrictDecoderAllowsOptionalEmptyUnknownLengthBody(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "https://app.example.test/api/v1/import-jobs/42/parse", strings.NewReader(""))
	req.ContentLength = -1

	if _, err := decodeJSONBodyStrict[importJobParseRequest](req, true); err != nil {
		t.Fatalf("decode optional empty body: %v", err)
	}
}

func newImportsAIAndServerUnderTest(t *testing.T, imports ImportHandlers, ai AIHandlers) http.Handler {
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
		Imports: imports,
		AI:      ai,
	})
}

func assertErrorEnvelope(t *testing.T, rr *httptest.ResponseRecorder, wantStatus int, wantCode string, wantMsg string) {
	t.Helper()
	if rr.Code != wantStatus {
		t.Fatalf("status = %d, want %d", rr.Code, wantStatus)
	}
	requestID := rr.Header().Get("X-Request-ID")
	if requestID == "" {
		t.Fatal("X-Request-ID header missing")
	}
	body := decodeJSONBody(t, rr.Body.Bytes())
	errorBody := mustObject(t, body["error"], "error")
	if got := errorBody["code"]; got != wantCode {
		t.Fatalf("error.code = %#v, want %q", got, wantCode)
	}
	if got := errorBody["message"]; got != wantMsg {
		t.Fatalf("error.message = %#v, want %q", got, wantMsg)
	}
	if got := errorBody["requestId"]; got != requestID {
		t.Fatalf("error.requestId = %#v, want %q", got, requestID)
	}
}

func assertAPIValidation(t *testing.T, err error, fields ...string) {
	t.Helper()
	status, code, _, details := api.ValidationErrorEnvelope(err)
	if status != http.StatusUnprocessableEntity || code != "VALIDATION_ERROR" {
		t.Fatalf("validation error = (%d, %s), want 422 VALIDATION_ERROR", status, code)
	}
	for _, field := range fields {
		found := false
		for _, detail := range details {
			if detail["field"] == field {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("details = %#v, want field %q", details, field)
		}
	}
}
