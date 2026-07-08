package auth

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestSetSessionIssuesRevocableJTIAndClearSessionRevokesIt(t *testing.T) {
	t.Setenv("NODE_ENV", "test")
	t.Setenv("AUTH_SECRET", "runtime-secret")

	redisURL, store := startFakeRedisForAuthTest(t)
	t.Setenv("REDIS_URL", redisURL)

	setRecorder := httptest.NewRecorder()
	if err := SetSession(setRecorder, 41); err != nil {
		t.Fatalf("SetSession returned error: %v", err)
	}

	sessionCookie := findSessionCookie(t, setRecorder.Result().Cookies())
	payload, err := VerifySessionToken(sessionCookie.Value)
	if err != nil {
		t.Fatalf("VerifySessionToken returned error: %v", err)
	}
	if strings.TrimSpace(payload.JTI) == "" {
		t.Fatal("SetSession must issue a non-empty jti so logout can revoke the session")
	}

	clearRecorder := httptest.NewRecorder()
	clearRequest := httptest.NewRequest(http.MethodPost, "https://app.example.test/api/v1/auth/logout", nil)
	clearRequest.AddCookie(sessionCookie)
	if err := ClearSession(clearRecorder, clearRequest); err != nil {
		t.Fatalf("ClearSession returned error: %v", err)
	}

	clearedCookie := findSessionCookie(t, clearRecorder.Result().Cookies())
	if clearedCookie.Value != "" {
		t.Fatalf("cleared session cookie value = %q, want empty", clearedCookie.Value)
	}
	if got := clearRecorder.Header().Get("Set-Cookie"); !strings.Contains(got, "Max-Age=0") {
		t.Fatalf("Set-Cookie = %q, want Max-Age=0", got)
	}
	if raw, ok := store.get(sessionRevocationKey(payload.JTI)); !ok || raw != "true" {
		t.Fatalf("revocation entry = (%q, %t), want (true, true)", raw, ok)
	}
}

func findSessionCookie(t *testing.T, cookies []*http.Cookie) *http.Cookie {
	t.Helper()

	for _, cookie := range cookies {
		if cookie.Name == "session" {
			return cookie
		}
	}
	t.Fatal("session cookie not found")
	return nil
}

var (
	fakeAuthRedisOnce  sync.Once
	fakeAuthRedisURL   string
	fakeAuthRedisStore = &fakeAuthRedisState{values: make(map[string]string)}
)

type fakeAuthRedisState struct {
	mu     sync.Mutex
	values map[string]string
}

func (s *fakeAuthRedisState) reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.values = make(map[string]string)
}

func (s *fakeAuthRedisState) set(key, value string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.values == nil {
		s.values = make(map[string]string)
	}
	s.values[key] = value
}

func (s *fakeAuthRedisState) get(key string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	value, ok := s.values[key]
	return value, ok
}

func startFakeRedisForAuthTest(t *testing.T) (string, *fakeAuthRedisState) {
	t.Helper()

	fakeAuthRedisOnce.Do(func() {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatalf("listen fake redis: %v", err)
		}
		fakeAuthRedisURL = "redis://" + listener.Addr().String() + "/0"
		go serveFakeAuthRedis(listener, fakeAuthRedisStore)
	})
	fakeAuthRedisStore.reset()
	return fakeAuthRedisURL, fakeAuthRedisStore
}

func serveFakeAuthRedis(listener net.Listener, state *fakeAuthRedisState) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		go serveFakeAuthRedisConn(conn, state)
	}
}

func serveFakeAuthRedisConn(conn net.Conn, state *fakeAuthRedisState) {
	defer conn.Close()

	reader := bufio.NewReader(conn)
	for {
		command, err := readFakeAuthRESPArray(reader)
		if err != nil {
			return
		}
		if len(command) == 0 {
			_, _ = conn.Write([]byte("+OK\r\n"))
			continue
		}
		switch strings.ToUpper(command[0]) {
		case "HELLO":
			_, _ = conn.Write([]byte("*14\r\n$6\r\nserver\r\n$5\r\nredis\r\n$7\r\nversion\r\n$5\r\n7.0.0\r\n$5\r\nproto\r\n:2\r\n$2\r\nid\r\n:1\r\n$4\r\nmode\r\n$10\r\nstandalone\r\n$4\r\nrole\r\n$6\r\nmaster\r\n$7\r\nmodules\r\n*0\r\n"))
		case "SET":
			if len(command) >= 3 {
				state.set(command[1], command[2])
			}
			_, _ = conn.Write([]byte("+OK\r\n"))
		case "PING":
			_, _ = conn.Write([]byte("+PONG\r\n"))
		default:
			_, _ = conn.Write([]byte("+OK\r\n"))
		}
	}
}

func readFakeAuthRESPArray(reader *bufio.Reader) ([]string, error) {
	prefix, err := reader.ReadByte()
	if err != nil {
		return nil, err
	}
	if prefix != '*' {
		return nil, fmt.Errorf("unsupported resp prefix %q", prefix)
	}

	line, err := reader.ReadString('\n')
	if err != nil {
		return nil, err
	}
	var count int
	if _, err := fmt.Sscanf(line, "%d\r\n", &count); err != nil {
		return nil, err
	}

	parts := make([]string, 0, count)
	for range count {
		if prefix, err = reader.ReadByte(); err != nil {
			return nil, err
		}
		if prefix != '$' {
			return nil, fmt.Errorf("unsupported resp bulk prefix %q", prefix)
		}
		line, err = reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		var size int
		if _, err := fmt.Sscanf(line, "%d\r\n", &size); err != nil {
			return nil, err
		}
		buf := make([]byte, size+2)
		if _, err := io.ReadFull(reader, buf); err != nil {
			return nil, err
		}
		parts = append(parts, string(buf[:size]))
	}
	return parts, nil
}
