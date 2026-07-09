package redisx

import (
	"context"
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
		if client != nil && clientURL == "" {
			return client
		}
		if client != nil {
			_ = client.Close()
		}
		client = nil
		clientURL = ""
		return nil
	}
	if client != nil && clientURL == url {
		return client
	}
	options, err := redis.ParseURL(url)
	if err != nil {
		return nil
	}
	if client != nil {
		_ = client.Close()
	}
	client = redis.NewClient(options)
	clientURL = url
	return client
}

func CheckRedis(ctx context.Context) (bool, error) {
	rdb := Client()
	if rdb == nil {
		return false, nil
	}
	started := time.Now()
	_, err := rdb.Ping(ctx).Result()
	_ = started
	return true, err
}
