package redisx

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

var (
	clientMu  sync.Mutex
	clientURL string
	client    *redis.Client
)

func Client() *redis.Client {
	url := strings.TrimSpace(os.Getenv("REDIS_URL"))

	clientMu.Lock()
	defer clientMu.Unlock()

	if url == "" {
		resetClient()
		return nil
	}
	if client != nil && clientURL == url {
		return client
	}
	options, err := redis.ParseURL(url)
	if err != nil {
		resetClient()
		return nil
	}
	resetClient()
	client = redis.NewClient(options)
	clientURL = url
	return client
}

func resetClient() {
	if client != nil {
		_ = client.Close()
	}
	client = nil
	clientURL = ""
}

func CheckRedis(ctx context.Context) (bool, error) {
	if strings.TrimSpace(os.Getenv("REDIS_URL")) == "" {
		return false, errors.New("REDIS_URL is required")
	}
	rdb := Client()
	if rdb == nil {
		return false, errors.New("REDIS_URL is invalid")
	}
	started := time.Now()
	_, err := rdb.Ping(ctx).Result()
	_ = started
	return true, err
}
