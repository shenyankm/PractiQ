package main

import (
	"context"
	"errors"
	"log"
	"os/signal"
	"syscall"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"openwook/internal/aiclient"
	"openwook/internal/config"
	"openwook/internal/db"
	importqueue "openwook/internal/imports"
	"openwook/internal/redisx"
	"openwook/internal/services"
)

type workerApp struct {
	config config.Config
	queue  importqueue.WorkerConfig
	redis  *redis.Client
	pool   *pgxpool.Pool
	client *aiclient.Client
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	app, err := newWorkerApp()
	if err != nil {
		log.Fatal(err)
	}
	defer app.Close()

	if err := app.Run(ctx); err != nil {
		log.Fatal(err)
	}
}

func newWorkerApp() (*workerApp, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, err
	}
	rdb := redisx.Client()
	if rdb == nil {
		return nil, errors.New("REDIS_URL is required to run the import worker")
	}
	pool, err := db.OpenPool(context.Background())
	if err != nil {
		return nil, err
	}
	return &workerApp{config: cfg, queue: importqueue.LoadWorkerConfig(), redis: rdb, pool: pool, client: aiclient.New(cfg)}, nil
}

func (app *workerApp) Close() {
	if app.pool != nil {
		app.pool.Close()
	}
}

func (app *workerApp) Run(ctx context.Context) error {
	runtime, err := importqueue.NewQueueRuntime(app.redis, app.queue)
	if err != nil {
		return err
	}
	maxAttempts := app.queue.MaxAttempts
	if maxAttempts <= 0 {
		maxAttempts = 3
	}
	return runtime.Run(ctx, func(jobCtx context.Context, payload importqueue.QueuePayload) error {
		err := processQueuedJob(jobCtx, app.pool, app.client, payload)
		if err == nil {
			return nil
		}
		if payload.Attempt < maxAttempts {
			return err
		}
		if _, recordErr := services.RecordImportJobFailure(jobCtx, app.pool, int64(payload.JobID), err); recordErr != nil {
			return errors.Join(err, recordErr)
		}
		return nil
	})
}
