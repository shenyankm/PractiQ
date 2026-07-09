package main

import (
	"context"
	"log"
	"net"
	"net/http"
	"strconv"
	"time"

	"openwook/internal/aiclient"
	"openwook/internal/auth"
	"openwook/internal/config"
	"openwook/internal/db"
	"openwook/internal/httpserver"
	"openwook/internal/redisx"
)

func main() {
	ctx := context.Background()
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}
	pool, err := db.OpenPool(ctx)
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()

	startedAt := time.Now()
	addr := net.JoinHostPort(cfg.OpenWookHost, strconv.Itoa(cfg.Port))
	appOrigin := cfg.AppOrigin
	if appOrigin == "" {
		appOrigin = "http://" + addr
	}
	currentUser := auth.CurrentUserFromRequest(pool)

	handler := httpserver.NewServer(httpserver.ServerConfig{
		NodeEnv:   cfg.NodeEnv,
		AppOrigin: appOrigin,
		DistDir:   "../frontend/dist",
	}, httpserver.ServerDependencies{
		CheckPostgres: func(ctx context.Context) error {
			return db.CheckPostgres(ctx, pool)
		},
		CheckRedis: redisx.CheckRedis,
		MetricsHandler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/plain; version=0.0.4")
			_, _ = w.Write([]byte("# no metrics configured\n"))
		}),
		UptimeSeconds: func() int64 {
			return int64(time.Since(startedAt).Seconds())
		},
		CurrentUser: currentUser,
		Reference:   httpserver.BuildReferenceHandlers(pool),
		Content:     httpserver.BuildContentHandlers(pool, currentUser),
		Practice:    httpserver.BuildPracticeHandlers(pool, currentUser),
		Analytics:   httpserver.BuildAnalyticsHandlers(pool, currentUser),
		Search:      httpserver.BuildSearchHandlers(pool, currentUser),
		Auth:        httpserver.BuildAuthHandlers(pool),
		Admin:       httpserver.BuildAdminHandlers(pool),
		Media:       httpserver.BuildMediaHandlers(pool),
		Imports:     httpserver.BuildImportHandlers(pool, currentUser),
		AI:          httpserver.BuildAIHandlers(pool, currentUser, aiclient.New(cfg)),
		Billing:     httpserver.BuildBillingHandlers(pool, currentUser),
	})

	log.Fatal(http.ListenAndServe(addr, handler))
}
