package redisx

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"path"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

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

func TestImportEventKeysMatchExistingChannelAndStreamShapes(t *testing.T) {
	t.Setenv("REDIS_KEY_PREFIX", "openwook")

	if got, want := ImportEventChannel(123), "openwook:import:123:events"; got != want {
		t.Fatalf("ImportEventChannel(123) = %q, want %q", got, want)
	}

	if got, want := ImportEventStreamKey(123), "openwook:stream:import:123:events"; got != want {
		t.Fatalf("ImportEventStreamKey(123) = %q, want %q", got, want)
	}
}

func TestReleaseLockScriptMatchesTokenCheckedDeleteContract(t *testing.T) {
	const want = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

	if ReleaseLockScript != want {
		t.Fatalf("ReleaseLockScript = %q, want %q", ReleaseLockScript, want)
	}
}

func TestJSONAndTextHelpersRoundTripWithoutLiveRedis(t *testing.T) {
	ctx := context.Background()
	redis, _ := newFakeRedisHarness(t)

	type cached struct {
		Value string `json:"value"`
	}

	if ok := SetJSON(ctx, redis, RedisKey("cache", "question", 7), cached{Value: "cached"}, 45*time.Second); !ok {
		t.Fatalf("SetJSON(...) = false, want true")
	}

	got, ok := GetJSON[cached](ctx, redis, RedisKey("cache", "question", 7))
	if !ok {
		t.Fatalf("GetJSON(...) ok = false, want true")
	}
	if got != (cached{Value: "cached"}) {
		t.Fatalf("GetJSON(...) = %#v, want %#v", got, cached{Value: "cached"})
	}

	miss, ok := GetJSON[cached](ctx, redis, RedisKey("cache", "question", 8))
	if ok {
		t.Fatalf("GetJSON(...) ok = true on missing key, want false")
	}
	if miss != (cached{}) {
		t.Fatalf("GetJSON(...) missing value = %#v, want zero value", miss)
	}

	if ok := SetText(ctx, redis, RedisKey("cache-version", "questions"), "3", 30*time.Second); !ok {
		t.Fatalf("SetText(...) = false, want true")
	}

	text, ok := GetText(ctx, redis, RedisKey("cache-version", "questions"))
	if !ok {
		t.Fatalf("GetText(...) ok = false, want true")
	}
	if text != "3" {
		t.Fatalf("GetText(...) = %q, want %q", text, "3")
	}
}

func TestDeleteUsesUnlinkAndDeleteByPatternScansMatchingKeys(t *testing.T) {
	ctx := context.Background()
	redis, state := newFakeRedisHarness(t)

	mustSetText(t, ctx, redis, RedisKey("cache", "user", 1), "alice", time.Minute)
	mustSetText(t, ctx, redis, RedisKey("cache", "user", 2), "bob", time.Minute)
	mustSetText(t, ctx, redis, RedisKey("cache", "bank", 3), "chemistry", time.Minute)

	deleted := Delete(ctx, redis, RedisKey("cache", "user", 1), RedisKey("cache", "missing"))
	if deleted != 1 {
		t.Fatalf("Delete(...) = %d, want 1", deleted)
	}
	if got := state.unlinkCalls(); len(got) != 1 || !slices.Equal(got[0], []string{RedisKey("cache", "user", 1), RedisKey("cache", "missing")}) {
		t.Fatalf("Delete(...) unlink calls = %#v, want [[%q %q]]", got, RedisKey("cache", "user", 1), RedisKey("cache", "missing"))
	}

	deleted = DeleteByPattern(ctx, redis, RedisKey("cache", "user", "*"))
	if deleted != 1 {
		t.Fatalf("DeleteByPattern(...) = %d, want 1", deleted)
	}
	if _, ok := state.get(RedisKey("cache", "user", 2)); ok {
		t.Fatalf("DeleteByPattern(...) left matching key %q behind", RedisKey("cache", "user", 2))
	}
	if _, ok := state.get(RedisKey("cache", "bank", 3)); !ok {
		t.Fatalf("DeleteByPattern(...) deleted non-matching key %q", RedisKey("cache", "bank", 3))
	}
	if got := state.scanPatterns(); !slices.Equal(got, []string{RedisKey("cache", "user", "*")}) {
		t.Fatalf("DeleteByPattern(...) scan patterns = %#v, want [%q]", got, RedisKey("cache", "user", "*"))
	}
}

