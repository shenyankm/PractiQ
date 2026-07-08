package redisx

import (
	"context"
	"encoding/json"
	"math"
	"time"

	"github.com/redis/go-redis/v9"
)

type RateLimitResult struct {
	Allowed      bool
	Count        int64
	Remaining    int64
	ResetSeconds int64
}

type Lock struct {
	Acquired bool
	Key      string
	Token    string
	redis    *redis.Client
}

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

func SetText(ctx context.Context, rdb *redis.Client, key, value string, ttl time.Duration) bool {
	return rdb.Set(ctx, key, value, ttl).Err() == nil
}

func GetText(ctx context.Context, rdb *redis.Client, key string) (string, bool) {
	value, err := rdb.Get(ctx, key).Result()
	if err != nil {
		return "", false
	}
	return value, true
}

func Delete(ctx context.Context, rdb *redis.Client, keys ...string) int64 {
	deleted, err := rdb.Unlink(ctx, keys...).Result()
	if err != nil {
		return 0
	}
	return deleted
}

func DeleteByPattern(ctx context.Context, rdb *redis.Client, pattern string) int64 {
	var total int64
	var cursor uint64
	for {
		keys, next, err := rdb.Scan(ctx, cursor, pattern, 100).Result()
		if err != nil {
			return total
		}
		cursor = next
		if len(keys) > 0 {
			deleted, err := rdb.Unlink(ctx, keys...).Result()
			if err == nil {
				total += deleted
			}
		}
		if cursor == 0 {
			return total
		}
	}
}

func IncrementRateLimit(ctx context.Context, rdb *redis.Client, key string, limit int64, window time.Duration) RateLimitResult {
	count, _ := rdb.Incr(ctx, key).Result()
	if count == 1 {
		_ = rdb.Expire(ctx, key, window).Err()
	}
	ttl, _ := rdb.TTL(ctx, key).Result()
	remaining := limit - count
	if remaining < 0 {
		remaining = 0
	}
	resetSeconds := int64(math.Ceil(ttl.Seconds()))
	if resetSeconds < 1 {
		resetSeconds = 1
	}
	return RateLimitResult{Allowed: count <= limit, Count: count, Remaining: remaining, ResetSeconds: resetSeconds}
}

func AcquireLock(ctx context.Context, rdb *redis.Client, key string, ttl time.Duration) Lock {
	token := time.Now().UTC().Format(time.RFC3339Nano)
	acquired, _ := rdb.SetNX(ctx, key, token, ttl).Result()
	return Lock{Acquired: acquired, Key: key, Token: token, redis: rdb}
}

func (l Lock) Release(ctx context.Context) bool {
	if l.redis == nil || l.Token == "" || l.Key == "" {
		return false
	}
	result, err := l.redis.Eval(ctx, ReleaseLockScript, []string{l.Key}, l.Token).Int64()
	if err != nil {
		return false
	}
	return result > 0
}

func PublishJSON(ctx context.Context, rdb *redis.Client, channel string, payload any) bool {
	raw, err := json.Marshal(payload)
	if err != nil {
		return false
	}
	return rdb.Publish(ctx, channel, string(raw)).Err() == nil
}

func AppendStreamJSON(ctx context.Context, rdb *redis.Client, streamKey string, payload any) bool {
	raw, err := json.Marshal(payload)
	if err != nil {
		return false
	}
	return rdb.XAdd(ctx, &redis.XAddArgs{Stream: streamKey, MaxLen: 500, Approx: true, Values: map[string]any{"payload": string(raw)}}).Err() == nil
}
