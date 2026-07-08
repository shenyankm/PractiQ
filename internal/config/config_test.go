package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadAppliesDotenvPrecedenceEnvLocalThenEnvThenProcessEnv(t *testing.T) {
	resetConfigEnv(t)
	t.Setenv("POSTGRES_URL", "postgres://process:process@localhost:5432/openwook_test")
	t.Setenv("PORT", "4011")

	dir := t.TempDir()
	t.Chdir(dir)
	writeFile(t, dir, ".env", strings.Join([]string{
		"OPENWOOK_HOST=env-host",
		"AI_SERVICE_URL=http://env-file:8001",
	}, "\n")+"\n")
	writeFile(t, dir, ".env.local", strings.Join([]string{
		"AI_SERVICE_URL=http://env-local:8001",
	}, "\n")+"\n")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}

	if cfg.AIServiceURL != "http://env-local:8001" {
		t.Fatalf("AIServiceURL = %q, want %q", cfg.AIServiceURL, "http://env-local:8001")
	}
	if cfg.OpenWookHost != "env-host" {
		t.Fatalf("OpenWookHost = %q, want %q", cfg.OpenWookHost, "env-host")
	}
	if got := fmt.Sprint(cfg.Port); got != "4011" {
		t.Fatalf("Port = %s, want %s", got, "4011")
	}
}

func TestLoadPrefersPostgresURLOverDatabaseURL(t *testing.T) {
	resetConfigEnv(t)
	t.Setenv("DATABASE_URL", "postgres://database:database@localhost:5432/from_database_url")
	t.Setenv("POSTGRES_URL", "postgres://postgres:postgres@localhost:5432/from_postgres_url")

	dir := t.TempDir()
	t.Chdir(dir)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}

	if cfg.DatabaseURL != "postgres://postgres:postgres@localhost:5432/from_postgres_url" {
		t.Fatalf("DatabaseURL = %q, want POSTGRES_URL value", cfg.DatabaseURL)
	}
}

func TestLoadUsesDefaultsForNewVariablesAndAllowsLocalDevelopmentWithoutAIToken(t *testing.T) {
	resetConfigEnv(t)
	t.Setenv("POSTGRES_URL", "postgres://process:process@localhost:5432/openwook_test")
	t.Setenv("NODE_ENV", "development")

	dir := t.TempDir()
	t.Chdir(dir)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}

	if cfg.AIServiceURL != "http://127.0.0.1:8001" {
		t.Fatalf("AIServiceURL = %q, want %q", cfg.AIServiceURL, "http://127.0.0.1:8001")
	}
	if cfg.OpenWookHost != "127.0.0.1" {
		t.Fatalf("OpenWookHost = %q, want %q", cfg.OpenWookHost, "127.0.0.1")
	}
	if got := fmt.Sprint(cfg.Port); got != "3000" {
		t.Fatalf("Port = %s, want %s", got, "3000")
	}
	if cfg.AIServiceToken != "" {
		t.Fatalf("AIServiceToken = %q, want empty in localhost development", cfg.AIServiceToken)
	}
}

func TestLoadRequiresAIServiceTokenOutsideLocalDevelopment(t *testing.T) {
	tests := []struct {
		name         string
		nodeEnv      string
		aiServiceURL string
	}{
		{
			name:         "production",
			nodeEnv:      "production",
			aiServiceURL: "http://openwook-ai:8001",
		},
		{
			name:         "development remote service",
			nodeEnv:      "development",
			aiServiceURL: "https://ai.example.test",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resetConfigEnv(t)
			t.Setenv("POSTGRES_URL", "postgres://process:process@localhost:5432/openwook_test")
			t.Setenv("NODE_ENV", tt.nodeEnv)
			t.Setenv("AI_SERVICE_URL", tt.aiServiceURL)

			dir := t.TempDir()
			t.Chdir(dir)

			_, err := Load()
			if err == nil {
				t.Fatalf("Load returned nil error, want AI_SERVICE_TOKEN validation failure")
			}
			if !strings.Contains(err.Error(), "AI_SERVICE_TOKEN") {
				t.Fatalf("Load error = %q, want mention of AI_SERVICE_TOKEN", err.Error())
			}
		})
	}
}

func writeFile(t *testing.T, dir string, name string, content string) {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("WriteFile(%s) returned error: %v", name, err)
	}
}

func resetConfigEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"AI_SERVICE_TOKEN",
		"AI_SERVICE_URL",
		"DATABASE_URL",
		"NODE_ENV",
		"OPENWOOK_HOST",
		"PORT",
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
