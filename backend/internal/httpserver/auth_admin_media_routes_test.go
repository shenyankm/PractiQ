package httpserver

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"openwook/internal/api"
)

func TestNewServerRoutesSharedPathsPathValuesAndUnknownMethods(t *testing.T) {
	handler := newRoutesServerUnderTest(t, ServerDependencies{
		Reference: ReferenceHandlers{
			KnowledgePoints: routeStubHandler(http.StatusOK, "reference-knowledge-points"),
		},
		Admin: AdminHandlers{
			CreateKnowledgePoint: routeStubHandler(http.StatusCreated, "admin-create-knowledge-point"),
		},
		Media: MediaHandlers{
			Get: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte(r.PathValue("mediaId")))
			}),
		},
	})

	t.Run("GET knowledge points stays on reference route", func(t *testing.T) {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "https://app.example.test/api/v1/knowledge-points", nil)

		handler.ServeHTTP(rr, req)

		if rr.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", rr.Code, http.StatusOK)
		}
		if got := rr.Body.String(); got != "reference-knowledge-points" {
			t.Fatalf("body = %q, want %q", got, "reference-knowledge-points")
		}
	})

	t.Run("POST knowledge points stays on admin route", func(t *testing.T) {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "https://app.example.test/api/v1/knowledge-points", nil)

		handler.ServeHTTP(rr, req)

		if rr.Code != http.StatusCreated {
			t.Fatalf("status = %d, want %d", rr.Code, http.StatusCreated)
		}
		if got := rr.Body.String(); got != "admin-create-knowledge-point" {
			t.Fatalf("body = %q, want %q", got, "admin-create-knowledge-point")
		}
	})

	t.Run("native path value reaches handler", func(t *testing.T) {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "https://app.example.test/api/v1/media/11", nil)

		handler.ServeHTTP(rr, req)

		if rr.Code != http.StatusOK || rr.Body.String() != "11" {
			t.Fatalf("response = (%d, %q), want (200, %q)", rr.Code, rr.Body.String(), "11")
		}
	})

	t.Run("unsupported method falls through to api not found", func(t *testing.T) {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "https://app.example.test/api/v1/media/11", nil)

		handler.ServeHTTP(rr, req)

		assertErrorEnvelope(t, rr, http.StatusNotFound, "NOT_FOUND", "Endpoint not found")
		if got := rr.Header().Get("Cache-Control"); got != "no-store" {
			t.Fatalf("Cache-Control = %q, want no-store", got)
		}
	})
}

func TestDecodeJSONBodyStrictRejectsOversizedBody(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/test", strings.NewReader(`{"value":"`+strings.Repeat("x", 2*1024*1024)+`"}`))
	req = req.WithContext(api.WithRequestID(req.Context(), "req-json-limit"))

	_, err := decodeJSONBodyStrict[struct {
		Value string `json:"value"`
	}](req)
	if err == nil {
		t.Fatal("decodeJSONBodyStrict error = nil, want body size error")
	}
	var tooLarge *http.MaxBytesError
	if !errors.As(err, &tooLarge) {
		t.Fatalf("decodeJSONBodyStrict error = %T, want *http.MaxBytesError", err)
	}

	rr := httptest.NewRecorder()
	api.HandleError(rr, req, err)
	assertErrorEnvelope(t, rr, http.StatusRequestEntityTooLarge, "REQUEST_TOO_LARGE", "Request body is too large")
}

func TestDecodeJSONBodyStrictLimitAllowsExplicitLargerLimit(t *testing.T) {
	value := strings.Repeat("x", 2*1024*1024)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/import-jobs/1/file", strings.NewReader(`{"value":"`+value+`"}`))

	body, err := decodeJSONBodyStrictLimit[struct {
		Value string `json:"value"`
	}](req, 3*1024*1024)
	if err != nil {
		t.Fatalf("decodeJSONBodyStrictLimit returned error: %v", err)
	}
	if body.Value != value {
		t.Fatalf("decoded value length = %d, want %d", len(body.Value), len(value))
	}
}

func TestOptionalJSONFieldDistinguishesOmittedAndNull(t *testing.T) {
	type request struct {
		Value optionalJSONField[*string] `json:"value"`
	}
	omitted, err := decodeJSONBodyStrict[request](httptest.NewRequest(http.MethodPatch, "/", strings.NewReader(`{}`)))
	if err != nil || omitted.Value.Set {
		t.Fatalf("omitted field = %#v, error = %v; want unset", omitted.Value, err)
	}
	nullValue, err := decodeJSONBodyStrict[request](httptest.NewRequest(http.MethodPatch, "/", strings.NewReader(`{"value":null}`)))
	if err != nil || !nullValue.Value.Set || nullValue.Value.Value != nil {
		t.Fatalf("null field = %#v, error = %v; want set nil", nullValue.Value, err)
	}
}

func TestValidateMediaLinkRejectsDatabaseOverflow(t *testing.T) {
	mediaID := int64(1)
	sortOrder := 32768
	_, err := validateMediaLink(mediaLinkRequest{MediaID: &mediaID, MediaKind: strings.Repeat("x", 65), SortOrder: &sortOrder})
	status, code, _, details := api.ValidationErrorEnvelope(err)
	if status != http.StatusUnprocessableEntity || code != "VALIDATION_ERROR" || len(details) != 2 {
		t.Fatalf("error = (%d, %s, %#v), want two validation details", status, code, details)
	}
}

func newRoutesServerUnderTest(t *testing.T, deps ServerDependencies) http.Handler {
	t.Helper()

	distDir := t.TempDir()
	writeServerTestFile(t, distDir, "index.html", "<!doctype html><html><body>placeholder</body></html>")

	deps.CheckPostgres = func(context.Context) error { return nil }
	deps.CheckRedis = func(context.Context) (bool, error) { return true, nil }
	deps.UptimeSeconds = func() int64 { return 1 }

	return NewServer(ServerConfig{
		NodeEnv:   "test",
		AppOrigin: "https://app.example.test",
		DistDir:   distDir,
	}, deps)
}

func routeStubHandler(status int, body string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	})
}
