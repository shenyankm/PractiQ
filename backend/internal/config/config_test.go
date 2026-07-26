package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLoadAppliesDotenvPrecedenceEnvLocalThenEnvThenProcessEnv(t *testing.T) {
	resetConfigEnv(t)
	t.Setenv("POSTGRES_URL", "postgres://process:process@localhost:5432/openwook_test")
	t.Setenv("PORT", "4011")
	t.Setenv("AUTH_SECRET", "test-auth-secret")
	t.Setenv("AI_SERVICE_TOKEN", "test-ai-token")

	dir := t.TempDir()
	t.Chdir(dir)
	writeFile(t, dir, ".env", strings.Join([]string{
		"OPENWOOK_HOST=env-host",
		"AI_SERVICE_URL=http://env-file:8001",
		"APP_ORIGIN=http://env-origin:3000",
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
	if cfg.AppOrigin != "http://env-origin:3000" {
		t.Fatalf("AppOrigin = %q, want %q", cfg.AppOrigin, "http://env-origin:3000")
	}
	if got := fmt.Sprint(cfg.Port); got != "4011" {
		t.Fatalf("Port = %s, want %s", got, "4011")
	}
}

func TestLoadUsesDefaultsForNewVariablesAndAllowsLocalDevelopmentWithoutAIToken(t *testing.T) {
	resetConfigEnv(t)
	t.Setenv("POSTGRES_URL", "postgres://process:process@localhost:5432/openwook_test")
	t.Setenv("NODE_ENV", "development")
	t.Setenv("AUTH_SECRET", "test-auth-secret")

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
	if got := fmt.Sprint(cfg.Port); got != "8080" {
		t.Fatalf("Port = %s, want %s", got, "8080")
	}
	if cfg.AIServiceToken != "" {
		t.Fatalf("AIServiceToken = %q, want empty in localhost development", cfg.AIServiceToken)
	}
	if cfg.AIServiceTimeout != DefaultAIServiceTimeout {
		t.Fatalf("AIServiceTimeout = %v, want %v", cfg.AIServiceTimeout, DefaultAIServiceTimeout)
	}
}

func TestLoadParsesAIServiceTimeout(t *testing.T) {
	resetConfigEnv(t)
	t.Setenv("POSTGRES_URL", "postgres://process:process@localhost:5432/openwook_test")
	t.Setenv("AUTH_SECRET", "test-auth-secret")
	t.Setenv("AI_SERVICE_TIMEOUT", "30m")

	dir := t.TempDir()
	t.Chdir(dir)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.AIServiceTimeout != 30*time.Minute {
		t.Fatalf("AIServiceTimeout = %v, want %v", cfg.AIServiceTimeout, 30*time.Minute)
	}

	t.Setenv("AI_SERVICE_TIMEOUT", "-5s")
	if _, err := Load(); err == nil {
		t.Fatal("Load with negative AI_SERVICE_TIMEOUT should fail")
	}

	t.Setenv("AI_SERVICE_TIMEOUT", "nonsense")
	if _, err := Load(); err == nil {
		t.Fatal("Load with invalid AI_SERVICE_TIMEOUT should fail")
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
			t.Setenv("AUTH_SECRET", "test-auth-secret")

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

func TestLoadFindsRootDotenvSyncsProcessEnvironmentAndKeepsProcessOverrides(t *testing.T) {
	resetConfigEnv(t)
	t.Setenv("POSTGRES_URL", "postgres://process:process@localhost:5432/openwook_test")

	root := filepath.Join(t.TempDir(), "openwook")
	backendDir := filepath.Join(root, "backend")
	if err := os.MkdirAll(backendDir, 0o755); err != nil {
		t.Fatalf("MkdirAll(%q) returned error: %v", backendDir, err)
	}
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatalf("Mkdir(%q) returned error: %v", filepath.Join(root, ".git"), err)
	}
	writeFile(t, root, ".env.local", strings.Join([]string{
		"POSTGRES_URL=postgres://dotenv:dotenv@localhost:5432/openwook",
		"REDIS_URL=redis://127.0.0.1:6379/0",
		"AUTH_SECRET=dotenv-auth-secret",
		"SESSION_TTL_MS=120000",
		"PORT=8099",
	}, "\n")+"\n")
	t.Chdir(backendDir)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}

	if cfg.Port != 8099 {
		t.Fatalf("Port = %d, want root dotenv value 8099", cfg.Port)
	}
	for key, want := range map[string]string{
		"POSTGRES_URL":   "postgres://process:process@localhost:5432/openwook_test",
		"REDIS_URL":      "redis://127.0.0.1:6379/0",
		"AUTH_SECRET":    "dotenv-auth-secret",
		"SESSION_TTL_MS": "120000",
	} {
		if got := os.Getenv(key); got != want {
			t.Fatalf("%s = %q, want %q", key, got, want)
		}
	}
}

func TestLoadRequiresAuthSecretInEveryEnvironment(t *testing.T) {
	resetConfigEnv(t)
	t.Setenv("NODE_ENV", "development")

	dir := t.TempDir()
	t.Chdir(dir)

	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "AUTH_SECRET") {
		t.Fatalf("Load error = %v, want AUTH_SECRET validation failure", err)
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
		"AUTH_SECRET",
		"AI_SERVICE_TOKEN",
		"AI_SERVICE_URL",
		"AI_SERVICE_TIMEOUT",
		"NODE_ENV",
		"OPENWOOK_HOST",
		"PORT",
		"POSTGRES_URL",
		"REDIS_URL",
		"APP_ORIGIN",
		"SESSION_TTL_MS",
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
