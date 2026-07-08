package imports

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

type WorkerConfig struct {
	QueueName   string
	Keys        PhysicalQueueKeys
	Concurrency int
	MaxAttempts int
	LockTTL     time.Duration
	PollTimeout time.Duration
}

type QueueRuntime struct {
	Redis  *redis.Client
	Config WorkerConfig
}

type delayedPayload struct {
	Raw   string
	Score float64
	Data  QueuePayload
}

func LoadWorkerConfig() WorkerConfig {
	return WorkerConfig{
		QueueName:   QueueName(),
		Keys:        QueueKeys(),
		Concurrency: envInt("IMPORT_WORKER_CONCURRENCY", 2),
		MaxAttempts: envInt("IMPORT_QUEUE_ATTEMPTS", 3),
		LockTTL:     time.Duration(envInt("IMPORT_JOB_LOCK_TTL_MS", 30*60*1000)) * time.Millisecond,
		PollTimeout: time.Duration(envInt("IMPORT_QUEUE_POLL_TIMEOUT_MS", 5000)) * time.Millisecond,
	}
}

func (cfg WorkerConfig) normalize() WorkerConfig {
	if cfg.QueueName == "" {
		cfg.QueueName = QueueName()
	}
	if cfg.Keys == (PhysicalQueueKeys{}) {
		cfg.Keys = QueueKeys()
	}
	if cfg.Concurrency <= 0 {
		cfg.Concurrency = 2
	}
	if cfg.MaxAttempts <= 0 {
		cfg.MaxAttempts = 3
	}
	if cfg.LockTTL <= 0 {
		cfg.LockTTL = 30 * time.Minute
	}
	if cfg.PollTimeout <= 0 {
		cfg.PollTimeout = 5 * time.Second
	}
	return cfg
}

func (cfg WorkerConfig) ScheduleRetry(payload QueuePayload, now time.Time) (QueuePayload, time.Time, bool) {
	cfg = cfg.normalize()
	currentAttempt := payload.Attempt
	if currentAttempt <= 0 {
		currentAttempt = 1
	}
	if currentAttempt >= cfg.MaxAttempts {
		return QueuePayload{}, time.Time{}, false
	}
	next := payload
	next.Attempt = currentAttempt + 1
	readyAt := now.UTC().Add(RetryBackoff(currentAttempt))
	return next, readyAt, true
}

func MarshalQueuePayload(payload QueuePayload) (string, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

func ParseQueuePayload(raw string) (QueuePayload, error) {
	var payload QueuePayload
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return QueuePayload{}, err
	}
	if payload.Attempt <= 0 {
		payload.Attempt = 1
	}
	return payload, nil
}

func NewQueueRuntime(rdb *redis.Client, cfg WorkerConfig) (*QueueRuntime, error) {
	if rdb == nil {
		return nil, errors.New("redis import queue is not configured")
	}
	return &QueueRuntime{Redis: rdb, Config: cfg.normalize()}, nil
}

func (rt *QueueRuntime) EnqueueReady(ctx context.Context, payload QueuePayload) error {
	if pending, err := rt.HasPendingJob(ctx, payload.JobID); err != nil {
		return err
	} else if pending {
		return nil
	}
	raw, err := MarshalQueuePayload(payload)
	if err != nil {
		return err
	}
	return rt.Redis.LPush(ctx, rt.Config.Keys.Ready, raw).Err()
}

func (rt *QueueRuntime) EnqueueRetry(ctx context.Context, payload QueuePayload, now time.Time) (bool, error) {
	next, readyAt, ok := rt.Config.ScheduleRetry(payload, now)
	if !ok {
		return false, nil
	}
	raw, err := MarshalQueuePayload(next)
	if err != nil {
		return false, err
	}
	return true, rt.Redis.ZAdd(ctx, rt.Config.Keys.Delayed, redis.Z{Score: float64(readyAt.UnixMilli()), Member: raw}).Err()
}

func (rt *QueueRuntime) PromoteDueDelayed(ctx context.Context, now time.Time, limit int64) (int, error) {
	if limit <= 0 {
		limit = int64(rt.Config.Concurrency)
		if limit <= 0 {
			limit = 1
		}
	}
	entries, err := rt.Redis.ZRangeByScoreWithScores(ctx, rt.Config.Keys.Delayed, &redis.ZRangeBy{
		Min:    "-inf",
		Max:    strconv.FormatInt(now.UTC().UnixMilli(), 10),
		Offset: 0,
		Count:  limit,
	}).Result()
	if err != nil {
		return 0, err
	}
	moved := 0
	for _, entry := range entries {
		raw := fmt.Sprint(entry.Member)
		pipe := rt.Redis.TxPipeline()
		pipe.ZRem(ctx, rt.Config.Keys.Delayed, raw)
		pipe.LPush(ctx, rt.Config.Keys.Ready, raw)
		if _, err := pipe.Exec(ctx); err != nil {
			return moved, err
		}
		moved++
	}
	return moved, nil
}

func (rt *QueueRuntime) ReserveNext(ctx context.Context) (*QueuePayload, error) {
	if _, err := rt.PromoteDueDelayed(ctx, time.Now(), int64(rt.Config.Concurrency)); err != nil {
		return nil, err
	}
	result, err := rt.Redis.BRPop(ctx, rt.Config.PollTimeout, rt.Config.Keys.Ready).Result()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			return nil, nil
		}
		return nil, err
	}
	if len(result) < 2 {
		return nil, nil
	}
	payload, err := ParseQueuePayload(result[1])
	if err != nil {
		return nil, err
	}
	if err := rt.Redis.HSet(ctx, rt.Config.Keys.Processing, processingField(payload.JobID), result[1]).Err(); err != nil {
		return nil, err
	}
	return &payload, nil
}

