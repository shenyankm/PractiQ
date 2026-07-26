package httpserver

import (
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"runtime/debug"
	"strings"
	"time"

	"openwook/internal/api"
	"openwook/internal/auth"
	"openwook/internal/redisx"
)

const apiRateLimit = 300

var apiRateLimitWindow = time.Minute

type Config struct {
	NodeEnv   string
	AppOrigin string
}

func SecurityHeaders(cfg Config, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", contentSecurityPolicy(cfg.NodeEnv))
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

func Recovery(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			recovered := recover()
			if recovered == nil {
				return
			}
			if recovered == http.ErrAbortHandler {
				panic(recovered)
			}
			slog.Error("panic recovered", "panic", recovered, "method", r.Method, "path", r.URL.Path, "requestId", api.RequestID(r.Context()), "stack", string(debug.Stack()))
			api.HandleError(w, r, api.NewError(http.StatusInternalServerError, "INTERNAL_ERROR", "Unexpected server error", nil))
		}()
		next.ServeHTTP(w, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (rec *statusRecorder) WriteHeader(status int) {
	rec.status = status
	rec.ResponseWriter.WriteHeader(status)
}

func RequestLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		slog.Info("http request", "method", r.Method, "path", r.URL.Path, "status", rec.status, "durationMs", time.Since(started).Milliseconds(), "requestId", api.RequestID(r.Context()))
	})
}

func RateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/api/health") {
			next.ServeHTTP(w, r)
			return
		}
		rdb := redisx.Client()
		if rdb == nil {
			// ponytail: Redis 缺失时放行（fail-open），认证端点仍由自身 fail-closed 限流兜底
			next.ServeHTTP(w, r)
			return
		}
		address := r.RemoteAddr
		if host, _, err := net.SplitHostPort(address); err == nil {
			address = host
		}
		result, err := redisx.IncrementRateLimit(r.Context(), rdb, redisx.RedisKey("rate-limit", "api", "ip", address), apiRateLimit, apiRateLimitWindow)
		if err == nil && !result.Allowed {
			api.HandleError(w, r, api.NewError(http.StatusTooManyRequests, "RATE_LIMITED", "Too many requests", nil))
			return
		}
		next.ServeHTTP(w, r)
	})
}

func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := r.Header.Get("X-Request-ID")
		if strings.TrimSpace(requestID) == "" || len(requestID) > 128 {
			requestID = newUUID()
		}
		w.Header().Set("X-Request-ID", requestID)
		next.ServeHTTP(w, r.WithContext(api.WithRequestID(r.Context(), requestID)))
	})
}

func SameOriginProtection(cfg Config, next http.Handler) http.Handler {
	protected := map[string]bool{http.MethodPost: true, http.MethodPut: true, http.MethodPatch: true, http.MethodDelete: true}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !protected[strings.ToUpper(r.Method)] {
			next.ServeHTTP(w, r)
			return
		}
		origin := r.Header.Get("Origin")
		referer := r.Header.Get("Referer")
		if origin == "" && referer == "" {
			next.ServeHTTP(w, r)
			return
		}
		candidate := origin
		if candidate == "" {
			candidate = referer
		}
		if sameOrigin(candidate, cfg.AppOrigin) {
			next.ServeHTTP(w, r)
			return
		}
		api.HandleError(w, r, api.NewError(http.StatusForbidden, "INVALID_ORIGIN", "Cross-site requests are not allowed", nil))
	})
}

func SPAGuardWithResolver(cfg Config, currentUser auth.CurrentUserResolver, next http.Handler) http.Handler {
	return spaGuard(cfg, currentUser, next)
}

func spaGuard(cfg Config, currentUser auth.CurrentUserResolver, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && isProtectedPath(r.URL.Path) && !hasValidSPASession(r, currentUser) {
			http.Redirect(w, r, signInRedirectURL(cfg, r), http.StatusTemporaryRedirect)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func hasValidSPASession(r *http.Request, currentUser auth.CurrentUserResolver) bool {
	cookie, err := r.Cookie("session")
	if err != nil {
		return false
	}
	if currentUser != nil {
		user, err := currentUser(r)
		return err == nil && user != nil && user.IsActive
	}
	_, err = auth.VerifySessionToken(cookie.Value)
	return err == nil
}

func signInRedirectURL(cfg Config, r *http.Request) string {
	target, err := url.Parse(strings.TrimRight(cfg.AppOrigin, "/") + "/sign-in")
	if err != nil {
		return strings.TrimRight(cfg.AppOrigin, "/") + "/sign-in"
	}
	redirectTarget := r.URL.Path
	if r.URL.RawQuery != "" {
		redirectTarget += "?" + r.URL.RawQuery
	}
	query := target.Query()
	query.Set("redirect", redirectTarget)
	target.RawQuery = query.Encode()
	return target.String()
}

func contentSecurityPolicy(nodeEnv string) string {
	scriptSrc := "script-src 'self' 'unsafe-inline'"
	if nodeEnv == "development" {
		scriptSrc += " 'unsafe-eval'"
	}
	return "default-src 'self'; " + scriptSrc + "; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https: http:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
}

func sameOrigin(value string, expected string) bool {
	parsedValue, err := url.Parse(value)
	if err != nil {
		return false
	}
	parsedExpected, err := url.Parse(expected)
	if err != nil {
		return false
	}
	return parsedValue.Scheme == parsedExpected.Scheme && parsedValue.Host == parsedExpected.Host
}

func isProtectedPath(path string) bool {
	for _, prefix := range []string{"/dashboard", "/banks", "/imports", "/practice", "/questions", "/settings", "/admin"} {
		if path == prefix || strings.HasPrefix(path, prefix+"/") {
			return true
		}
	}
	return false
}

func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "00000000-0000-4000-8000-000000000000"
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	encoded := make([]byte, 32)
	hex.Encode(encoded, b[:])
	return string(encoded[0:8]) + "-" + string(encoded[8:12]) + "-" + string(encoded[12:16]) + "-" + string(encoded[16:20]) + "-" + string(encoded[20:32])
}
