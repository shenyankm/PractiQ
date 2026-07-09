package httpserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"openwook/internal/api"
	"openwook/internal/auth"
)

func TestNewServerRegistersImportsRoutes(t *testing.T) {
	handlers := ImportHandlers{
		ImportJobs: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.OK(w, r, map[string]any{"method": r.Method, "route": "jobs"}, nil)
		}),
		ImportJob: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.OK(w, r, map[string]any{"jobId": r.PathValue("jobId")}, nil)
		}),
		ImportJobFile: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.Created(w, r, map[string]any{"jobId": r.PathValue("jobId")}, nil)
		}),
		ImportJobAction: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.OK(w, r, map[string]any{"jobId": r.PathValue("jobId"), "action": r.PathValue("action")}, nil)
		}),
		ImportJobChildren: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.OK(w, r, map[string]any{"jobId": r.PathValue("jobId"), "kind": r.PathValue("kind")}, nil)
		}),
		ImportJobEventStream: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.OK(w, r, map[string]any{"jobId": r.PathValue("jobId"), "route": "events-stream"}, nil)
		}),
		ImportJobReviewResolve: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.OK(w, r, map[string]any{"jobId": r.PathValue("jobId"), "itemId": r.PathValue("itemId")}, nil)
		}),
	}

	tests := []struct {
		name       string
		method     string
		target     string
		wantStatus int
		wantData   map[string]any
	}{
		{name: "list jobs", method: http.MethodGet, target: "/api/v1/import-jobs", wantStatus: http.StatusOK, wantData: map[string]any{"method": http.MethodGet, "route": "jobs"}},
		{name: "get job", method: http.MethodGet, target: "/api/v1/import-jobs/42", wantStatus: http.StatusOK, wantData: map[string]any{"jobId": "42"}},
		{name: "upload file", method: http.MethodPost, target: "/api/v1/import-jobs/42/file", wantStatus: http.StatusCreated, wantData: map[string]any{"jobId": "42"}},
		{name: "job action", method: http.MethodPost, target: "/api/v1/import-jobs/42/start", wantStatus: http.StatusOK, wantData: map[string]any{"jobId": "42", "action": "start"}},
		{name: "job child list", method: http.MethodGet, target: "/api/v1/import-jobs/42/review-items", wantStatus: http.StatusOK, wantData: map[string]any{"jobId": "42", "kind": "review-items"}},
		{name: "event stream", method: http.MethodGet, target: "/api/v1/import-jobs/42/events/stream", wantStatus: http.StatusOK, wantData: map[string]any{"jobId": "42", "route": "events-stream"}},
		{name: "review resolve", method: http.MethodPost, target: "/api/v1/import-jobs/42/review-items/7/resolve", wantStatus: http.StatusOK, wantData: map[string]any{"jobId": "42", "itemId": "7"}},
	}

	handler := newImportsAIAndBillingServerUnderTest(t, handlers, AIHandlers{}, BillingHandlers{})
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rr := httptest.NewRecorder()
			req := httptest.NewRequest(tt.method, "https://app.example.test"+tt.target, nil)

			handler.ServeHTTP(rr, req)

			if rr.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d", rr.Code, tt.wantStatus)
			}
			body := decodeJSONBody(t, rr.Body.Bytes())
			if !reflect.DeepEqual(body["data"], tt.wantData) {
				t.Fatalf("data = %#v, want %#v", body["data"], tt.wantData)
			}
		})
	}
}

