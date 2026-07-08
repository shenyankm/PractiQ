package main

import "testing"

func TestNewWorkerAppRequiresRedis(t *testing.T) {
	t.Setenv("POSTGRES_URL", "postgres://user:pass@localhost:5432/openwook")
	t.Setenv("AI_SERVICE_URL", "http://127.0.0.1:8001")
	t.Setenv("REDIS_URL", "")

	_, err := newWorkerApp()
	if err == nil {
		t.Fatal("newWorkerApp() error = nil, want missing redis error")
	}
}
