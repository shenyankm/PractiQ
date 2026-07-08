package httpserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"openwook/internal/api"
)

const publicReferenceCacheControl = "public, max-age=0, s-maxage=300, stale-while-revalidate=60"

func TestNewServerRegistersReferenceRoutesWithEnvelopeAndPublicCache(t *testing.T) {
	tests := []struct {
		name     string
		target   string
		handlers ReferenceHandlers
		wantData any
	}{
		{
			name:   "subjects",
			target: "/api/v1/subjects",
			handlers: ReferenceHandlers{
				Subjects: referenceTestHandler([]map[string]any{{
					"subject_id":   "math",
					"display_name": "Algebra",
				}}),
			},
			wantData: []any{map[string]any{
				"subject_id":   "math",
				"display_name": "Algebra",
			}},
		},
		{
			name:   "question types",
			target: "/api/v1/question-types?subject=math&scope=question",
			handlers: ReferenceHandlers{
				QuestionTypes: referenceTestHandler([]map[string]any{{
					"type_id":             "single-choice",
					"subject_id":          "math",
					"display_name":        "Single Choice",
					"scope":               "question",
					"default_answer_mode": "choice",
				}}),
			},
			wantData: []any{map[string]any{
				"type_id":             "single-choice",
				"subject_id":          "math",
				"display_name":        "Single Choice",
				"scope":               "question",
				"default_answer_mode": "choice",
			}},
		},
		{
			name:   "knowledge points",
			target: "/api/v1/knowledge-points?subject=math&parentId=9",
			handlers: ReferenceHandlers{
				KnowledgePoints: referenceTestHandler([]map[string]any{{
					"id":            float64(17),
					"subject_id":    "math",
					"code":          "ALG-01",
					"display_name":  "Linear Equations",
					"parent_id":     float64(9),
					"metadata_json": `{"difficulty":"easy"}`,
					"created_at":    "2026-07-08T12:00:00Z",
					"updated_at":    "2026-07-08T12:30:00Z",
				}}),
			},
			wantData: []any{map[string]any{
				"id":            float64(17),
				"subject_id":    "math",
				"code":          "ALG-01",
				"display_name":  "Linear Equations",
				"parent_id":     float64(9),
				"metadata_json": `{"difficulty":"easy"}`,
				"created_at":    "2026-07-08T12:00:00Z",
				"updated_at":    "2026-07-08T12:30:00Z",
			}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			handler := newReferenceServerUnderTest(t, tt.handlers)

			rr := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "https://app.example.test"+tt.target, nil)

			handler.ServeHTTP(rr, req)

			if rr.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d", rr.Code, http.StatusOK)
			}
			if got := rr.Header().Get("Cache-Control"); got != publicReferenceCacheControl {
				t.Fatalf("Cache-Control = %q, want %q", got, publicReferenceCacheControl)
			}
			requestID := rr.Header().Get("X-Request-ID")
			if requestID == "" {
				t.Fatal("X-Request-ID header missing")
			}

			body := decodeJSONBody(t, rr.Body.Bytes())
			if !reflect.DeepEqual(body["data"], tt.wantData) {
				t.Fatalf("data = %#v, want %#v", body["data"], tt.wantData)
			}
			meta := mustObject(t, body["meta"], "meta")
			if got := meta["requestId"]; got != requestID {
				t.Fatalf("meta.requestId = %#v, want %q", got, requestID)
			}
		})
	}
}

func newReferenceServerUnderTest(t *testing.T, handlers ReferenceHandlers) http.Handler {
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
		Reference: handlers,
	})
}

func referenceTestHandler(data any) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", publicReferenceCacheControl)
		api.OK(w, r, data, nil)
	})
}
