package auth

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"io"
	"strings"
	"sync"
	"testing"
)

func TestHashPasswordUsesBcryptCost10AndDummyHashConstant(t *testing.T) {
	hash, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatalf("HashPassword returned error: %v", err)
	}
	if hash == "correct horse battery staple" {
		t.Fatal("hash echoes plaintext password")
	}

	parts := strings.Split(hash, "$")
	if len(parts) < 4 {
		t.Fatalf("hash = %q, want bcrypt encoded string", hash)
	}
	if parts[2] != "10" {
		t.Fatalf("bcrypt cost = %q, want %q", parts[2], "10")
	}
	if DummyPasswordHash != "$2y$10$bPkUrUZqKDqmW.xkPE5LBuqH6HB/QoOS4dYH42xQxevBJQMStTE0W" {
		t.Fatalf("DummyPasswordHash = %q, want migration dummy hash", DummyPasswordHash)
	}
}

func TestLookupUserPasswordByLoginUsesCaseInsensitiveUsernameOrEmailAndPasswordHashColumn(t *testing.T) {
	registerAuthLookupDriver()

	state := &authLookupState{
		columns: []string{"id", "password_hash"},
		rows: [][]driver.Value{{int64(42), "stored-password-hash"}},
	}
	setAuthLookupState(t, state)

	db, err := sql.Open(authLookupDriverName, "auth-lookup")
	if err != nil {
		t.Fatalf("sql.Open returned error: %v", err)
	}
	defer db.Close()

	got, err := LookupUserPasswordByLogin(context.Background(), db, "Alice@Example.com")
	if err != nil {
		t.Fatalf("LookupUserPasswordByLogin returned error: %v", err)
	}
	if got == nil {
		t.Fatal("LookupUserPasswordByLogin = nil, want password row")
	}
	if got.ID != 42 {
		t.Fatalf("id = %d, want %d", got.ID, 42)
	}
	if got.PasswordHash != "stored-password-hash" {
		t.Fatalf("password hash = %q, want %q", got.PasswordHash, "stored-password-hash")
	}

	normalizedQuery := strings.Join(strings.Fields(strings.ToLower(state.query)), " ")
	if !strings.Contains(normalizedQuery, "password_hash") {
		t.Fatalf("query = %q, want password_hash column", state.query)
	}
	if !strings.Contains(normalizedQuery, "lower(username) = lower($1)") {
		t.Fatalf("query = %q, want lower(username) comparison", state.query)
	}
	if !strings.Contains(normalizedQuery, "or lower(email) = lower($1)") {
		t.Fatalf("query = %q, want lower(email) comparison", state.query)
	}
	if len(state.args) != 1 || state.args[0] != "Alice@Example.com" {
		t.Fatalf("query args = %#v, want original login once", state.args)
	}
}

const authLookupDriverName = "openwook-auth-lookup"

var (
	authLookupDriverOnce sync.Once
	authLookupMu         sync.Mutex
	authLookupCurrent    *authLookupState
)

type authLookupState struct {
	query   string
	args    []any
	columns []string
	rows    [][]driver.Value
	err     error
}

func registerAuthLookupDriver() {
	authLookupDriverOnce.Do(func() {
		sql.Register(authLookupDriverName, authLookupDriver{})
	})
}

func setAuthLookupState(t *testing.T, state *authLookupState) {
	t.Helper()

	authLookupMu.Lock()
	authLookupCurrent = state
	authLookupMu.Unlock()

	t.Cleanup(func() {
		authLookupMu.Lock()
		authLookupCurrent = nil
		authLookupMu.Unlock()
	})
}

type authLookupDriver struct{}

func (authLookupDriver) Open(string) (driver.Conn, error) {
	return authLookupConn{}, nil
}

type authLookupConn struct{}

func (authLookupConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }
func (authLookupConn) Close() error                        { return nil }
func (authLookupConn) Begin() (driver.Tx, error)           { return nil, driver.ErrSkip }

func (authLookupConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	authLookupMu.Lock()
	defer authLookupMu.Unlock()

	if authLookupCurrent == nil {
		return nil, driver.ErrBadConn
	}
	authLookupCurrent.query = query
	authLookupCurrent.args = make([]any, 0, len(args))
	for _, arg := range args {
		authLookupCurrent.args = append(authLookupCurrent.args, arg.Value)
	}
	if authLookupCurrent.err != nil {
		return nil, authLookupCurrent.err
	}
	return &authLookupRows{columns: authLookupCurrent.columns, rows: authLookupCurrent.rows}, nil
}

var _ driver.QueryerContext = authLookupConn{}

type authLookupRows struct {
	columns []string
	rows    [][]driver.Value
	index   int
}

func (r *authLookupRows) Columns() []string { return r.columns }
func (r *authLookupRows) Close() error      { return nil }

func (r *authLookupRows) Next(dest []driver.Value) error {
	if r.index >= len(r.rows) {
		return io.EOF
	}
	copy(dest, r.rows[r.index])
	r.index++
	return nil
}
