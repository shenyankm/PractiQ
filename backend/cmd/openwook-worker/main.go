package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"openwook/internal/aiclient"
	"openwook/internal/config"
	"openwook/internal/db"
	importqueue "openwook/internal/imports"
	"openwook/internal/services"
)

type workerApp struct {
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
	pool, err := db.OpenPool(context.Background())
	if err != nil {
		return nil, err
	}
	if err := db.CheckPostgres(context.Background(), pool); err != nil {
		pool.Close()
		return nil, err
	}
	return &workerApp{pool: pool, client: aiclient.New(cfg)}, nil
}

func (app *workerApp) Close() {
	if app.pool != nil {
		app.pool.Close()
	}
}

func (app *workerApp) Run(ctx context.Context) error {
	if app.pool == nil {
		return fmt.Errorf("PostgreSQL pool is required")
	}
	if app.client == nil {
		return fmt.Errorf("AI client is required")
	}

	for {
		if ctx.Err() != nil {
			return nil
		}
		job, err := importqueue.ClaimNextJob(ctx, app.pool)
		if errors.Is(err, pgx.ErrNoRows) {
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(importqueue.PollInterval):
				continue
			}
		}
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return nil
			}
			return err
		}

		if job.PersistenceStarted {
			if err := app.recordFailure(ctx, job, services.ImportPersistenceInterruptedCode, errors.New("worker claim expired after persistence started")); err != nil {
				return err
			}
			continue
		}
		if job.AttemptsExhausted {
			if err := app.recordFailure(ctx, job, services.ImportAttemptsExhaustedCode, errors.New("import retry limit reached")); err != nil {
				return err
			}
			continue
		}

		persistenceStarted, err := processQueuedJob(ctx, app.pool, app.client, job)
		if err == nil {
			continue
		}
		if errors.Is(err, importqueue.ErrClaimLost) {
			continue
		}
		if ctx.Err() != nil {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			var cleanupErr error
			if persistenceStarted {
				cleanupErr = app.recordFailure(cleanupCtx, job, services.ImportPersistenceInterruptedCode, err)
			} else {
				cleanupErr = importqueue.ReleaseJob(cleanupCtx, app.pool, job.ID, job.ClaimVersion)
				if errors.Is(cleanupErr, importqueue.ErrClaimLost) {
					cleanupErr = nil
				}
			}
			cancel()
			return cleanupErr
		}
		if shouldRequeue(job.Attempt, persistenceStarted) {
			if retryErr := importqueue.RequeueJob(ctx, app.pool, job.ID, job.ClaimVersion, importqueue.RetryBackoff(job.Attempt)); retryErr != nil {
				if errors.Is(retryErr, importqueue.ErrClaimLost) {
					continue
				}
				return errors.Join(err, retryErr)
			}
			continue
		}
		errorCode := services.ImportAttemptsExhaustedCode
		if persistenceStarted {
			errorCode = services.ImportPersistenceInterruptedCode
		}
		if recordErr := app.recordFailure(ctx, job, errorCode, err); recordErr != nil {
			return errors.Join(err, recordErr)
		}
	}
}

func shouldRequeue(attempt int, persistenceStarted bool) bool {
	return !persistenceStarted && attempt < importqueue.MaxAttempts
}

func (app *workerApp) recordFailure(ctx context.Context, job importqueue.ClaimedJob, code string, cause error) error {
	_, err := services.RecordImportJobFailure(ctx, app.pool, job.ID, job.ClaimVersion, code, cause)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	return err
}
