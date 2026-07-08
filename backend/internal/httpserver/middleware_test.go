package httpserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestSecurityHeadersApplyCurrentCSPAndBrowserPolicies(t *testing.T) {
	paths := []string{"/", "/api/health", "/assets/app.js"}
	tests := []struct {
		name           string
		nodeEnv        string
		wantCSP        string
		wantUnsafeEval bool
	}{
		{
			name:    "production",
			nodeEnv: "production",
			wantCSP: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https: http:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
		},
		{
			name:           "development",
			nodeEnv:        "development",
			wantCSP:        "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https: http:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
			wantUnsafeEval: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			handler := SecurityHeaders(Config{
				NodeEnv:   tt.nodeEnv,
				AppOrigin: "https://app.example.test",
			}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusNoContent)
			}))

			for _, path := range paths {
				t.Run(path, func(t *testing.T) {
					rr := httptest.NewRecorder()
					req := httptest.NewRequest(http.MethodGet, "https://app.example.test"+path, nil)

					handler.ServeHTTP(rr, req)

					gotCSP := rr.Header().Get("Content-Security-Policy")
					if gotCSP != tt.wantCSP {
						t.Fatalf("Content-Security-Policy = %q, want %q", gotCSP, tt.wantCSP)
					}
					if got := rr.Header().Get("Referrer-Policy"); got != "strict-origin-when-cross-origin" {
						t.Fatalf("Referrer-Policy = %q, want strict-origin-when-cross-origin", got)
					}
					if got := rr.Header().Get("X-Content-Type-Options"); got != "nosniff" {
						t.Fatalf("X-Content-Type-Options = %q, want nosniff", got)
					}
					if got := rr.Header().Get("X-Frame-Options"); got != "DENY" {
						t.Fatalf("X-Frame-Options = %q, want DENY", got)
					}

					scriptSrc := cspDirective(gotCSP, "script-src")
					if tt.wantUnsafeEval {
						if !strings.Contains(scriptSrc, "'unsafe-eval'") {
							t.Fatalf("script-src = %q, want to contain 'unsafe-eval'", scriptSrc)
						}
						if strings.Count(gotCSP, "'unsafe-eval'") != 1 {
							t.Fatalf("Content-Security-Policy = %q, want 'unsafe-eval' only once", gotCSP)
						}
					} else if strings.Contains(scriptSrc, "'unsafe-eval'") {
						t.Fatalf("script-src = %q, must not contain 'unsafe-eval' outside development", scriptSrc)
					}
				})
			}
		})
	}
}

func TestRequestIDUsesIncomingHeaderWhenPresentAndShortEnough(t *testing.T) {
	const incoming = "req-incoming-123"

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "https://app.example.test/api/health", nil)
	req.Header.Set("X-Request-ID", incoming)

	RequestID(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})).ServeHTTP(rr, req)

	if got := rr.Header().Get("X-Request-ID"); got != incoming {
		t.Fatalf("response x-request-id = %q, want %q", got, incoming)
	}
}

func TestRequestIDGeneratesWhenHeaderMissingOrTooLong(t *testing.T) {
	tests := []struct {
		name     string
		incoming string
	}{
		{name: "missing"},
		{name: "too long", incoming: strings.Repeat("x", 129)},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rr := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "https://app.example.test/api/health", nil)
			if tt.incoming != "" {
				req.Header.Set("X-Request-ID", tt.incoming)
			}

			RequestID(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusNoContent)
			})).ServeHTTP(rr, req)

			got := rr.Header().Get("X-Request-ID")
			if got == "" {
				t.Fatal("response x-request-id must be generated when input is missing or too long")
			}
			if tt.incoming != "" && got == tt.incoming {
				t.Fatalf("response x-request-id = %q, want generated replacement", got)
			}
			if !looksLikeUUID(got) {
				t.Fatalf("response x-request-id = %q, want UUID", got)
			}
		})
	}
}