func TestNewServerRegistersAIPublicRoutes(t *testing.T) {
	handlers := AIHandlers{
		AIParseDocument: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.OK(w, r, map[string]any{"route": "parse-document"}, nil)
		}),
		AIGenerateAnswer: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.OK(w, r, map[string]any{"route": "generate-answer"}, nil)
		}),
		AILearningReport: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.OK(w, r, map[string]any{"route": "learning-report"}, nil)
		}),
		QuestionGenerateAnswer: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.OK(w, r, map[string]any{"questionId": r.PathValue("questionId")}, nil)
		}),
	}

	tests := []struct {
		name   string
		target string
		want   map[string]any
	}{
		{name: "parse document", target: "/api/v1/ai/parse-document", want: map[string]any{"route": "parse-document"}},
		{name: "generate answer", target: "/api/v1/ai/generate-answer", want: map[string]any{"route": "generate-answer"}},
		{name: "learning report", target: "/api/v1/ai/learning-report", want: map[string]any{"route": "learning-report"}},
		{name: "question generate answer", target: "/api/v1/questions/91/generate-answer", want: map[string]any{"questionId": "91"}},
	}

	handler := newImportsAIAndBillingServerUnderTest(t, ImportHandlers{}, handlers, BillingHandlers{})
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rr := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "https://app.example.test"+tt.target, nil)

			handler.ServeHTTP(rr, req)

			if rr.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d", rr.Code, http.StatusOK)
			}
			body := decodeJSONBody(t, rr.Body.Bytes())
			if !reflect.DeepEqual(body["data"], tt.want) {
				t.Fatalf("data = %#v, want %#v", body["data"], tt.want)
			}
		})
	}
}

func TestNewServerRegistersBillingRoutes(t *testing.T) {
	handlers := BillingHandlers{
		BillingSummary: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.OK(w, r, map[string]any{"route": "summary"}, nil)
		}),
		BillingCheckout: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			api.Created(w, r, map[string]any{"route": "checkout"}, nil)
		}),
		BillingWebhook: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			_, _ = w.Write([]byte("ok"))
		}),
	}

	handler := newImportsAIAndBillingServerUnderTest(t, ImportHandlers{}, AIHandlers{}, handlers)

	t.Run("summary", func(t *testing.T) {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "https://app.example.test/api/v1/billing/summary", nil)

		handler.ServeHTTP(rr, req)

		if rr.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", rr.Code, http.StatusOK)
		}
		body := decodeJSONBody(t, rr.Body.Bytes())
		if !reflect.DeepEqual(body["data"], map[string]any{"route": "summary"}) {
			t.Fatalf("data = %#v, want summary payload", body["data"])
		}
	})

	t.Run("checkout", func(t *testing.T) {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "https://app.example.test/api/v1/billing/checkout", nil)

		handler.ServeHTTP(rr, req)

		if rr.Code != http.StatusCreated {
			t.Fatalf("status = %d, want %d", rr.Code, http.StatusCreated)
		}
		body := decodeJSONBody(t, rr.Body.Bytes())
		if !reflect.DeepEqual(body["data"], map[string]any{"route": "checkout"}) {
			t.Fatalf("data = %#v, want checkout payload", body["data"])
		}
	})

	t.Run("webhook", func(t *testing.T) {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "https://app.example.test/api/v1/billing/webhook", nil)

		handler.ServeHTTP(rr, req)

		if rr.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", rr.Code, http.StatusOK)
		}
		if got := rr.Header().Get("Content-Type"); got != "text/plain; charset=utf-8" {
			t.Fatalf("Content-Type = %q, want text/plain; charset=utf-8", got)
		}
		if got := rr.Body.String(); got != "ok" {
			t.Fatalf("body = %q, want ok", got)
		}
	})
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
		{name: "create job invalid bank id", handler: handlers.ImportJobs, method: http.MethodPost, target: "/api/v1/import-jobs", body: `{"bankId":0}`, wantStatus: http.StatusUnprocessableEntity, wantCode: "VALIDATION_ERROR", wantMsg: "Invalid request"},
		{name: "get job invalid id", handler: handlers.ImportJob, method: http.MethodGet, target: "/api/v1/import-jobs/nope", pathValues: map[string]string{"jobId": "nope"}, wantStatus: http.StatusUnprocessableEntity, wantCode: "VALIDATION_ERROR", wantMsg: "Invalid jobId"},
		{name: "unknown job action", handler: handlers.ImportJobAction, method: http.MethodPost, target: "/api/v1/import-jobs/42/nope", pathValues: map[string]string{"jobId": "42", "action": "nope"}, wantStatus: http.StatusNotFound, wantCode: "NOT_FOUND", wantMsg: "Endpoint not found"},
		{name: "invalid child kind", handler: handlers.ImportJobChildren, method: http.MethodGet, target: "/api/v1/import-jobs/42/nope", pathValues: map[string]string{"jobId": "42", "kind": "nope"}, wantStatus: http.StatusUnprocessableEntity, wantCode: "VALIDATION_ERROR", wantMsg: "Invalid request"},
		{name: "review resolve invalid item id", handler: handlers.ImportJobReviewResolve, method: http.MethodPost, target: "/api/v1/import-jobs/42/review-items/nope/resolve", body: `{}`, pathValues: map[string]string{"jobId": "42", "itemId": "nope"}, wantStatus: http.StatusUnprocessableEntity, wantCode: "VALIDATION_ERROR", wantMsg: "Invalid itemId"},
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
		_, err := decodeAIAnswerRequest([]byte(`{"questionId":0,"stem":"","answerMode":"essay"}`))
		assertAPIValidation(t, err, "stem", "answerMode", "questionId")
	})

	t.Run("learning report payload validation", func(t *testing.T) {
		_, err := decodeAILearningReportRequest([]byte(`{"scope":"team","userId":0,"bankId":-1,"practiceSessionId":0}`))
		assertAPIValidation(t, err, "scope", "userId", "bankId", "practiceSessionId")
	})
}

