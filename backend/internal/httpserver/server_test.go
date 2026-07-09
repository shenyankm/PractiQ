package httpserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNewServerServesStaticAssetsAndSPAIndexFallback(t *testing.T) {
	distDir := t.TempDir()
	indexHTML := "<!doctype html><html><body>openwook spa</body></html>"
	assetJS := "console.log('openwook');\n"
	writeServerTestFile(t, distDir, "index.html", indexHTML)
	writeServerTestFile(t, distDir, "assets/app.js", assetJS)

	handler := newServerUnderTest(t, serverTestOptions{
		distDir: distDir,
	})

	t.Run("serves built asset from dist", func(t *testing.T) {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "https://app.example.test/assets/app.js", nil)

		handler.ServeHTTP(rr, req)

		if rr.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", rr.Code, http.StatusOK)
		}
		if got := rr.Body.String(); got != assetJS {
			t.Fatalf("asset body = %q, want %q", got, assetJS)
		}
	})

	t.Run("falls back to dist index for public spa route", func(t *testing.T) {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "https://app.example.test/sign-in", nil)

		handler.ServeHTTP(rr, req)

		if rr.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", rr.Code, http.StatusOK)
		}
		if got := rr.Body.String(); got != indexHTML {
			t.Fatalf("spa fallback body = %q, want %q", got, indexHTML)
		}
		if got := rr.Header().Get("Content-Type"); !strings.Contains(got, "text/html") {
			t.Fatalf("Content-Type = %q, want text/html for spa fallback", got)
		}
	})
}

func TestNewServerReadinessEndpointsReturnEnvelopeWithDependencyChecks(t *testing.T) {
	handler := newServerUnderTest(t, serverTestOptions{
		uptimeSeconds: 321,
	})

	for _, path := range []string{"/api/health", "/api/health/ready"} {
		t.Run(path, func(t *testing.T) {
			rr := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "https://app.example.test"+path, nil)

			handler.ServeHTTP(rr, req)

			if rr.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d", rr.Code, http.StatusOK)
			}
			if got := rr.Header().Get("Cache-Control"); got != "no-store" {
				t.Fatalf("Cache-Control = %q, want no-store", got)
			}

			requestID := rr.Header().Get("X-Request-ID")
			if !looksLikeUUID(requestID) {
				t.Fatalf("X-Request-ID = %q, want generated UUID", requestID)
			}

			body := decodeJSONBody(t, rr.Body.Bytes())
			data := mustObject(t, body["data"], "data")
			meta := mustObject(t, body["meta"], "meta")
			if got := meta["requestId"]; got != requestID {
				t.Fatalf("meta.requestId = %#v, want %q", got, requestID)
			}
			if got := data["ok"]; got != true {
				t.Fatalf("data.ok = %#v, want true", got)
			}
			if got := data["uptimeSeconds"]; got != float64(321) {
				t.Fatalf("data.uptimeSeconds = %#v, want 321", got)
			}
			if _, ok := data["latencyMs"].(float64); !ok {
				t.Fatalf("data.latencyMs = %#v, want number", data["latencyMs"])
			}

			services := mustObject(t, data["services"], "data.services")
			postgres := mustObject(t, services["postgres"], "data.services.postgres")
			if got := postgres["ok"]; got != true {
				t.Fatalf("data.services.postgres.ok = %#v, want true", got)
			}
			if _, ok := postgres["latencyMs"].(float64); !ok {
				t.Fatalf("data.services.postgres.latencyMs = %#v, want number", postgres["latencyMs"])
			}

			redis := mustObject(t, services["redis"], "data.services.redis")
			if got := redis["configured"]; got != true {
				t.Fatalf("data.services.redis.configured = %#v, want true", got)
			}
			if got := redis["ok"]; got != true {
				t.Fatalf("data.services.redis.ok = %#v, want true", got)
			}
			if _, ok := redis["latencyMs"].(float64); !ok {
				t.Fatalf("data.services.redis.latencyMs = %#v, want number", redis["latencyMs"])
			}
		})
	}
}

