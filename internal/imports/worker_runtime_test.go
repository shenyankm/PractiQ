package imports

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func TestLoadWorkerConfigUsesQueueHelpersAndEnv(t *testing.T) {
	t.Setenv("IMPORT_QUEUE_NAME", "")
	t.Setenv("REDIS_KEY_PREFIX", "tenant-a")
	t.Setenv("IMPORT_WORKER_CONCURRENCY", "4")
	t.Setenv("IMPORT_QUEUE_ATTEMPTS", "5")
	t.Setenv("IMPORT_JOB_LOCK_TTL_MS", "1800000")
	t.Setenv("IMPORT_QUEUE_POLL_TIMEOUT_MS", "2500")

	cfg := LoadWorkerConfig()
	keys := QueueKeys()

	if got, want := cfg.QueueName, "tenant-a:queue:imports"; got != want {
		t.Fatalf("QueueName = %q, want %q", got, want)
	}
	if got, want := cfg.Keys, keys; got != want {
		t.Fatalf("Keys = %#v, want %#v", got, want)
	}
	if got, want := cfg.Concurrency, 4; got != want {
		t.Fatalf("Concurrency = %d, want %d", got, want)
	}
	if got, want := cfg.MaxAttempts, 5; got != want {
		t.Fatalf("MaxAttempts = %d, want %d", got, want)
	}
	if got, want := cfg.LockTTL, 30*time.Minute; got != want {
		t.Fatalf("LockTTL = %s, want %s", got, want)
	}
	if got, want := cfg.PollTimeout, 2500*time.Millisecond; got != want {
		t.Fatalf("PollTimeout = %s, want %s", got, want)
	}
}

func TestScheduleRetryUsesCurrentAttemptDelayAndIncrementsAttempt(t *testing.T) {
	cfg := WorkerConfig{MaxAttempts: 3}
	now := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	payload := NewQueuePayload(123, 456, true, now, 1)

	next, readyAt, ok := cfg.ScheduleRetry(payload, now)
	if !ok {
		t.Fatal("ScheduleRetry should allow retry before max attempts")
	}
	if got, want := next.Attempt, 2; got != want {
		t.Fatalf("next.Attempt = %d, want %d", got, want)
	}
	if got, want := readyAt.Sub(now), 5*time.Second; got != want {
		t.Fatalf("readyAt - now = %s, want %s", got, want)
	}
}

func TestScheduleRetryStopsAtConfiguredAttemptLimit(t *testing.T) {
	cfg := WorkerConfig{MaxAttempts: 3}
	now := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	payload := NewQueuePayload(123, 456, true, now, 3)

	_, _, ok := cfg.ScheduleRetry(payload, now)
	if ok {
		t.Fatal("ScheduleRetry should stop at configured max attempts")
	}
}

func TestFinalAttemptExhaustionDoesNotLeaveDeadLetterPayload(t *testing.T) {
	ctx := context.Background()
	runtime, state := newFakeQueueRuntimeHarness(t)
	payload := NewQueuePayload(123, 456, true, time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC), 3)

	retried, err := runtime.EnqueueRetry(ctx, payload, time.Date(2026, 7, 8, 12, 5, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("EnqueueRetry(...) error = %v", err)
	}
	if retried {
		t.Fatal("EnqueueRetry(...) retried = true, want final attempt exhaustion")
	}
	if got := state.listLen(runtime.Config.Keys.Dead); got != 0 {
		t.Fatalf("dead-letter entries = %d, want 0 because terminal failures must not stop at dead-lettering", got)
	}
}

func TestEnqueueReadyDoesNotDuplicateSameJobAcrossParseStartAndRetry(t *testing.T) {
	tests := []struct {
		name    string
		payload QueuePayload
	}{
		{name: "parse", payload: NewQueuePayload(321, 654, false, time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC), 1)},
		{name: "start", payload: NewQueuePayload(321, 654, true, time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC), 1)},
		{name: "retry", payload: NewQueuePayload(321, 654, true, time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC), 1)},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := context.Background()
			runtime, state := newFakeQueueRuntimeHarness(t)

			if err := runtime.EnqueueReady(ctx, tt.payload); err != nil {
				t.Fatalf("first EnqueueReady(...) error = %v", err)
			}
			if err := runtime.EnqueueReady(ctx, tt.payload); err != nil {
				t.Fatalf("second EnqueueReady(...) error = %v", err)
			}
			if got := state.listLen(runtime.Config.Keys.Ready); got != 1 {
				t.Fatalf("ready payload count = %d, want 1 for duplicate %s enqueue", got, tt.name)
			}
		})
	}
}

func newFakeQueueRuntimeHarness(t *testing.T) (*QueueRuntime, *fakeQueueRedisState) {
	t.Helper()

	state := &fakeQueueRedisState{
		hashes: make(map[string]map[string]string),
		lists:  make(map[string][]string),
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen(...) error = %v", err)
	}
	t.Cleanup(func() {
		_ = listener.Close()
	})

	go serveFakeQueueRedis(listener, state)

	redisClient := redis.NewClient(&redis.Options{Addr: listener.Addr().String(), Protocol: 2})
	if err := redisClient.Ping(context.Background()).Err(); err != nil {
		_ = redisClient.Close()
		t.Fatalf("redis ping error = %v", err)
	}
	t.Cleanup(func() {
		_ = redisClient.Close()
	})

	t.Setenv("IMPORT_QUEUE_NAME", "test-imports")
	runtime, err := NewQueueRuntime(redisClient, WorkerConfig{QueueName: "test-imports", Keys: QueueKeys(), MaxAttempts: 3, PollTimeout: 10 * time.Millisecond})
	if err != nil {
		t.Fatalf("NewQueueRuntime(...) error = %v", err)
	}
	return runtime, state
}

