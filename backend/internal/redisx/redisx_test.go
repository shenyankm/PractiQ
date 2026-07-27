package redisx

import (
	"context"
	"encoding/json"
	"reflect"
	"strconv"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func TestRedisKeyUsesConfiguredPrefixAndSkipsNilOrEmptyParts(t *testing.T) {
	t.Setenv("REDIS_KEY_PREFIX", "tenant-a")

	got := RedisKey(nil, "", "cache", 42, "user")
	want := "tenant-a:cache:42:user"

	if got != want {
		t.Fatalf("RedisKey(...) = %q, want %q", got, want)
	}
}

func TestRedisKeyFallsBackToOpenWookPrefix(t *testing.T) {
	t.Setenv("REDIS_KEY_PREFIX", "")

	got := RedisKey("", nil, "session", "revoked", "jti-123")
	want := "openwook:session:revoked:jti-123"

	if got != want {
		t.Fatalf("RedisKey(...) = %q, want %q", got, want)
	}
}

func TestImportEventChannelMatchesExistingShape(t *testing.T) {
	t.Setenv("REDIS_KEY_PREFIX", "openwook")

	if got, want := ImportEventChannel(123), "openwook:import:123:events"; got != want {
		t.Fatalf("ImportEventChannel(123) = %q, want %q", got, want)
	}
}

func TestCheckRedisRejectsMissingAndInvalidURLs(t *testing.T) {
	for _, redisURL := range []string{"", "not-a-redis-url"} {
		t.Run(strconv.Quote(redisURL), func(t *testing.T) {
			t.Setenv("REDIS_URL", redisURL)

			configured, err := CheckRedis(context.Background())
			if configured {
				t.Fatal("CheckRedis configured = true, want false")
			}
			if err == nil {
				t.Fatal("CheckRedis error = nil, want configuration error")
			}
		})
	}
}

func TestJSONAndTextHelpersRoundTrip(t *testing.T) {
	ctx := context.Background()
	server, rdb := newRedisTestClient(t)

	type cached struct {
		Value string `json:"value"`
	}

	jsonKey := RedisKey("cache", "question", 7)
	if ok := SetJSON(ctx, rdb, jsonKey, cached{Value: "cached"}, 45*time.Second); !ok {
		t.Fatal("SetJSON(...) = false, want true")
	}
	if ttl := server.TTL(jsonKey); ttl != 45*time.Second {
		t.Fatalf("JSON TTL = %s, want %s", ttl, 45*time.Second)
	}

	got, ok := GetJSON[cached](ctx, rdb, jsonKey)
	if !ok || got != (cached{Value: "cached"}) {
		t.Fatalf("GetJSON(...) = (%#v, %t), want cached value", got, ok)
	}

	miss, ok := GetJSON[cached](ctx, rdb, RedisKey("cache", "question", 8))
	if ok || miss != (cached{}) {
		t.Fatalf("GetJSON(...) missing = (%#v, %t), want zero value and false", miss, ok)
	}

	textKey := RedisKey("cache-version", "questions")
	if err := rdb.Set(ctx, textKey, "3", 30*time.Second).Err(); err != nil {
		t.Fatalf("Set(%q) error = %v", textKey, err)
	}
	if ttl := server.TTL(textKey); ttl != 30*time.Second {
		t.Fatalf("text TTL = %s, want %s", ttl, 30*time.Second)
	}
	text, ok := GetText(ctx, rdb, textKey)
	if !ok || text != "3" {
		t.Fatalf("GetText(...) = (%q, %t), want (3, true)", text, ok)
	}
}

func TestIncrementRateLimitTracksWindowAndLimit(t *testing.T) {
	ctx := context.Background()
	server, rdb := newRedisTestClient(t)
	key := RedisKey("rate-limit", "auth:login", "alice@example.com")
	window := 30 * time.Second

	first, err := IncrementRateLimit(ctx, rdb, key, 2, window)
	if err != nil {
		t.Fatalf("first IncrementRateLimit returned error: %v", err)
	}
	if ttl := server.TTL(key); ttl != window {
		t.Fatalf("first rate-limit TTL = %s, want %s", ttl, window)
	}

	server.FastForward(5 * time.Second)
	second, err := IncrementRateLimit(ctx, rdb, key, 2, window)
	if err != nil {
		t.Fatalf("second IncrementRateLimit returned error: %v", err)
	}
	third, err := IncrementRateLimit(ctx, rdb, key, 2, window)
	if err != nil {
		t.Fatalf("third IncrementRateLimit returned error: %v", err)
	}

	if !first.Allowed || first.Count != 1 || first.Remaining != 1 {
		t.Fatalf("first IncrementRateLimit(...) = %#v, want allowed count=1 remaining=1", first)
	}
	if !second.Allowed || second.Count != 2 || second.Remaining != 0 {
		t.Fatalf("second IncrementRateLimit(...) = %#v, want allowed count=2 remaining=0", second)
	}
	if third.Allowed || third.Count != 3 || third.Remaining != 0 {
		t.Fatalf("third IncrementRateLimit(...) = %#v, want blocked count=3 remaining=0", third)
	}
	if first.ResetSeconds != 30 || second.ResetSeconds != 25 || third.ResetSeconds != 25 {
		t.Fatalf("reset seconds = (%d, %d, %d), want (30, 25, 25)", first.ResetSeconds, second.ResetSeconds, third.ResetSeconds)
	}
	if ttl := server.TTL(key); ttl != 25*time.Second {
		t.Fatalf("rate-limit TTL after later attempts = %s, want %s", ttl, 25*time.Second)
	}
}

func TestIncrementRateLimitRepairsMissingTTL(t *testing.T) {
	ctx := context.Background()
	server, rdb := newRedisTestClient(t)
	key := RedisKey("rate-limit", "auth", "login")
	if err := rdb.Set(ctx, key, "1", 0).Err(); err != nil {
		t.Fatalf("seed rate-limit key: %v", err)
	}

	result, err := IncrementRateLimit(ctx, rdb, key, 10, time.Minute)
	if err != nil {
		t.Fatalf("IncrementRateLimit returned error: %v", err)
	}
	if result.Count != 2 {
		t.Fatalf("IncrementRateLimit count = %d, want 2", result.Count)
	}
	if ttl := server.TTL(key); ttl != time.Minute {
		t.Fatalf("repaired rate-limit TTL = %s, want %s", ttl, time.Minute)
	}
}

func TestIncrementRateLimitReturnsRedisErrors(t *testing.T) {
	server, rdb := newRedisTestClient(t)
	server.SetError("ERR unavailable")

	if _, err := IncrementRateLimit(context.Background(), rdb, RedisKey("rate-limit", "auth", "login"), 10, time.Minute); err == nil {
		t.Fatal("IncrementRateLimit error = nil, want Redis failure")
	}
}

func TestPublishJSONDeliversPayloadOnExpectedChannel(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, rdb := newRedisTestClient(t)
	channel := ImportEventChannel(44)
	pubsub := rdb.Subscribe(ctx, channel)
	defer pubsub.Close()
	if _, err := pubsub.Receive(ctx); err != nil {
		t.Fatalf("subscribe to %q: %v", channel, err)
	}

	payload := map[string]any{"job_id": 44, "status": "queued", "message": "ready"}
	if ok := PublishJSON(ctx, rdb, channel, payload); !ok {
		t.Fatal("PublishJSON(...) = false, want true")
	}
	message, err := pubsub.ReceiveMessage(ctx)
	if err != nil {
		t.Fatalf("receive published message: %v", err)
	}
	if message.Channel != channel {
		t.Fatalf("published channel = %q, want %q", message.Channel, channel)
	}
	assertJSONEqual(t, message.Payload, payload)
}

func newRedisTestClient(t *testing.T) (*miniredis.Miniredis, *redis.Client) {
	t.Helper()
	server := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: server.Addr(), Protocol: 2})
	t.Cleanup(func() { _ = rdb.Close() })
	return server, rdb
}

func assertJSONEqual(t *testing.T, raw string, want any) {
	t.Helper()
	var gotValue any
	if err := json.Unmarshal([]byte(raw), &gotValue); err != nil {
		t.Fatalf("json.Unmarshal(%q) error = %v", raw, err)
	}
	wantBytes, err := json.Marshal(want)
	if err != nil {
		t.Fatalf("json.Marshal(%#v) error = %v", want, err)
	}
	var wantValue any
	if err := json.Unmarshal(wantBytes, &wantValue); err != nil {
		t.Fatalf("json.Unmarshal(%q) error = %v", wantBytes, err)
	}
	if !reflect.DeepEqual(gotValue, wantValue) {
		t.Fatalf("json payload = %#v, want %#v", gotValue, wantValue)
	}
}
