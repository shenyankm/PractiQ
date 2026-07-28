package redisx

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

type RateLimitResult struct {
	Allowed      bool
	Count        int64
	Remaining    int64
	ResetSeconds int64
}

var incrementRateLimitScript = redis.NewScript(`
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`)

func SetJSON(ctx context.Context, rdb *redis.Client, key string, value any, ttl time.Duration) bool {
	payload, err := json.Marshal(value)
	if err != nil {
		return false
	}
	return rdb.Set(ctx, key, string(payload), ttl).Err() == nil
}

func GetJSON[T any](ctx context.Context, rdb *redis.Client, key string) (T, bool) {
	var zero T
	raw, err := rdb.Get(ctx, key).Result()
	if err != nil {
		return zero, false
	}
	if err := json.Unmarshal([]byte(raw), &zero); err != nil {
		return zero, false
	}
	return zero, true
}

func GetText(ctx context.Context, rdb *redis.Client, key string) (string, bool) {
	value, err := rdb.Get(ctx, key).Result()
	if err != nil {
		return "", false
	}
	return value, true
}

func IncrementRateLimit(ctx context.Context, rdb *redis.Client, key string, limit int64, window time.Duration) (RateLimitResult, error) {
	if rdb == nil {
		return RateLimitResult{}, errors.New("redis client is required")
	}
	if window <= 0 {
		return RateLimitResult{}, errors.New("rate-limit window must be positive")
	}
	values, err := incrementRateLimitScript.Run(ctx, rdb, []string{key}, window.Milliseconds()).Int64Slice()
	if err != nil {
		return RateLimitResult{}, err
	}
	if len(values) != 2 {
		return RateLimitResult{}, errors.New("unexpected rate-limit script result")
	}
	count, ttlMilliseconds := values[0], values[1]
	remaining := max(limit-count, 0)
	resetSeconds := max((ttlMilliseconds+999)/1000, 1)
	return RateLimitResult{Allowed: count <= limit, Count: count, Remaining: remaining, ResetSeconds: resetSeconds}, nil
}