type fakeQueueRedisState struct {
	mu     sync.Mutex
	hashes map[string]map[string]string
	lists  map[string][]string
}

func (s *fakeQueueRedisState) listLen(key string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.lists[key])
}

func (s *fakeQueueRedisState) handle(command []string) fakeQueueReply {
	if len(command) == 0 {
		return fakeQueueError("ERR empty command")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	switch strings.ToUpper(command[0]) {
	case "PING":
		return fakeQueueSimple("PONG")
	case "HEXISTS":
		if len(command) != 3 {
			return fakeQueueError("ERR wrong number of arguments for HEXISTS")
		}
		if fields := s.hashes[command[1]]; fields != nil {
			if _, exists := fields[command[2]]; exists {
				return fakeQueueInt(1)
			}
		}
		return fakeQueueInt(0)
	case "DEL":
		var deleted int64
		for _, key := range command[1:] {
			if _, ok := s.hashes[key]; ok {
				delete(s.hashes, key)
				deleted++
			}
			if _, ok := s.lists[key]; ok {
				delete(s.lists, key)
				deleted++
			}
		}
		return fakeQueueInt(deleted)
	case "HSET":
		if len(command) < 4 || len(command)%2 != 0 {
			return fakeQueueError("ERR wrong number of arguments for HSET")
		}
		key := command[1]
		if s.hashes[key] == nil {
			s.hashes[key] = make(map[string]string)
		}
		var added int64
		for i := 2; i < len(command); i += 2 {
			field := command[i]
			if _, exists := s.hashes[key][field]; !exists {
				added++
			}
			s.hashes[key][field] = command[i+1]
		}
		return fakeQueueInt(added)
	case "HDEL":
		if len(command) < 3 {
			return fakeQueueError("ERR wrong number of arguments for HDEL")
		}
		key := command[1]
		var deleted int64
		if fields := s.hashes[key]; fields != nil {
			for _, field := range command[2:] {
				if _, exists := fields[field]; exists {
					delete(fields, field)
					deleted++
				}
			}
			if len(fields) == 0 {
				delete(s.hashes, key)
			}
		}
		return fakeQueueInt(deleted)
	case "HLEN":
		if len(command) != 2 {
			return fakeQueueError("ERR wrong number of arguments for HLEN")
		}
		return fakeQueueInt(int64(len(s.hashes[command[1]])))
	case "LPUSH":
		if len(command) < 3 {
			return fakeQueueError("ERR wrong number of arguments for LPUSH")
		}
		key := command[1]
		list := append([]string(nil), s.lists[key]...)
		for _, value := range command[2:] {
			list = append([]string{value}, list...)
		}
		s.lists[key] = list
		return fakeQueueInt(int64(len(list)))
	case "LRANGE":
		if len(command) != 4 {
			return fakeQueueError("ERR wrong number of arguments for LRANGE")
		}
		return fakeQueueArrayFromStrings(s.lists[command[1]]...)
	case "LLEN":
		if len(command) != 2 {
			return fakeQueueError("ERR wrong number of arguments for LLEN")
		}
		return fakeQueueInt(int64(len(s.lists[command[1]])))
	case "ZRANGE":
		return fakeQueueArray()
	default:
		return fakeQueueError("ERR unsupported command " + strings.ToUpper(command[0]))
	}
}

func serveFakeQueueRedis(listener net.Listener, state *fakeQueueRedisState) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		go serveFakeQueueRedisConn(conn, state)
	}
}

func serveFakeQueueRedisConn(conn net.Conn, state *fakeQueueRedisState) {
	defer conn.Close()

	reader := bufio.NewReader(conn)
	writer := bufio.NewWriter(conn)
	for {
		command, err := readQueueRESPArray(reader)
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

type fakeQueueReply struct {
	encode func() []byte
}

func fakeQueueSimple(value string) fakeQueueReply {
	return fakeQueueReply{encode: func() []byte { return []byte("+" + value + "\r\n") }}
}

func fakeQueueBulk(value string) fakeQueueReply {
	return fakeQueueReply{encode: func() []byte { return []byte(fmt.Sprintf("$%d\r\n%s\r\n", len(value), value)) }}
}

func fakeQueueArray(items ...fakeQueueReply) fakeQueueReply {
	return fakeQueueReply{encode: func() []byte {
		var builder strings.Builder
		builder.WriteString(fmt.Sprintf("*%d\r\n", len(items)))
		for _, item := range items {
			builder.Write(item.encode())
		}
		return []byte(builder.String())
	}}
}

func fakeQueueArrayFromStrings(values ...string) fakeQueueReply {
	items := make([]fakeQueueReply, 0, len(values))
	for _, value := range values {
		items = append(items, fakeQueueBulk(value))
	}
	return fakeQueueArray(items...)
}

func fakeQueueInt(value int64) fakeQueueReply {
	return fakeQueueReply{encode: func() []byte { return []byte(fmt.Sprintf(":%d\r\n", value)) }}
}

func fakeQueueError(message string) fakeQueueReply {
	return fakeQueueReply{encode: func() []byte { return []byte("-" + message + "\r\n") }}
}

func readQueueRESPArray(reader *bufio.Reader) ([]string, error) {
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
	for i := 0; i < count; i++ {
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
