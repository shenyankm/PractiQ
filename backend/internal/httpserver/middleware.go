package httpserver

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"runtime/debug"
	"strings"
	"time"

	"practiq/internal/api"
	"practiq/internal/auth"
	"practiq/internal/redisx"
)

const apiRateLimit = 300

var apiRateLimitWindow = time.Minute
var idempotencyTTL = 24 * time.Hour

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

type idempotentResponse struct {
	Status int                 `json:"status"`
	Header map[string][]string `json:"header"`
	Body   []byte              `json:"body"`
}

type bufferedResponseWriter struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (w *bufferedResponseWriter) Header() http.Header {
	return w.header
}

func (w *bufferedResponseWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}

func (w *bufferedResponseWriter) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.body.Write(body)
}

// Idempotency makes mobile outbox retries safe without changing existing REST
// handlers. Requests without Idempotency-Key take the original fast path.
func Idempotency(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
		if key == "" || r.Method == http.MethodGet || strings.HasPrefix(r.URL.Path, "/api/v1/auth/") {
			next.ServeHTTP(w, r)
			return
		}
		if len(key) > 128 || strings.ContainsAny(key, "\r\n") {
			api.HandleError(w, r, api.ValidationError([]api.ValidationDetail{{Field: "Idempotency-Key", Message: "must be at most 128 characters"}}))
			return
		}
		rdb := redisx.Client()
		if rdb == nil {
			api.HandleError(w, r, api.NewError(http.StatusServiceUnavailable, "IDEMPOTENCY_UNAVAILABLE", "Idempotent writes are temporarily unavailable", nil))
			return
		}
		digest := sha256.Sum256([]byte(requestSessionIdentity(r) + "\x00" + r.Method + "\x00" + r.URL.Path + "\x00" + key))
		cacheKey := redisx.RedisKey("idempotency", hex.EncodeToString(digest[:]))
		if cached, ok := redisx.GetJSON[idempotentResponse](r.Context(), rdb, cacheKey); ok {
			writeIdempotentResponse(w, cached)
			return
		}
		lockKey := cacheKey + ":lock"
		locked, err := rdb.SetNX(r.Context(), lockKey, "1", 30*time.Second).Result()
		if err != nil {
			api.HandleError(w, r, api.NewError(http.StatusServiceUnavailable, "IDEMPOTENCY_UNAVAILABLE", "Idempotent writes are temporarily unavailable", nil))
			return
		}
		if !locked {
			api.HandleError(w, r, api.NewError(http.StatusConflict, "REQUEST_IN_PROGRESS", "An identical request is already in progress", nil))
			return
		}
		defer rdb.Del(r.Context(), lockKey)

		buffered := &bufferedResponseWriter{header: make(http.Header)}
		next.ServeHTTP(buffered, r)
		response := idempotentResponse{
			Status: buffered.status,
			Header: map[string][]string(buffered.header),
			Body:   buffered.body.Bytes(),
		}
		if response.Status == 0 {
			response.Status = http.StatusOK
		}
		if response.Status >= http.StatusOK && response.Status < http.StatusBadRequest {
			_ = redisx.SetJSON(r.Context(), rdb, cacheKey, response, idempotencyTTL)
		}
		writeIdempotentResponse(w, response)
	})
}

func requestSessionIdentity(r *http.Request) string {
	if cookie, err := r.Cookie("session"); err == nil {
		return cookie.Value
	}
	return r.Header.Get("Authorization")
}

func writeIdempotentResponse(w http.ResponseWriter, response idempotentResponse) {
	for name, values := range response.Header {
		for _, value := range values {
			w.Header().Add(name, value)
		}
	}
	w.WriteHeader(response.Status)
	_, _ = w.Write(response.Body)
}

func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := r.Header.Get("X-Request-ID")
		if strings.TrimSpace(requestID) == "" || len(requestID) > 128 {
			requestID = auth.NewUUID()
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

func SPAGuard(cfg Config, currentUser auth.CurrentUserResolver, next http.Handler) http.Handler {
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
