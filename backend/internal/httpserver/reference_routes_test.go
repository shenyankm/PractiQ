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
	wantData := []any{map[string]any{"subject_id": "math", "display_name": "Algebra"}}
	handler := newReferenceServerUnderTest(t, ReferenceHandlers{
		Subjects: referenceTestHandler([]map[string]any{{"subject_id": "math", "display_name": "Algebra"}}),
	})

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "https://app.example.test/api/v1/subjects", nil)
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusOK)
	}
	if got := rr.Header().Get("Cache-Control"); got != publicReferenceCacheControl {
		t.Fatalf("Cache-Control = %q, want %q", got, publicReferenceCacheControl)
	}
	requestID := rr.Header().Get("X-Request-ID")
	body := decodeJSONBody(t, rr.Body.Bytes())
	if !reflect.DeepEqual(body["data"], wantData) {
		t.Fatalf("data = %#v, want %#v", body["data"], wantData)
	}
	if got := mustObject(t, body["meta"], "meta")["requestId"]; got != requestID || requestID == "" {
		t.Fatalf("meta.requestId = %#v, want non-empty %q", got, requestID)
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
