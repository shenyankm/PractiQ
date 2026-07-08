package httpserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"openwook/internal/api"
)

func TestNewServerRegistersImportsRoutes(t *testing.T) {
	handlers := ImportsBillingAIHandlers{
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
		{name: "review resolve", method: http.MethodPost, target: "/api/v1/import-jobs/42/review-items/7/resolve", wantStatus: http.StatusOK, wantData: map[string]any{"jobId": "42", "itemId": "7"}},
	}

	handler := newImportsBillingAIServerUnderTest(t, handlers)
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
	handlers := ImportsBillingAIHandlers{
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

	handler := newImportsBillingAIServerUnderTest(t, handlers)
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
	handlers := ImportsBillingAIHandlers{
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

	handler := newImportsBillingAIServerUnderTest(t, handlers)

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

func newImportsBillingAIServerUnderTest(t *testing.T, handlers ImportsBillingAIHandlers) http.Handler {
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
		ImportsBillingAI: handlers,
	})
}
