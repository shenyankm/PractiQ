package main

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"practiq/internal/aiclient"
)

func TestWorkerRunRequiresPostgresAndAIClient(t *testing.T) {
	if err := (&workerApp{client: new(aiclient.Client)}).Run(context.Background()); err == nil || !strings.Contains(err.Error(), "PostgreSQL") {
		t.Fatalf("Run without PostgreSQL error = %v", err)
	}
	if err := (&workerApp{pool: new(pgxpool.Pool)}).Run(context.Background()); err == nil || !strings.Contains(err.Error(), "AI client") {
		t.Fatalf("Run without AI client error = %v", err)
	}
}

func TestShouldRequeueOnlyBeforePersistenceAndAttemptLimit(t *testing.T) {
	for _, tt := range []struct {
		name               string
		attempt            int
		persistenceStarted bool
		want               bool
	}{
		{name: "retry parse failure", attempt: 1, want: true},
		{name: "last attempt", attempt: 3, want: false},
		{name: "persistence started", attempt: 1, persistenceStarted: true, want: false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := shouldRequeue(tt.attempt, tt.persistenceStarted); got != tt.want {
				t.Fatalf("shouldRequeue(%d, %t) = %t, want %t", tt.attempt, tt.persistenceStarted, got, tt.want)
			}
		})
	}
}
