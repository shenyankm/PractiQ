package httpserver

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"openwook/internal/api"
)

func NewServer(cfg ServerConfig, deps ServerDependencies) http.Handler {
	router := chi.NewRouter()
	router.NotFound(notFoundHandler(cfg))
	router.MethodNotAllowed(notFoundHandler(cfg))

	router.Get("/api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		api.OK(w, r, readinessData(r.Context(), deps), nil)
	})
	router.Get("/api/health/ready", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		api.OK(w, r, readinessData(r.Context(), deps), nil)
	})
	router.Get("/api/health/live", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		api.OK(w, r, map[string]any{"ok": true, "uptimeSeconds": deps.UptimeSeconds()}, nil)
	})
	router.Handle("/api/metrics", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if metricsUnauthorized(cfg, r) {
			api.HandleError(w, r, api.NewError(http.StatusUnauthorized, "UNAUTHORIZED", "Metrics endpoint requires authorization", nil))
			return
		}
		deps.MetricsHandler.ServeHTTP(w, r)
	}))

	router.Route("/api/v1", func(v1 chi.Router) {
		registerMethodRoute(v1, http.MethodPost, "/auth/register", deps.Auth.Register)
		registerMethodRoute(v1, http.MethodPost, "/auth/login", deps.Auth.Login)
		registerMethodRoute(v1, http.MethodPost, "/auth/logout", deps.Auth.Logout)
		registerMethodRoute(v1, http.MethodGet, "/auth/me", deps.Auth.Me)
		registerMethodRoute(v1, http.MethodGet, "/subjects", deps.Reference.Subjects)
		registerMethodRoute(v1, http.MethodGet, "/question-types", deps.Reference.QuestionTypes)
		registerMethodRoute(v1, http.MethodGet, "/knowledge-points", deps.Reference.KnowledgePoints)
		registerAdminRoutes(v1, deps.Admin)
		registerMediaRoutes(v1, deps.Media)
		registerContentRoutes(v1, deps.Content)
		registerImportRoutes(v1, deps.Imports)
		registerAIRoutes(v1, deps.AI)
		registerBillingRoutes(v1, deps.Billing)
		registerPracticeAnalyticsSearchRoutes(v1, deps.Practice, deps.Analytics, deps.Search)
	})

	middlewareCfg := Config{NodeEnv: cfg.NodeEnv, AppOrigin: cfg.AppOrigin}
	handler := http.Handler(router)
	handler = SPAGuardWithResolver(middlewareCfg, deps.CurrentUser, handler)
	handler = SameOriginProtection(middlewareCfg, handler)
	handler = RequestID(handler)
	return SecurityHeaders(middlewareCfg, handler)
}

func notFoundHandler(cfg ServerConfig) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
			api.HandleError(w, r, api.NewError(http.StatusNotFound, "NOT_FOUND", "Endpoint not found", nil))
			return
		}
		serveStaticOrSPA(w, r, cfg.DistDir)
	}
}
