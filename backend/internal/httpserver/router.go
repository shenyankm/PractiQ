package httpserver

import (
	"net/http"
	"strings"

	"openwook/internal/api"
)

func NewServer(cfg ServerConfig, deps ServerDependencies) http.Handler {
	router := http.NewServeMux()

	registerMethodRoute(router, http.MethodGet, "/api/health", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		api.OK(w, r, readinessData(r.Context(), deps), nil)
	}))
	registerMethodRoute(router, http.MethodGet, "/api/health/ready", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		data := readinessData(r.Context(), deps)
		status := http.StatusOK
		if ok, _ := data["ok"].(bool); !ok {
			status = http.StatusServiceUnavailable
		}
		api.Status(w, r, status, data, nil)
	}))
	registerMethodRoute(router, http.MethodGet, "/api/health/live", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		api.OK(w, r, map[string]any{"ok": true, "uptimeSeconds": deps.UptimeSeconds()}, nil)
	}))

	registerMethodRoute(router, http.MethodPost, "/api/v1/auth/register", deps.Auth.Register)
	registerMethodRoute(router, http.MethodPost, "/api/v1/auth/login", deps.Auth.Login)
	registerMethodRoute(router, http.MethodPost, "/api/v1/auth/logout", deps.Auth.Logout)
	registerMethodRoute(router, http.MethodGet, "/api/v1/auth/me", deps.Auth.Me)
	registerMethodRoute(router, http.MethodGet, "/api/v1/subjects", deps.Reference.Subjects)
	registerMethodRoute(router, http.MethodGet, "/api/v1/question-types", deps.Reference.QuestionTypes)
	registerMethodRoute(router, http.MethodGet, "/api/v1/knowledge-points", deps.Reference.KnowledgePoints)
	registerAdminRoutes(router, deps.Admin)
	registerMediaRoutes(router, deps.Media)
	registerContentRoutes(router, deps.Content)
	registerImportRoutes(router, deps.Imports)
	registerAIRoutes(router, deps.AI)
	registerPracticeAnalyticsSearchRoutes(router, deps.Practice, deps.Analytics, deps.Search)
	router.Handle("/", notFoundHandler(cfg))

	middlewareCfg := Config{NodeEnv: cfg.NodeEnv, AppOrigin: cfg.AppOrigin}
	handler := http.Handler(router)
	handler = SPAGuardWithResolver(middlewareCfg, deps.CurrentUser, handler)
	handler = SameOriginProtection(middlewareCfg, handler)
	handler = RateLimit(handler)
	handler = Recovery(handler)
	handler = RequestLog(handler)
	handler = RequestID(handler)
	return SecurityHeaders(middlewareCfg, handler)
}

func notFoundHandler(cfg ServerConfig) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			apiNotFound(w, r)
			return
		}
		serveStaticOrSPA(w, r, cfg.DistDir)
	}
}

func apiNotFound(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	api.HandleError(w, r, api.NewError(http.StatusNotFound, "NOT_FOUND", "Endpoint not found", nil))
}
