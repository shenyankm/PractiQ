package db

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func OpenPool(ctx context.Context) (*pgxpool.Pool, error) {
	cfg, err := LoadConfig()
	if err != nil {
		return nil, err
	}
	poolConfig, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	poolConfig.MaxConns = cfg.MaxConns
	poolConfig.MaxConnIdleTime = cfg.IdleTimeout
	poolConfig.HealthCheckPeriod = 30 * time.Second
	poolConfig.ConnConfig.ConnectTimeout = cfg.ConnectTimeout
	return pgxpool.NewWithConfig(ctx, poolConfig)
}

func CheckPostgres(ctx context.Context, pool *pgxpool.Pool) error {
	return pool.Ping(ctx)
}
