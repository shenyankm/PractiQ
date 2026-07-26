package imports

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestClaimNextJobSQLUsesOneAtomicSkipLockedUpdate(t *testing.T) {
	query := strings.ToUpper(strings.Join(strings.Fields(claimNextJobSQL), " "))
	for _, fragment := range []string{
		"WITH NEXT_JOB AS",
		"STATUS = 'QUEUED'",
		"AVAILABLE_AT IS NOT NULL",
		"AVAILABLE_AT <= NOW()",
		"STATUS = 'PROCESSING'",
		"UPDATED_AT <= NOW()",
		"FOR UPDATE SKIP LOCKED",
		"UPDATE QUESTION_IMPORT_JOBS AS JOB",
		"SET STATUS = 'PROCESSING'",
		"CLAIM_VERSION = JOB.CLAIM_VERSION + 1",
		"NEXT_JOB.PERSISTENCE_STARTED",
		"NEXT_JOB.ATTEMPTS_EXHAUSTED",
	} {
		if !strings.Contains(query, fragment) {
			t.Fatalf("claim SQL missing %q: %s", fragment, query)
		}
	}
	if strings.Index(query, "FOR UPDATE SKIP LOCKED") > strings.Index(query, "UPDATE QUESTION_IMPORT_JOBS AS JOB") {
		t.Fatalf("claim SQL must select the locked job before updating it: %s", query)
	}
}

func TestWorkerMutationSQLRequiresCurrentClaimBeforePersistence(t *testing.T) {
	for name, testCase := range map[string]struct {
		query     string
		fragments []string
	}{
		"begin persistence": {
			query:     beginPersistenceSQL,
			fragments: []string{"SET STAGE = 'PERSISTING'", "STAGE = 'PROCESSING'", "CLAIM_VERSION = $2"},
		},
		"requeue": {
			query:     requeueJobSQL,
			fragments: []string{"SET STATUS = 'QUEUED'", "STAGE = 'PROCESSING'", "CLAIM_VERSION = $3"},
		},
		"release": {
			query:     releaseJobSQL,
			fragments: []string{"SET STATUS = 'QUEUED'", "GREATEST(RETRY_COUNT - 1, 0)", "CLAIM_VERSION = $2"},
		},
	} {
		t.Run(name, func(t *testing.T) {
			query := strings.ToUpper(strings.Join(strings.Fields(testCase.query), " "))
			for _, fragment := range testCase.fragments {
				if !strings.Contains(query, fragment) {
					t.Fatalf("SQL missing %q: %s", fragment, query)
				}
			}
		})
	}
}

func TestRetryBackoffUsesFixedThreeAttemptSchedule(t *testing.T) {
	if MaxAttempts != 3 {
		t.Fatalf("MaxAttempts = %d, want 3", MaxAttempts)
	}
	for attempt, want := range map[int]time.Duration{
		1: time.Second,
		2: 2 * time.Second,
		3: 4 * time.Second,
	} {
		if got := RetryBackoff(attempt); got != want {
			t.Fatalf("RetryBackoff(%d) = %s, want %s", attempt, got, want)
		}
	}
}

func TestWriteEventStreamHeadersUsesSSEContract(t *testing.T) {
	headers := http.Header{}
	WriteEventStreamHeaders(headers)

	if got := headers.Get("Cache-Control"); got != "no-cache, no-transform" {
		t.Fatalf("Cache-Control = %q, want no-cache, no-transform", got)
	}
	if got := headers.Get("Connection"); got != "keep-alive" {
		t.Fatalf("Connection = %q, want keep-alive", got)
	}
	if got := headers.Get("Content-Type"); !strings.HasPrefix(got, "text/event-stream") {
		t.Fatalf("Content-Type = %q, want text/event-stream", got)
	}
}

func TestEncodeImportEventUsesImportEventNameAndIDFrame(t *testing.T) {
	encoded := EncodeImportEvent(ImportEvent{
		ID:      77,
		JobID:   123,
		Stage:   "queued",
		Status:  "queued",
		Message: "joined import queue",
	})

	if !strings.Contains(encoded, "id: 77\n") {
		t.Fatalf("encoded event missing id line: %q", encoded)
	}
	if !strings.Contains(encoded, "event: import-event\n") {
		t.Fatalf("encoded event missing import-event name: %q", encoded)
	}
	if !strings.Contains(encoded, `"job_id":123`) {
		t.Fatalf("encoded event missing job_id payload: %q", encoded)
	}
	if !strings.HasSuffix(encoded, "\n\n") {
		t.Fatalf("encoded event must end with a blank line, got %q", encoded)
	}
}