func TestIncrementRateLimitUsesIncrExpireAndTTLContract(t *testing.T) {
	ctx := context.Background()
	redis, state := newFakeRedisHarness(t)

	key := RedisKey("rate-limit", "auth:login", "alice@example.com")
	window := 30 * time.Second

	first := IncrementRateLimit(ctx, redis, key, 2, window)
	second := IncrementRateLimit(ctx, redis, key, 2, window)
	third := IncrementRateLimit(ctx, redis, key, 2, window)

	if !first.Allowed || first.Count != 1 || first.Remaining != 1 {
		t.Fatalf("first IncrementRateLimit(...) = %#v, want allowed count=1 remaining=1", first)
	}
	if !second.Allowed || second.Count != 2 || second.Remaining != 0 {
		t.Fatalf("second IncrementRateLimit(...) = %#v, want allowed count=2 remaining=0", second)
	}
	if third.Allowed || third.Count != 3 || third.Remaining != 0 {
		t.Fatalf("third IncrementRateLimit(...) = %#v, want blocked count=3 remaining=0", third)
	}
	if first.ResetSeconds <= 0 || second.ResetSeconds <= 0 || third.ResetSeconds <= 0 {
		t.Fatalf("IncrementRateLimit(...) reset seconds must stay positive: %#v %#v %#v", first, second, third)
	}
	if got := state.expireCalls(); !slices.Equal(got, []fakeExpireCall{{Key: key, Seconds: 30}}) {
		t.Fatalf("IncrementRateLimit(...) expire calls = %#v, want one EXPIRE(%q, 30)", got, key)
	}
}

func TestAcquireLockUsesSetNxPxAndTokenCheckedRelease(t *testing.T) {
	ctx := context.Background()
	redis, state := newFakeRedisHarness(t)

	key := RedisKey("lock", "import", 19, "parse")

	first := AcquireLock(ctx, redis, key, 30*time.Second)
	if !first.Acquired {
		t.Fatalf("AcquireLock(...) first = %#v, want acquired", first)
	}
	if first.Key != key {
		t.Fatalf("AcquireLock(...) key = %q, want %q", first.Key, key)
	}
	if strings.TrimSpace(first.Token) == "" {
		t.Fatalf("AcquireLock(...) token = %q, want non-empty", first.Token)
	}

	second := AcquireLock(ctx, redis, key, 30*time.Second)
	if second.Acquired {
		t.Fatalf("AcquireLock(...) second = %#v, want not acquired", second)
	}

	if released := first.Release(ctx); !released {
		t.Fatalf("first.Release(...) = false, want true")
	}
	if released := second.Release(ctx); released {
		t.Fatalf("second.Release(...) = true, want false for token mismatch")
	}

	third := AcquireLock(ctx, redis, key, 30*time.Second)
	if !third.Acquired {
		t.Fatalf("AcquireLock(...) third = %#v, want acquired after release", third)
	}

	evals := state.evalCalls()
	if len(evals) < 2 {
		t.Fatalf("expected at least two EVAL calls, got %#v", evals)
	}
	if evals[0].Script != ReleaseLockScript || evals[0].Key != key || evals[0].Token != first.Token {
		t.Fatalf("first release EVAL = %#v, want script/key/token match first lock", evals[0])
	}
	if evals[1].Script != ReleaseLockScript || evals[1].Key != key || evals[1].Token != second.Token {
		t.Fatalf("second release EVAL = %#v, want script/key/token match second lock", evals[1])
	}
}

func TestPublishAndAppendStreamHelpersEncodeJSONAndUseExpectedKeys(t *testing.T) {
	ctx := context.Background()
	redis, state := newFakeRedisHarness(t)

	payload := map[string]any{
		"job_id":  44,
		"status":  "queued",
		"message": "ready",
	}

	channel := ImportEventChannel(44)
	if ok := PublishJSON(ctx, redis, channel, payload); !ok {
		t.Fatalf("PublishJSON(...) = false, want true")
	}

	streamKey := ImportEventStreamKey(44)
	if ok := AppendStreamJSON(ctx, redis, streamKey, payload); !ok {
		t.Fatalf("AppendStreamJSON(...) = false, want true")
	}

	publishes := state.publishCalls()
	if len(publishes) != 1 {
		t.Fatalf("PublishJSON(...) calls = %#v, want one publish", publishes)
	}
	if publishes[0].Channel != channel {
		t.Fatalf("PublishJSON(...) channel = %q, want %q", publishes[0].Channel, channel)
	}
	assertJSONEqual(t, publishes[0].Payload, payload)

	appends := state.streamCalls()
	if len(appends) != 1 {
		t.Fatalf("AppendStreamJSON(...) calls = %#v, want one xadd", appends)
	}
	if appends[0].StreamKey != streamKey {
		t.Fatalf("AppendStreamJSON(...) key = %q, want %q", appends[0].StreamKey, streamKey)
	}
	if appends[0].MaxLen != 500 {
		t.Fatalf("AppendStreamJSON(...) maxLen = %d, want 500", appends[0].MaxLen)
	}
	if appends[0].Field != "payload" {
		t.Fatalf("AppendStreamJSON(...) field = %q, want %q", appends[0].Field, "payload")
	}
	assertJSONEqual(t, appends[0].Payload, payload)
}