func TestBuildBillingHandlersRejectInvalidRequestsBeforeExternalCalls(t *testing.T) {
	clearPaddleEnv(t)

	t.Run("checkout requires authentication", func(t *testing.T) {
		handler := BuildBillingHandlers(nil, func(*http.Request) (*auth.User, error) { return nil, nil }).BillingCheckout

		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "https://app.example.test/api/v1/billing/checkout", strings.NewReader(`{"planKey":"plus"}`))

		RequestID(handler).ServeHTTP(rr, req)

		assertErrorEnvelope(t, rr, http.StatusUnauthorized, "UNAUTHENTICATED", "Authentication required")
	})

	t.Run("checkout rejects when paddle is not configured", func(t *testing.T) {
		handler := BuildBillingHandlers(nil, func(*http.Request) (*auth.User, error) {
			return &auth.User{ID: 7, Username: "alice", IsActive: true}, nil
		}).BillingCheckout

		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "https://app.example.test/api/v1/billing/checkout", strings.NewReader(`{"planKey":"plus"}`))

		RequestID(handler).ServeHTTP(rr, req)

		assertErrorEnvelope(t, rr, http.StatusServiceUnavailable, "BILLING_NOT_CONFIGURED", "Paddle billing is not configured")
	})

	t.Run("webhook requires signature", func(t *testing.T) {
		handler := BuildBillingHandlers(nil, nil).BillingWebhook

		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "https://app.example.test/api/v1/billing/webhook", strings.NewReader(`{}`))

		RequestID(handler).ServeHTTP(rr, req)

		assertErrorEnvelope(t, rr, http.StatusBadRequest, "PADDLE_SIGNATURE_MISSING", "Missing paddle-signature header")
	})

	t.Run("webhook requires configured secret", func(t *testing.T) {
		handler := BuildBillingHandlers(nil, nil).BillingWebhook

		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "https://app.example.test/api/v1/billing/webhook", strings.NewReader(`{}`))
		req.Header.Set("Paddle-Signature", "ts=1;h1=abc")

		RequestID(handler).ServeHTTP(rr, req)

		assertErrorEnvelope(t, rr, http.StatusInternalServerError, "BILLING_NOT_CONFIGURED", "Paddle webhook secret is not configured")
	})
}

func newImportsAIAndBillingServerUnderTest(t *testing.T, imports ImportHandlers, ai AIHandlers, billing BillingHandlers) http.Handler {
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
		MetricsHandler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		}),
		UptimeSeconds: func() int64 {
			return 1
		},
		Imports: imports,
		AI:      ai,
		Billing: billing,
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

func clearPaddleEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{"PADDLE_API_KEY", "PADDLE_CLIENT_TOKEN", "PADDLE_WEBHOOK_SECRET", "PADDLE_PLUS_PRICE_ID", "PADDLE_ENTERPRISE_PRICE_ID"} {
		t.Setenv(key, "")
	}
}
