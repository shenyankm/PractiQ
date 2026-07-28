package httpserver

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"practiq/internal/auth"
)

type ServerConfig struct {
	NodeEnv   string
	AppOrigin string
	DistDir   string
}

type AuthHandlers struct {
	Register       http.Handler
	Login          http.Handler
	Logout         http.Handler
	Me             http.Handler
	UpdateMe       http.Handler
	EmailCode      http.Handler
	GoogleStart    http.Handler
	GoogleCallback http.Handler
	GoogleToken    http.Handler
}

type ServerDependencies struct {
	CheckPostgres func(context.Context) error
	CheckRedis    func(context.Context) (bool, error)
	UptimeSeconds func() int64
	CurrentUser   auth.CurrentUserResolver
	Auth          AuthHandlers
	Reference     ReferenceHandlers
	Admin         AdminHandlers
	Media         MediaHandlers
	Content       ContentHandlers
	Imports       ImportHandlers
	AI            AIHandlers
	Practice      PracticeHandlers
	Analytics     AnalyticsHandlers
	Search        SearchHandlers
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
		"ok":            postgresErr == nil && redisConfigured && redisErr == nil,
		"uptimeSeconds": deps.UptimeSeconds(),
		"latencyMs":     latencyMs,
		"services": map[string]any{
			"postgres": map[string]any{"ok": postgresErr == nil, "latencyMs": postgresLatency},
			"redis":    map[string]any{"configured": redisConfigured, "ok": redisErr == nil, "latencyMs": redisLatency},
		},
	}
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
