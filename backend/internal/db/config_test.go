package db

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestLoadConfigPrefersPostgresPoolMaxOverDatabasePoolMax(t *testing.T) {
	resetDBEnv(t)
	t.Setenv("POSTGRES_URL", "postgres://postgres:postgres@localhost:5432/openwook_test")
	t.Setenv("DATABASE_POOL_MAX", "3")
	t.Setenv("POSTGRES_POOL_MAX", "8")

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig returned error: %v", err)
	}

	if got := int(cfg.MaxConns); got != 8 {
		t.Fatalf("MaxConns = %d, want POSTGRES_POOL_MAX value %d", got, 8)
	}
}

func TestLoadConfigAcceptsPoolTimeouts(t *testing.T) {
	resetDBEnv(t)
	t.Setenv("POSTGRES_URL", "postgres://postgres:postgres@localhost:5432/openwook_test")
	t.Setenv("POSTGRES_IDLE_TIMEOUT_SECONDS", "45")
	t.Setenv("POSTGRES_CONNECT_TIMEOUT_SECONDS", "12")

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig returned error: %v", err)
	}

	if cfg.IdleTimeout != 45*time.Second {
		t.Fatalf("IdleTimeout = %s, want %s", cfg.IdleTimeout, 45*time.Second)
	}
	if cfg.ConnectTimeout != 12*time.Second {
		t.Fatalf("ConnectTimeout = %s, want %s", cfg.ConnectTimeout, 12*time.Second)
	}
}

func TestCollectSQLFilesUsesNumericPrefixOrder(t *testing.T) {
	root := t.TempDir()
	for _, relative := range []string{
		"db/users/10_users.sql",
		"db/core/20_indexes.sql",
		"db/core/00_functions.sql",
		"db/banks/05_banks.sql",
	} {
		writeSQLFixture(t, root, relative)
	}

	got, err := CollectSQLFiles(root)
	if err != nil {
		t.Fatalf("CollectSQLFiles returned error: %v", err)
	}

	gotRelative := make([]string, 0, len(got))
	for _, path := range got {
		relative, err := filepath.Rel(root, path)
		if err != nil {
			t.Fatalf("filepath.Rel(%q, %q) returned error: %v", root, path, err)
		}
		gotRelative = append(gotRelative, filepath.ToSlash(relative))
	}

	want := []string{
		"db/core/00_functions.sql",
		"db/banks/05_banks.sql",
		"db/users/10_users.sql",
		"db/core/20_indexes.sql",
	}
	if !reflect.DeepEqual(gotRelative, want) {
		t.Fatalf("CollectSQLFiles order = %v, want %v", gotRelative, want)
	}
}

func writeSQLFixture(t *testing.T, root string, relative string) {
	t.Helper()
	fullPath := filepath.Join(root, relative)
	if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
		t.Fatalf("MkdirAll(%q) returned error: %v", filepath.Dir(fullPath), err)
	}
	if err := os.WriteFile(fullPath, []byte("select 1;\n"), 0o600); err != nil {
		t.Fatalf("WriteFile(%q) returned error: %v", fullPath, err)
	}
}

func resetDBEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"DATABASE_POOL_MAX",
		"POSTGRES_CONNECT_TIMEOUT_SECONDS",
		"POSTGRES_IDLE_TIMEOUT_SECONDS",
		"POSTGRES_POOL_MAX",
		"POSTGRES_URL",
	} {
		unsetEnv(t, key)
	}
}

func unsetEnv(t *testing.T, key string) {
	t.Helper()
	value, ok := os.LookupEnv(key)
	if err := os.Unsetenv(key); err != nil {
		t.Fatalf("Unsetenv(%s) returned error: %v", key, err)
	}
	t.Cleanup(func() {
		if !ok {
			_ = os.Unsetenv(key)
			return
		}
		_ = os.Setenv(key, value)
	})
}
