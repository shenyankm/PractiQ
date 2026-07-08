package httpserver

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"openwook/internal/api"
	"openwook/internal/auth"
)

type ServerConfig struct {
	NodeEnv      string
	AppOrigin    string
	DistDir      string
	MetricsToken string
}

type AuthHandlers struct {
	Register http.Handler
	Login    http.Handler
	Logout   http.Handler
	Me       http.Handler
}

type ServerDependencies struct {
	CheckPostgres    func(context.Context) error
	CheckRedis       func(context.Context) (bool, error)
	MetricsHandler   http.Handler
	UptimeSeconds    func() int64
	CurrentUser      auth.CurrentUserResolver
	Auth             AuthHandlers
	Reference        ReferenceHandlers
	Admin            AdminHandlers
	Media            MediaHandlers
	Content          ContentHandlers
	ImportsBillingAI ImportsBillingAIHandlers
	Practice         PracticeHandlers
	Analytics        AnalyticsHandlers
	Search           SearchHandlers
}

func NewServer(cfg ServerConfig, deps ServerDependencies) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		api.OK(w, r, readinessData(r.Context(), deps), nil)
	})
	mux.HandleFunc("/api/health/ready", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		api.OK(w, r, readinessData(r.Context(), deps), nil)
	})
	mux.HandleFunc("/api/health/live", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		api.OK(w, r, map[string]any{"ok": true, "uptimeSeconds": deps.UptimeSeconds()}, nil)
	})
	mux.Handle("/api/metrics", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if metricsUnauthorized(cfg, r) {
			api.HandleError(w, r, api.NewError(http.StatusUnauthorized, "UNAUTHORIZED", "Metrics endpoint requires authorization", nil))
			return
		}
		deps.MetricsHandler.ServeHTTP(w, r)
	}))
	registerMethodRoute(mux, http.MethodPost, "/api/v1/auth/register", deps.Auth.Register)
	registerMethodRoute(mux, http.MethodPost, "/api/v1/auth/login", deps.Auth.Login)
	registerMethodRoute(mux, http.MethodPost, "/api/v1/auth/logout", deps.Auth.Logout)
	registerMethodRoute(mux, http.MethodGet, "/api/v1/auth/me", deps.Auth.Me)
	registerMethodRoute(mux, http.MethodGet, "/api/v1/subjects", deps.Reference.Subjects)
	registerMethodRoute(mux, http.MethodGet, "/api/v1/question-types", deps.Reference.QuestionTypes)
	registerMethodRoute(mux, http.MethodGet, "/api/v1/knowledge-points", deps.Reference.KnowledgePoints)
	registerAdminRoutes(mux, deps.Admin)
	registerMediaRoutes(mux, deps.Media)
	registerContentRoutes(mux, deps.Content)
	registerImportsBillingAIRoutes(mux, deps.ImportsBillingAI)
	registerPracticeAnalyticsSearchRoutes(mux, deps.Practice, deps.Analytics, deps.Search)
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
			api.HandleError(w, r, api.NewError(http.StatusNotFound, "NOT_FOUND", "Endpoint not found", nil))
			return
		}
		serveStaticOrSPA(w, r, cfg.DistDir)
	}))

	middlewareCfg := Config{NodeEnv: cfg.NodeEnv, AppOrigin: cfg.AppOrigin}
	handler := http.Handler(mux)
	handler = SPAGuardWithResolver(middlewareCfg, deps.CurrentUser, handler)
	handler = SameOriginProtection(middlewareCfg, handler)
	handler = RequestID(handler)
	return SecurityHeaders(middlewareCfg, handler)
}

func readinessData(ctx context.Context, deps ServerDependencies) map[string]any {
	postgresStarted := time.Now()
	postgresErr := deps.CheckPostgres(ctx)
	postgresLatency := time.Since(postgresStarted).Seconds() * 1000

	redisStarted := time.Now()
	redisConfigured, redisErr := deps.CheckRedis(ctx)
	redisLatency := time.Since(redisStarted).Seconds() * 1000

	latencyMs := postgresLatency
	if redisLatency > latencyMs {
		latencyMs = redisLatency
	}

	return map[string]any{
		"ok":            postgresErr == nil && redisErr == nil,
		"uptimeSeconds": deps.UptimeSeconds(),
		"latencyMs":     latencyMs,
		"services": map[string]any{
			"postgres": map[string]any{"ok": postgresErr == nil, "latencyMs": postgresLatency},
			"redis":    map[string]any{"configured": redisConfigured, "ok": redisErr == nil, "latencyMs": redisLatency},
		},
	}
}

func metricsUnauthorized(cfg ServerConfig, r *http.Request) bool {
	if cfg.NodeEnv == "production" {
		return r.Header.Get("Authorization") != "Bearer "+cfg.MetricsToken || cfg.MetricsToken == ""
	}
	if cfg.MetricsToken == "" {
		return false
	}
	return r.Header.Get("Authorization") != "Bearer "+cfg.MetricsToken
}

func serveStaticOrSPA(w http.ResponseWriter, r *http.Request, distDir string) {
	path := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/"))
	if path == "." {
		path = "index.html"
	}
	candidate := filepath.Join(distDir, path)
	if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
		http.ServeFile(w, r, candidate)
		return
	}
	indexPath := filepath.Join(distDir, "index.html")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	http.ServeFile(w, r, indexPath)
}