func mustSetText(t *testing.T, ctx context.Context, redis *redis.Client, key, value string, ttl time.Duration) {
	t.Helper()
	if ok := SetText(ctx, redis, key, value, ttl); !ok {
		t.Fatalf("SetText(%q) = false, want true", key)
	}
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

type fakeExpireCall struct {
	Key     string
	Seconds int64
}

type fakeEvalCall struct {
	Script string
	Key    string
	Token  string
}

type fakePublishCall struct {
	Channel string
	Payload string
}

type fakeStreamCall struct {
	StreamKey string
	MaxLen    int64
	Field     string
	Payload   string
}

type fakeRedisState struct {
	mu          sync.Mutex
	values      map[string]string
	expiresAt   map[string]time.Time
	expireLog   []fakeExpireCall
	scanLog     []string
	unlinkLog   [][]string
	evalLog     []fakeEvalCall
	publishLog  []fakePublishCall
	streamLog   []fakeStreamCall
	xaddCounter int64
}

func (s *fakeRedisState) get(key string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.purgeExpiredLocked()
	value, ok := s.values[key]
	return value, ok
}

func (s *fakeRedisState) expireCalls() []fakeExpireCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]fakeExpireCall(nil), s.expireLog...)
}

func (s *fakeRedisState) scanPatterns() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.scanLog...)
}

func (s *fakeRedisState) unlinkCalls() [][]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([][]string, 0, len(s.unlinkLog))
	for _, call := range s.unlinkLog {
		out = append(out, append([]string(nil), call...))
	}
	return out
}

func (s *fakeRedisState) evalCalls() []fakeEvalCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]fakeEvalCall(nil), s.evalLog...)
}

func (s *fakeRedisState) publishCalls() []fakePublishCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]fakePublishCall(nil), s.publishLog...)
}

func (s *fakeRedisState) streamCalls() []fakeStreamCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]fakeStreamCall(nil), s.streamLog...)
}

func (s *fakeRedisState) handle(command []string) fakeReply {
	if len(command) == 0 {
		return fakeSimple("OK")
	}

	switch strings.ToUpper(command[0]) {
	case "CLIENT", "SELECT":
		return fakeSimple("OK")
	case "PING":
		return fakeSimple("PONG")
	case "GET":
		return s.handleGet(command)
	case "SET":
		return s.handleSet(command)
	case "UNLINK":
		return s.handleUnlink(command[1:])
	case "SCAN":
		return s.handleScan(command)
	case "INCR":
		return s.handleIncr(command)
	case "EXPIRE":
		return s.handleExpire(command)
	case "TTL":
		return s.handleTTL(command)
	case "EVAL":
		return s.handleEval(command)
	case "PUBLISH":
		return s.handlePublish(command)
	case "XADD":
		return s.handleXAdd(command)
	default:
		return fakeError("ERR unsupported command " + command[0])
	}
}

func (s *fakeRedisState) handleGet(command []string) fakeReply {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.purgeExpiredLocked()
	value, ok := s.values[command[1]]
	if !ok {
		return fakeNil()
	}
	return fakeBulk(value)
}

func (s *fakeRedisState) handleSet(command []string) fakeReply {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.purgeExpiredLocked()

	key := command[1]
	value := command[2]
	var ttl time.Duration
	var nx bool
	for i := 3; i < len(command); i++ {
		switch strings.ToUpper(command[i]) {
		case "EX":
			seconds, _ := strconv.Atoi(command[i+1])
			ttl = time.Duration(seconds) * time.Second
			i++
		case "PX":
			millis, _ := strconv.Atoi(command[i+1])
			ttl = time.Duration(millis) * time.Millisecond
			i++
		case "NX":
			nx = true
		}
	}
	if nx {
		if _, exists := s.values[key]; exists {
			return fakeNil()
		}
	}
	s.values[key] = value
	if ttl > 0 {
		s.expiresAt[key] = time.Now().Add(ttl)
	} else {
		delete(s.expiresAt, key)
	}
	return fakeSimple("OK")
}

