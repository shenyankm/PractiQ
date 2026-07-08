package imports

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestNewQueuePayloadUsesExistingJSONContract(t *testing.T) {
	requestedAt := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)

	payload := NewQueuePayload(123, 456, true, requestedAt, 2)
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("json.Marshal(payload) returned error: %v", err)
	}

	want := `{"jobId":123,"userId":456,"persistQuestions":true,"requestedAt":"2026-07-08T12:00:00.000Z","attempt":2}`
	if string(raw) != want {
		t.Fatalf("queue payload JSON = %s, want %s", raw, want)
	}
}

func TestQueueNameAndPhysicalKeysFollowConfiguredOrFallbackName(t *testing.T) {
	t.Run("fallback redis key", func(t *testing.T) {
		t.Setenv("IMPORT_QUEUE_NAME", "")
		t.Setenv("REDIS_KEY_PREFIX", "tenant-a")

		if got, want := QueueName(), "tenant-a:queue:imports"; got != want {
			t.Fatalf("QueueName() = %q, want %q", got, want)
		}

		keys := QueueKeys()
		if got, want := keys.Ready, "tenant-a:queue:imports:ready"; got != want {
			t.Fatalf("ready key = %q, want %q", got, want)
		}
		if got, want := keys.Delayed, "tenant-a:queue:imports:delayed"; got != want {
			t.Fatalf("delayed key = %q, want %q", got, want)
		}
		if got, want := keys.Processing, "tenant-a:queue:imports:processing"; got != want {
			t.Fatalf("processing key = %q, want %q", got, want)
		}
		if got, want := keys.Dead, "tenant-a:queue:imports:dead"; got != want {
			t.Fatalf("dead key = %q, want %q", got, want)
		}
	})

	t.Run("configured queue name", func(t *testing.T) {
		t.Setenv("IMPORT_QUEUE_NAME", "imports-high-priority")
		t.Setenv("REDIS_KEY_PREFIX", "ignored-prefix")

		if got, want := QueueName(), "imports-high-priority"; got != want {
			t.Fatalf("QueueName() = %q, want %q", got, want)
		}

		keys := QueueKeys()
		if got, want := keys.Ready, "imports-high-priority:ready"; got != want {
			t.Fatalf("ready key = %q, want %q", got, want)
		}
		if got, want := keys.Delayed, "imports-high-priority:delayed"; got != want {
			t.Fatalf("delayed key = %q, want %q", got, want)
		}
		if got, want := keys.Processing, "imports-high-priority:processing"; got != want {
			t.Fatalf("processing key = %q, want %q", got, want)
		}
		if got, want := keys.Dead, "imports-high-priority:dead"; got != want {
			t.Fatalf("dead key = %q, want %q", got, want)
		}
	})
}

func TestRetryBackoffUsesExponentialAttemptSchedule(t *testing.T) {
	t.Setenv("IMPORT_QUEUE_BACKOFF_MS", "5000")

	tests := []struct {
		attempt int
		want    time.Duration
	}{
		{attempt: 1, want: 5 * time.Second},
		{attempt: 2, want: 10 * time.Second},
		{attempt: 3, want: 20 * time.Second},
	}

	for _, tt := range tests {
		if got := RetryBackoff(tt.attempt); got != tt.want {
			t.Fatalf("RetryBackoff(%d) = %s, want %s", tt.attempt, got, tt.want)
		}
	}
}

func TestFilterPendingJobRemovesCancelledEntriesFromReadyAndDelayedSets(t *testing.T) {
	requestedAt := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	ready := []QueuePayload{
		NewQueuePayload(101, 1, true, requestedAt, 1),
		NewQueuePayload(202, 2, true, requestedAt, 1),
	}
	delayed := []QueuePayload{
		NewQueuePayload(101, 1, true, requestedAt, 2),
		NewQueuePayload(303, 3, false, requestedAt, 1),
	}

	nextReady, nextDelayed, removed := filterPendingJob(101, ready, delayed)
	if !removed {
		t.Fatal("filterPendingJob should report removing a queued or delayed job")
	}
	if len(nextReady) != 1 || nextReady[0].JobID != 202 {
		t.Fatalf("ready jobs after cancel = %#v, want only job 202", nextReady)
	}
	if len(nextDelayed) != 1 || nextDelayed[0].JobID != 303 {
		t.Fatalf("delayed jobs after cancel = %#v, want only job 303", nextDelayed)
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
		Message: "加入导入队列",
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