func (rt *QueueRuntime) Complete(ctx context.Context, payload QueuePayload) error {
	return rt.Redis.HDel(ctx, rt.Config.Keys.Processing, processingField(payload.JobID)).Err()
}

func (rt *QueueRuntime) Fail(ctx context.Context, payload QueuePayload, now time.Time) (bool, error) {
	if err := rt.Complete(ctx, payload); err != nil {
		return false, err
	}
	return rt.EnqueueRetry(ctx, payload, now)
}

func (rt *QueueRuntime) HasPendingJob(ctx context.Context, jobID int) (bool, error) {
	if pending, err := rt.Redis.HExists(ctx, rt.Config.Keys.Processing, processingField(jobID)).Result(); err != nil {
		return false, err
	} else if pending {
		return true, nil
	}
	ready, err := rt.readReady(ctx)
	if err != nil {
		return false, err
	}
	for _, item := range ready {
		if item.Data.JobID == jobID {
			return true, nil
		}
	}
	delayed, err := rt.readDelayed(ctx)
	if err != nil {
		return false, err
	}
	for _, item := range delayed {
		if item.Data.JobID == jobID {
			return true, nil
		}
	}
	return false, nil
}

func (rt *QueueRuntime) CancelPendingJob(ctx context.Context, jobID int) (bool, error) {
	ready, err := rt.readReady(ctx)
	if err != nil {
		return false, err
	}
	delayed, err := rt.readDelayed(ctx)
	if err != nil {
		return false, err
	}
	filteredReady, filteredDelayed, removed := filterRuntimePending(jobID, ready, delayed)
	if !removed {
		return false, nil
	}
	pipe := rt.Redis.TxPipeline()
	pipe.Del(ctx, rt.Config.Keys.Ready)
	pipe.Del(ctx, rt.Config.Keys.Delayed)
	for _, item := range filteredReady {
		pipe.RPush(ctx, rt.Config.Keys.Ready, item.Raw)
	}
	for _, item := range filteredDelayed {
		pipe.ZAdd(ctx, rt.Config.Keys.Delayed, redis.Z{Score: item.Score, Member: item.Raw})
	}
	_, err = pipe.Exec(ctx)
	return err == nil, err
}

func (rt *QueueRuntime) Run(ctx context.Context, handler func(context.Context, QueuePayload) error) error {
	if handler == nil {
		return errors.New("worker handler is required")
	}
	for {
		if err := ctx.Err(); err != nil {
			if errors.Is(err, context.Canceled) {
				return nil
			}
			return err
		}
		payload, err := rt.ReserveNext(ctx)
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return nil
			}
			return err
		}
		if payload == nil {
			continue
		}
		if err := handler(ctx, *payload); err != nil {
			if _, retryErr := rt.Fail(ctx, *payload, time.Now()); retryErr != nil {
				return errors.Join(err, retryErr)
			}
			continue
		}
		if err := rt.Complete(ctx, *payload); err != nil {
			return err
		}
	}
}

func filterRuntimePending(jobID int, ready []queueEntry, delayed []delayedPayload) ([]queueEntry, []delayedPayload, bool) {
	readyPayloads := make([]QueuePayload, len(ready))
	for i, item := range ready {
		readyPayloads[i] = item.Data
	}
	delayedPayloads := make([]QueuePayload, len(delayed))
	for i, item := range delayed {
		delayedPayloads[i] = item.Data
	}
	nextReadyPayloads, nextDelayedPayloads, removed := filterPendingJob(jobID, readyPayloads, delayedPayloads)
	if !removed {
		return ready, delayed, false
	}
	readyByJobID := map[int]queueEntry{}
	for _, item := range ready {
		readyByJobID[item.Data.JobID] = item
	}
	delayedByJobID := map[int]delayedPayload{}
	for _, item := range delayed {
		delayedByJobID[item.Data.JobID] = item
	}
	nextReady := make([]queueEntry, 0, len(nextReadyPayloads))
	for _, payload := range nextReadyPayloads {
		nextReady = append(nextReady, readyByJobID[payload.JobID])
	}
	nextDelayed := make([]delayedPayload, 0, len(nextDelayedPayloads))
	for _, payload := range nextDelayedPayloads {
		nextDelayed = append(nextDelayed, delayedByJobID[payload.JobID])
	}
	return nextReady, nextDelayed, true
}

type queueEntry struct {
	Raw  string
	Data QueuePayload
}

func (rt *QueueRuntime) readReady(ctx context.Context) ([]queueEntry, error) {
	values, err := rt.Redis.LRange(ctx, rt.Config.Keys.Ready, 0, -1).Result()
	if err != nil {
		return nil, err
	}
	entries := make([]queueEntry, 0, len(values))
	for _, raw := range values {
		payload, err := ParseQueuePayload(raw)
		if err != nil {
			return nil, err
		}
		entries = append(entries, queueEntry{Raw: raw, Data: payload})
	}
	return entries, nil
}

func (rt *QueueRuntime) readDelayed(ctx context.Context) ([]delayedPayload, error) {
	values, err := rt.Redis.ZRangeWithScores(ctx, rt.Config.Keys.Delayed, 0, -1).Result()
	if err != nil {
		return nil, err
	}
	entries := make([]delayedPayload, 0, len(values))
	for _, item := range values {
		raw := fmt.Sprint(item.Member)
		payload, err := ParseQueuePayload(raw)
		if err != nil {
			return nil, err
		}
		entries = append(entries, delayedPayload{Raw: raw, Score: item.Score, Data: payload})
	}
	return entries, nil
}

func processingField(jobID int) string {
	return strconv.Itoa(jobID)
}