func TestSameOriginProtectionRejectsCrossSiteMutations(t *testing.T) {
	appOrigin := "https://app.example.test"
	tests := []struct {
		name        string
		method      string
		headerName  string
		headerValue string
	}{
		{name: "post origin", method: http.MethodPost, headerName: "Origin", headerValue: "https://evil.example"},
		{name: "put referer", method: http.MethodPut, headerName: "Referer", headerValue: "https://evil.example/settings"},
		{name: "patch origin", method: http.MethodPatch, headerName: "Origin", headerValue: "https://evil.example"},
		{name: "delete referer", method: http.MethodDelete, headerName: "Referer", headerValue: "https://evil.example/questions/1"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rr := httptest.NewRecorder()
			req := httptest.NewRequest(tt.method, appOrigin+"/api/v1/banks", strings.NewReader(`{"name":"algebra"}`))
			req.Header.Set(tt.headerName, tt.headerValue)

			SameOriginProtection(Config{
				AppOrigin: appOrigin,
			}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				t.Fatal("next handler must not run for cross-site mutations")
			})).ServeHTTP(rr, req)

			if rr.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want %d", rr.Code, http.StatusForbidden)
			}
			body := decodeJSONBody(t, rr.Body.Bytes())
			errorBody, ok := body["error"].(map[string]any)
			if !ok {
				t.Fatalf("error body = %#v, want object", body["error"])
			}
			if got := errorBody["code"]; got != "INVALID_ORIGIN" {
				t.Fatalf("error.code = %#v, want INVALID_ORIGIN", got)
			}
			if got := errorBody["message"]; got != "Cross-site requests are not allowed" {
				t.Fatalf("error.message = %#v, want Cross-site requests are not allowed", got)
			}
		})
	}
}

func TestSPAGuardRedirectsUnauthenticatedProtectedRoutesToConfiguredSignIn(t *testing.T) {
	protectedPaths := []string{
		"/dashboard",
		"/banks/12",
		"/imports/5",
		"/practice/9",
		"/questions/4",
		"/settings",
		"/admin/users",
	}

	for _, path := range protectedPaths {
		t.Run(path, func(t *testing.T) {
			rr := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "https://ignored.example"+path, nil)

			SPAGuard(Config{
				AppOrigin: "https://app.example.test",
			}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				t.Fatal("next handler must not run for unauthenticated protected SPA route")
			})).ServeHTTP(rr, req)

			if rr.Code != http.StatusTemporaryRedirect {
				t.Fatalf("status = %d, want %d", rr.Code, http.StatusTemporaryRedirect)
			}
			wantLocation := "https://app.example.test/sign-in?redirect=" + url.QueryEscape(path)
			if got := rr.Header().Get("Location"); got != wantLocation {
				t.Fatalf("Location = %q, want %q", got, wantLocation)
			}
		})
	}
}

func decodeJSONBody(t *testing.T, body []byte) map[string]any {
	t.Helper()

	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("unmarshal body: %v", err)
	}
	return decoded
}

func cspDirective(csp string, name string) string {
	for _, part := range strings.Split(csp, ";") {
		trimmed := strings.TrimSpace(part)
		if strings.HasPrefix(trimmed, name+" ") {
			return trimmed
		}
	}
	return ""
}

func looksLikeUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for _, index := range []int{8, 13, 18, 23} {
		if value[index] != '-' {
			return false
		}
	}
	if value[14] != '4' {
		return false
	}
	switch value[19] {
	case '8', '9', 'a', 'A', 'b', 'B':
	default:
		return false
	}
	for i, r := range value {
		switch {
		case i == 8 || i == 13 || i == 18 || i == 23:
			continue
		case r >= '0' && r <= '9':
			continue
		case r >= 'a' && r <= 'f':
			continue
		case r >= 'A' && r <= 'F':
			continue
		default:
			return false
		}
	}
	return true
}