func (s *fakeRedisState) handleUnlink(keys []string) fakeReply {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.purgeExpiredLocked()

	s.unlinkLog = append(s.unlinkLog, append([]string(nil), keys...))
	var deleted int64
	for _, key := range keys {
		if _, ok := s.values[key]; ok {
			delete(s.values, key)
			delete(s.expiresAt, key)
			deleted++
		}
	}
	return fakeInt(deleted)
}

func (s *fakeRedisState) handleScan(command []string) fakeReply {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.purgeExpiredLocked()

	cursor := command[1]
	pattern := "*"
	count := 10
	for i := 2; i < len(command); i += 2 {
		switch strings.ToUpper(command[i]) {
		case "MATCH":
			pattern = command[i+1]
		case "COUNT":
			count, _ = strconv.Atoi(command[i+1])
		}
	}
	s.scanLog = append(s.scanLog, pattern)

	keys := make([]string, 0, len(s.values))
	for key := range s.values {
		if matched, _ := path.Match(pattern, key); matched {
			keys = append(keys, key)
		}
	}
	slices.Sort(keys)
	start := 0
	if cursor != "0" {
		start, _ = strconv.Atoi(cursor)
	}
	if start >= len(keys) {
		return fakeArray(fakeBulk("0"), fakeArray())
	}
	end := start + count
	if end > len(keys) {
		end = len(keys)
	}
	nextCursor := "0"
	if end < len(keys) {
		nextCursor = strconv.Itoa(end)
	}
	items := make([]fakeReply, 0, end-start)
	for _, key := range keys[start:end] {
		items = append(items, fakeBulk(key))
	}
	return fakeArray(fakeBulk(nextCursor), fakeArray(items...))
}

func (s *fakeRedisState) handleIncr(command []string) fakeReply {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.purgeExpiredLocked()

	key := command[1]
	current, _ := strconv.ParseInt(s.values[key], 10, 64)
	current++
	s.values[key] = strconv.FormatInt(current, 10)
	return fakeInt(current)
}

func (s *fakeRedisState) handleExpire(command []string) fakeReply {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.purgeExpiredLocked()

	key := command[1]
	seconds, _ := strconv.ParseInt(command[2], 10, 64)
	if _, ok := s.values[key]; !ok {
		return fakeInt(0)
	}
	s.expiresAt[key] = time.Now().Add(time.Duration(seconds) * time.Second)
	s.expireLog = append(s.expireLog, fakeExpireCall{Key: key, Seconds: seconds})
	return fakeInt(1)
}

func (s *fakeRedisState) handleTTL(command []string) fakeReply {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.purgeExpiredLocked()

	key := command[1]
	if _, ok := s.values[key]; !ok {
		return fakeInt(-2)
	}
	expiresAt, ok := s.expiresAt[key]
	if !ok {
		return fakeInt(-1)
	}
	remaining := time.Until(expiresAt)
	if remaining <= 0 {
		delete(s.values, key)
		delete(s.expiresAt, key)
		return fakeInt(-2)
	}
	return fakeInt(int64((remaining + time.Second - 1) / time.Second))
}

func (s *fakeRedisState) handleEval(command []string) fakeReply {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.purgeExpiredLocked()

	script := command[1]
	numKeys, _ := strconv.Atoi(command[2])
	if numKeys != 1 || len(command) < 5 {
		return fakeError("ERR unsupported eval shape")
	}
	key := command[3]
	token := command[4]
	s.evalLog = append(s.evalLog, fakeEvalCall{Script: script, Key: key, Token: token})
	if current, ok := s.values[key]; ok && current == token {
		delete(s.values, key)
		delete(s.expiresAt, key)
		return fakeInt(1)
	}
	return fakeInt(0)
}

func (s *fakeRedisState) handlePublish(command []string) fakeReply {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.publishLog = append(s.publishLog, fakePublishCall{Channel: command[1], Payload: command[2]})
	return fakeInt(1)
}

