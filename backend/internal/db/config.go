package db

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type Config struct {
	DatabaseURL        string
	MaxConns           int32
	IdleTimeout        time.Duration
	ConnectTimeout     time.Duration
	SlowQueryThreshold time.Duration
}

func LoadConfig() (Config, error) {
	cfg := Config{
		DatabaseURL:        strings.TrimSpace(os.Getenv("POSTGRES_URL")),
		MaxConns:           int32(intFromEnv(firstNonEmpty(os.Getenv("POSTGRES_POOL_MAX"), os.Getenv("DATABASE_POOL_MAX")), 8)),
		IdleTimeout:        time.Duration(intFromEnv(os.Getenv("POSTGRES_IDLE_TIMEOUT_SECONDS"), 30)) * time.Second,
		ConnectTimeout:     time.Duration(intFromEnv(os.Getenv("POSTGRES_CONNECT_TIMEOUT_SECONDS"), 10)) * time.Second,
		SlowQueryThreshold: time.Duration(intFromEnv(os.Getenv("SLOW_QUERY_MS"), 500)) * time.Millisecond,
	}
	if strings.TrimSpace(cfg.DatabaseURL) == "" {
		return Config{}, fmt.Errorf("POSTGRES_URL is required")
	}
	return cfg, nil
}

func CollectSQLFiles(root string) ([]string, error) {
	matches, err := filepath.Glob(filepath.Join(root, "db", "*", "*.sql"))
	if err != nil {
		return nil, err
	}
	sort.Slice(matches, func(i, j int) bool {
		leftOrder, leftName := sqlFileOrder(matches[i])
		rightOrder, rightName := sqlFileOrder(matches[j])
		if leftOrder != rightOrder {
			return leftOrder < rightOrder
		}
		if leftName != rightName {
			return leftName < rightName
		}
		return matches[i] < matches[j]
	})
	return matches, nil
}

func sqlFileOrder(path string) (int, string) {
	name := filepath.Base(path)
	var order int
	if _, err := fmt.Sscanf(name, "%d_", &order); err != nil {
		order = 1 << 30
	}
	return order, name
}

func intFromEnv(raw string, fallback int) int {
	if strings.TrimSpace(raw) == "" {
		return fallback
	}
	var value int
	_, err := fmt.Sscanf(strings.TrimSpace(raw), "%d", &value)
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