func TestNewServerLivenessEndpointReturnsEnvelopeWithoutDependencyChecks(t *testing.T) {
	handler := newServerUnderTest(t, serverTestOptions{
		uptimeSeconds: 99,
	})

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "https://app.example.test/api/health/live", nil)

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusOK)
	}
	if got := rr.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}

	requestID := rr.Header().Get("X-Request-ID")
	if !looksLikeUUID(requestID) {
		t.Fatalf("X-Request-ID = %q, want generated UUID", requestID)
	}

	body := decodeJSONBody(t, rr.Body.Bytes())
	data := mustObject(t, body["data"], "data")
	meta := mustObject(t, body["meta"], "meta")
	if got := meta["requestId"]; got != requestID {
		t.Fatalf("meta.requestId = %#v, want %q", got, requestID)
	}
	if got := data["ok"]; got != true {
		t.Fatalf("data.ok = %#v, want true", got)
	}
	if got := data["uptimeSeconds"]; got != float64(99) {
		t.Fatalf("data.uptimeSeconds = %#v, want 99", got)
	}
	if _, exists := data["services"]; exists {
		t.Fatalf("data.services = %#v, want absent on liveness endpoint", data["services"])
	}
}

func TestNewServerRejectsCrossSiteMutationRoutes(t *testing.T) {
	distDir := t.TempDir()
	writeServerTestFile(t, distDir, "index.html", "<!doctype html><html><body>placeholder</body></html>")

	called := false
	handler := NewServer(ServerConfig{
		NodeEnv:   "test",
		AppOrigin: "https://app.example.test",
		DistDir:   distDir,
	}, ServerDependencies{
		CheckPostgres: func(context.Context) error { return nil },
		CheckRedis:    func(context.Context) (bool, error) { return true, nil },
		UptimeSeconds: func() int64 { return 1 },
		Auth: AuthHandlers{
			Logout: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				w.WriteHeader(http.StatusNoContent)
			}),
		},
	})

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "https://app.example.test/api/v1/auth/logout", nil)
	req.Header.Set("Origin", "https://evil.example")

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusForbidden)
	}
	if called {
		t.Fatal("logout handler ran for a cross-site mutation request")
	}

	body := decodeJSONBody(t, rr.Body.Bytes())
	errorBody := mustObject(t, body["error"], "error")
	if got := errorBody["code"]; got != "INVALID_ORIGIN" {
		t.Fatalf("error.code = %#v, want INVALID_ORIGIN", got)
	}
	if got := errorBody["message"]; got != "Cross-site requests are not allowed" {
		t.Fatalf("error.message = %#v, want Cross-site requests are not allowed", got)
	}
}

func TestNewServerRedirectsProtectedSPARoutesWithInvalidSessionCookie(t *testing.T) {
	distDir := t.TempDir()
	writeServerTestFile(t, distDir, "index.html", "<!doctype html><html><body>placeholder</body></html>")

	handler := NewServer(ServerConfig{
		NodeEnv:   "test",
		AppOrigin: "https://app.example.test",
		DistDir:   distDir,
	}, ServerDependencies{
		CheckPostgres: func(context.Context) error { return nil },
		CheckRedis:    func(context.Context) (bool, error) { return true, nil },
		UptimeSeconds: func() int64 { return 1 },
	})

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "https://app.example.test/dashboard", nil)
	req.AddCookie(&http.Cookie{Name: "session", Value: "not-a-jwt"})

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusTemporaryRedirect {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusTemporaryRedirect)
	}
	if got := rr.Header().Get("Location"); got != "https://app.example.test/sign-in?redirect=%2Fdashboard" {
		t.Fatalf("Location = %q, want https://app.example.test/sign-in?redirect=%%2Fdashboard", got)
	}
}

type serverTestOptions struct {
	nodeEnv       string
	distDir       string
	uptimeSeconds int64
}

func newServerUnderTest(t *testing.T, opts serverTestOptions) http.Handler {
	t.Helper()

	distDir := opts.distDir
	if distDir == "" {
		distDir = t.TempDir()
		writeServerTestFile(t, distDir, "index.html", "<!doctype html><html><body>placeholder</body></html>")
	}

	nodeEnv := opts.nodeEnv
	if nodeEnv == "" {
		nodeEnv = "test"
	}

	uptimeSeconds := opts.uptimeSeconds
	if uptimeSeconds == 0 {
		uptimeSeconds = 123
	}

	return NewServer(ServerConfig{
		NodeEnv:   nodeEnv,
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
			return uptimeSeconds
		},
	})
}

func writeServerTestFile(t *testing.T, root string, relativePath string, content string) {
	t.Helper()

	path := filepath.Join(root, relativePath)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func mustObject(t *testing.T, raw any, name string) map[string]any {
	t.Helper()

	obj, ok := raw.(map[string]any)
	if !ok {
		t.Fatalf("%s = %#v, want object", name, raw)
	}
	return obj
}
