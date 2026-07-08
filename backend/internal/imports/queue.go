package imports

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"openwook/internal/redisx"
)

type JSONTime time.Time

func (t JSONTime) MarshalJSON() ([]byte, error) {
	return []byte(`"` + time.Time(t).UTC().Format("2006-01-02T15:04:05.000Z") + `"`), nil
}
func (t *JSONTime) UnmarshalJSON(data []byte) error {
	var raw string
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	parsed, err := time.Parse("2006-01-02T15:04:05.000Z", raw)
	if err != nil {
		return err
	}
	*t = JSONTime(parsed)
	return nil
}

type QueuePayload struct {
	JobID            int      `json:"jobId"`
	UserID           int      `json:"userId"`
	PersistQuestions bool     `json:"persistQuestions"`
	RequestedAt      JSONTime `json:"requestedAt"`
	Attempt          int      `json:"attempt"`
}

type PhysicalQueueKeys struct {
	Ready      string
	Delayed    string
	Processing string
	Dead       string
}

type ImportEvent struct {
	ID                     int64  `json:"id"`
	JobID                  int    `json:"job_id"`
	Stage                  string `json:"stage"`
	StepCode               string `json:"step_code,omitempty"`
	StepLabel              string `json:"step_label,omitempty"`
	Status                 string `json:"status"`
	Message                string `json:"message,omitempty"`
	OverallProgressPercent *int   `json:"overall_progress_percent,omitempty"`
	StepProgressPercent    *int   `json:"step_progress_percent,omitempty"`
}

func NewQueuePayload(jobID, userID int, persistQuestions bool, requestedAt time.Time, attempt int) QueuePayload {
	return QueuePayload{JobID: jobID, UserID: userID, PersistQuestions: persistQuestions, RequestedAt: JSONTime(requestedAt.UTC()), Attempt: attempt}
}

func QueueName() string {
	if configured := strings.TrimSpace(os.Getenv("IMPORT_QUEUE_NAME")); configured != "" {
		return configured
	}
	return redisx.RedisKey("queue", "imports")
}

func QueueKeys() PhysicalQueueKeys {
	name := QueueName()
	return PhysicalQueueKeys{
		Ready:      name + ":ready",
		Delayed:    name + ":delayed",
		Processing: name + ":processing",
		Dead:       name + ":dead",
	}
}

func RetryBackoff(attempt int) time.Duration {
	base := time.Duration(envInt("IMPORT_QUEUE_BACKOFF_MS", 5000)) * time.Millisecond
	if attempt <= 1 {
		return base
	}
	return base * time.Duration(1<<(attempt-1))
}

func filterPendingJob(jobID int, ready, delayed []QueuePayload) ([]QueuePayload, []QueuePayload, bool) {
	var removed bool
	filter := func(source []QueuePayload) []QueuePayload {
		out := source[:0]
		for _, item := range source {
			if item.JobID == jobID {
				removed = true
				continue
			}
			out = append(out, item)
		}
		return out
	}
	return filter(ready), filter(delayed), removed
}

func WriteEventStreamHeaders(headers http.Header) {
	headers.Set("Cache-Control", "no-cache, no-transform")
	headers.Set("Connection", "keep-alive")
	headers.Set("Content-Type", "text/event-stream; charset=utf-8")
}

func EncodeImportEvent(event ImportEvent) string {
	payload, _ := json.Marshal(event)
	return fmt.Sprintf("id: %d\nevent: import-event\ndata: %s\n\n", event.ID, payload)
}

func envInt(name string, fallback int) int {
	value, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name)))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}