func (s *fakeRedisState) handleXAdd(command []string) fakeReply {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.xaddCounter++
	s.streamLog = append(s.streamLog, fakeStreamCall{
		StreamKey: command[1],
		MaxLen:    mustParseInt64(command[4]),
		Field:     command[6],
		Payload:   command[7],
	})
	return fakeBulk(fmt.Sprintf("%d-0", s.xaddCounter))
}

func (s *fakeRedisState) purgeExpiredLocked() {
	now := time.Now()
	for key, expiresAt := range s.expiresAt {
		if !expiresAt.After(now) {
			delete(s.expiresAt, key)
			delete(s.values, key)
		}
	}
}

func newFakeRedisHarness(t *testing.T) (*redis.Client, *fakeRedisState) {
	t.Helper()

	state := &fakeRedisState{
		values:    make(map[string]string),
		expiresAt: make(map[string]time.Time),
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen(...) error = %v", err)
	}
	t.Cleanup(func() {
		_ = listener.Close()
	})

	go serveFakeRedis(listener, state)

	oldClient := client
	oldOnce := clientOnce
	redisClient := redis.NewClient(&redis.Options{Addr: listener.Addr().String(), Protocol: 2})
	client = redisClient
	clientOnce = sync.Once{}
	clientOnce.Do(func() {})
	t.Cleanup(func() {
		_ = redisClient.Close()
		client = oldClient
		clientOnce = oldOnce
	})

	return redisClient, state
}

func serveFakeRedis(listener net.Listener, state *fakeRedisState) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		go serveFakeRedisConn(conn, state)
	}
}

func serveFakeRedisConn(conn net.Conn, state *fakeRedisState) {
	defer conn.Close()

	reader := bufio.NewReader(conn)
	writer := bufio.NewWriter(conn)
	for {
		command, err := readRESPArray(reader)
		if err != nil {
			if err == io.EOF {
				return
			}
			_, _ = writer.WriteString("-" + err.Error() + "\r\n")
			_ = writer.Flush()
			return
		}
		if _, err := writer.Write(state.handle(command).encode()); err != nil {
			return
		}
		if err := writer.Flush(); err != nil {
			return
		}
	}
}

type fakeReply struct {
	encode func() []byte
}

func fakeSimple(value string) fakeReply {
	return fakeReply{encode: func() []byte { return []byte("+" + value + "\r\n") }}
}

func fakeBulk(value string) fakeReply {
	return fakeReply{encode: func() []byte { return []byte(fmt.Sprintf("$%d\r\n%s\r\n", len(value), value)) }}
}

func fakeNil() fakeReply {
	return fakeReply{encode: func() []byte { return []byte("$-1\r\n") }}
}

func fakeInt(value int64) fakeReply {
	return fakeReply{encode: func() []byte { return []byte(fmt.Sprintf(":%d\r\n", value)) }}
}

func fakeError(message string) fakeReply {
	return fakeReply{encode: func() []byte { return []byte("-" + message + "\r\n") }}
}

func fakeArray(items ...fakeReply) fakeReply {
	return fakeReply{encode: func() []byte {
		var builder strings.Builder
		builder.WriteString(fmt.Sprintf("*%d\r\n", len(items)))
		for _, item := range items {
			builder.Write(item.encode())
		}
		return []byte(builder.String())
	}}
}

func readRESPArray(reader *bufio.Reader) ([]string, error) {
	header, err := reader.ReadString('\n')
	if err != nil {
		return nil, err
	}
	header = strings.TrimSuffix(strings.TrimSuffix(header, "\n"), "\r")
	if !strings.HasPrefix(header, "*") {
		return nil, fmt.Errorf("unsupported resp header %q", header)
	}
	count, err := strconv.Atoi(strings.TrimPrefix(header, "*"))
	if err != nil {
		return nil, err
	}
	values := make([]string, count)
	for i := range count {
		lengthHeader, err := reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		lengthHeader = strings.TrimSuffix(strings.TrimSuffix(lengthHeader, "\n"), "\r")
		if !strings.HasPrefix(lengthHeader, "$") {
			return nil, fmt.Errorf("unsupported bulk header %q", lengthHeader)
		}
		length, err := strconv.Atoi(strings.TrimPrefix(lengthHeader, "$"))
		if err != nil {
			return nil, err
		}
		payload := make([]byte, length+2)
		if _, err := io.ReadFull(reader, payload); err != nil {
			return nil, err
		}
		values[i] = string(payload[:length])
	}
	return values, nil
}

func mustParseInt64(raw string) int64 {
	value, _ := strconv.ParseInt(raw, 10, 64)
	return value
}
