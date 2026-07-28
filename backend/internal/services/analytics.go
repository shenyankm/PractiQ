package services

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"practiq/internal/api"
	"practiq/internal/auth"
	"practiq/internal/redisx"
)

type AnalyticsSummary struct {
	OwnedBanks     int `json:"owned_banks"`
	FavoriteBanks  int `json:"favorite_banks"`
	Attempts       int `json:"attempts"`
	Correct        int `json:"correct"`
	Wrong          int `json:"wrong"`
	Sessions       int `json:"sessions"`
	ActiveSessions int `json:"active_sessions"`
	ActiveImports  int `json:"active_imports"`
	Accuracy       int `json:"accuracy"`
}

type BankAnalytics struct {
	CompletedCount int `json:"completed_count"`
	WrongCount     int `json:"wrong_count"`
	PracticedUsers int `json:"practiced_users"`
	AnswerCount    int `json:"answer_count"`
}

type BankLeaderboardEntry struct {
	UserID          int64      `json:"user_id"`
	Username        string     `json:"username"`
	CompletedCount  int        `json:"completed_count"`
	WrongCount      int        `json:"wrong_count"`
	LastPracticedAt *time.Time `json:"last_practiced_at"`
	AccuracyPercent float64    `json:"accuracy_percent"`
}

type WeakQuestionStat struct {
	QuestionID     int64    `json:"question_id"`
	AttemptCount   int      `json:"attempt_count"`
	CorrectCount   int      `json:"correct_count"`
	WrongCount     int      `json:"wrong_count"`
	MasteryScore   *float64 `json:"mastery_score"`
	Stem           string   `json:"stem"`
	QuestionTypeID string   `json:"question_type_id"`
}

type UserStatsSnapshot struct {
	Summary        AnalyticsSummary   `json:"summary"`
	RecentSessions []PracticeSession  `json:"recentSessions"`
	WeakQuestions  []WeakQuestionStat `json:"weakQuestions"`
}

type ImportAnalytics struct {
	ID                     int64      `json:"id"`
	CreatedBy              int64      `json:"created_by"`
	BankID                 *int64     `json:"bank_id"`
	Status                 string     `json:"status"`
	Stage                  string     `json:"stage"`
	AvailableAt            *time.Time `json:"available_at"`
	PersistQuestions       bool       `json:"persist_questions"`
	RequestPayload         string     `json:"request_payload"`
	RawResultJSON          *string    `json:"raw_result_json"`
	WarningMessages        string     `json:"warning_messages"`
	TotalQuestions         int        `json:"total_questions"`
	ImportedQuestions      int        `json:"imported_questions"`
	FileName               *string    `json:"file_name"`
	SourceType             *string    `json:"source_type"`
	RetryCount             int        `json:"retry_count"`
	QualityScore           float64    `json:"quality_score"`
	OverallProgressPercent *float64   `json:"overall_progress_percent"`
	StepProgressPercent    *float64   `json:"step_progress_percent"`
	LastErrorCode          *string    `json:"last_error_code"`
	LastError              *string    `json:"last_error"`
	LastEventID            *int64     `json:"last_event_id"`
	LastEventAt            *time.Time `json:"last_event_at"`
	CreatedAt              time.Time  `json:"created_at"`
	UpdatedAt              time.Time  `json:"updated_at"`
	CompletedAt            *time.Time `json:"completed_at"`
	Events                 int        `json:"events"`
	Outputs                int        `json:"outputs"`
}

func GetAnalyticsSummary(ctx context.Context, db *pgxpool.Pool, user *auth.User) (AnalyticsSummary, error) {
	if user == nil {
		return AnalyticsSummary{}, api.NewError(401, "UNAUTHENTICATED", "Authentication required", nil)
	}
	version := analyticsCacheVersion(ctx, "analytics", user.ID)
	return loadAnalyticsCachedJSON(ctx, redisx.RedisKey("cache", "analytics", "user", user.ID, version, "summary"), analyticsCacheTTL(), func() (AnalyticsSummary, error) {
		var summary AnalyticsSummary
		err := db.QueryRow(ctx, `
			SELECT
				(SELECT COUNT(*)::int FROM user_bank_links WHERE user_id = $1 AND is_owner = true) AS owned_banks,
				(SELECT COUNT(*)::int FROM user_bank_links WHERE user_id = $1 AND is_favorite = true) AS favorite_banks,
				COALESCE((SELECT SUM(attempt_count)::int FROM user_question_stats WHERE user_id = $1), 0) AS attempts,
				COALESCE((SELECT SUM(correct_count)::int FROM user_question_stats WHERE user_id = $1), 0) AS correct,
				COALESCE((SELECT SUM(wrong_count)::int FROM user_question_stats WHERE user_id = $1), 0) AS wrong,
				(SELECT COUNT(*)::int FROM user_practice_sessions WHERE user_id = $1) AS sessions,
				(SELECT COUNT(*)::int FROM user_practice_sessions WHERE user_id = $1 AND status = 'active') AS active_sessions,
				(SELECT COUNT(*)::int FROM question_import_jobs WHERE created_by = $1 AND status IN ('queued', 'processing')) AS active_imports
		`, user.ID).Scan(
			&summary.OwnedBanks,
			&summary.FavoriteBanks,
			&summary.Attempts,
			&summary.Correct,
			&summary.Wrong,
			&summary.Sessions,
			&summary.ActiveSessions,
			&summary.ActiveImports,
		)
		if err != nil {
			return AnalyticsSummary{}, err
		}
		if summary.Attempts > 0 {
			summary.Accuracy = int(math.Round(float64(summary.Correct) / float64(summary.Attempts) * 100))
		}
		return summary, nil
	})
}

func GetBankAnalytics(ctx context.Context, db *pgxpool.Pool, user *auth.User, bankID int64) (BankAnalytics, error) {
	if _, err := GetBank(ctx, db, user, bankID); err != nil {
		return BankAnalytics{}, err
	}
	version := analyticsCacheVersion(ctx, "bank-analytics", bankID)
	return loadAnalyticsCachedJSON(ctx, redisx.RedisKey("cache", "bank-analytics", "bank", bankID, version), analyticsCacheTTL(), func() (BankAnalytics, error) {
		var item BankAnalytics
		err := db.QueryRow(ctx, `
			SELECT
				COALESCE(SUM(completed_count), 0)::int AS completed_count,
				COALESCE(SUM(wrong_count), 0)::int AS wrong_count,
				COUNT(*)::int AS practiced_users,
				(
					SELECT COUNT(*)::int
					FROM user_question_answers
					WHERE bank_id = $1
				) AS answer_count
			FROM user_bank_stats
			WHERE bank_id = $1
		`, bankID).Scan(&item.CompletedCount, &item.WrongCount, &item.PracticedUsers, &item.AnswerCount)
		return item, err
	})
}

func GetBankLeaderboard(ctx context.Context, db *pgxpool.Pool, user *auth.User, bankID int64, limit int) ([]BankLeaderboardEntry, error) {
	if _, err := GetBank(ctx, db, user, bankID); err != nil {
		return nil, err
	}
	safeLimit := normalizeLeaderboardLimit(limit)
	version := analyticsCacheVersion(ctx, "leaderboard", bankID)
	return loadAnalyticsCachedJSON(ctx, redisx.RedisKey("cache", "leaderboard", "bank", bankID, version, "limit", safeLimit), leaderboardCacheTTL(), func() ([]BankLeaderboardEntry, error) {
		rows, err := db.Query(ctx, `
			SELECT
				u.id AS user_id,
				u.username,
				ubs.completed_count,
				ubs.wrong_count,
				ubs.last_practiced_at,
				CASE
					WHEN ubs.completed_count > 0
					THEN ROUND(((ubs.completed_count - ubs.wrong_count)::numeric / ubs.completed_count) * 100, 2)
					ELSE 0
				END AS accuracy_percent
			FROM user_bank_stats ubs
			JOIN users u ON u.id = ubs.user_id
			WHERE ubs.bank_id = $1
			ORDER BY ubs.completed_count DESC, accuracy_percent DESC, ubs.last_practiced_at DESC NULLS LAST
			LIMIT $2
		`, bankID, safeLimit)
		if err != nil {
			return nil, err
		}
		defer rows.Close()

		items := make([]BankLeaderboardEntry, 0, safeLimit)
		for rows.Next() {
			var item BankLeaderboardEntry
			var lastPracticed sql.NullTime
			if err := rows.Scan(&item.UserID, &item.Username, &item.CompletedCount, &item.WrongCount, &lastPracticed, &item.AccuracyPercent); err != nil {
				return nil, err
			}
			item.LastPracticedAt = analyticsNullableTime(lastPracticed)
			items = append(items, item)
		}
		return items, rows.Err()
	})
}

func GetUserStatsSnapshot(ctx context.Context, db *pgxpool.Pool, user *auth.User) (UserStatsSnapshot, error) {
	if user == nil {
		return UserStatsSnapshot{}, api.NewError(401, "UNAUTHENTICATED", "Authentication required", nil)
	}
	version := analyticsCacheVersion(ctx, "analytics", user.ID)
	return loadAnalyticsCachedJSON(ctx, redisx.RedisKey("cache", "analytics", "user", user.ID, version, "snapshot"), analyticsCacheTTL(), func() (UserStatsSnapshot, error) {
		summary, err := GetAnalyticsSummary(ctx, db, user)
		if err != nil {
			return UserStatsSnapshot{}, err
		}

		recentRows, err := db.Query(ctx, `
			SELECT id, user_id, bank_id, session_type, status, question_count, answered_count, correct_count, wrong_count, score, started_at, completed_at
			FROM user_practice_sessions
			WHERE user_id = $1
			ORDER BY started_at DESC, id DESC
			LIMIT 10
		`, user.ID)
		if err != nil {
			return UserStatsSnapshot{}, err
		}
		defer recentRows.Close()

		recentSessions := make([]PracticeSession, 0, 10)
		for recentRows.Next() {
			session, scanErr := scanPracticeSessionRows(recentRows)
			if scanErr != nil {
				return UserStatsSnapshot{}, scanErr
			}
			recentSessions = append(recentSessions, session)
		}
		if err := recentRows.Err(); err != nil {
			return UserStatsSnapshot{}, err
		}

		weakRows, err := db.Query(ctx, `
			SELECT
				uqs.question_id,
				uqs.attempt_count,
				uqs.correct_count,
				uqs.wrong_count,
				uqs.mastery_score,
				q.stem,
				q.question_type_id
			FROM user_question_stats uqs
			JOIN questions q ON q.id = uqs.question_id
			WHERE uqs.user_id = $1
			  AND uqs.attempt_count > 0
			ORDER BY uqs.mastery_score ASC NULLS FIRST, uqs.wrong_count DESC, uqs.last_answered_at DESC NULLS LAST
			LIMIT 10
		`, user.ID)
		if err != nil {
			return UserStatsSnapshot{}, err
		}
		defer weakRows.Close()

		weakQuestions := make([]WeakQuestionStat, 0, 10)
		for weakRows.Next() {
			var item WeakQuestionStat
			var mastery sql.NullFloat64
			if err := weakRows.Scan(&item.QuestionID, &item.AttemptCount, &item.CorrectCount, &item.WrongCount, &mastery, &item.Stem, &item.QuestionTypeID); err != nil {
				return UserStatsSnapshot{}, err
			}
			item.MasteryScore = analyticsNullableFloat64(mastery)
			weakQuestions = append(weakQuestions, item)
		}
		if err := weakRows.Err(); err != nil {
			return UserStatsSnapshot{}, err
		}

		return UserStatsSnapshot{Summary: summary, RecentSessions: recentSessions, WeakQuestions: weakQuestions}, nil
	})
}

func GetImportAnalytics(ctx context.Context, db *pgxpool.Pool, user *auth.User, jobID int64) (ImportAnalytics, error) {
	if user == nil {
		return ImportAnalytics{}, api.NewError(401, "UNAUTHENTICATED", "Authentication required", nil)
	}
	var item ImportAnalytics
	var bankID sql.NullInt64
	var availableAt sql.NullTime
	var rawResultJSON sql.NullString
	var fileName sql.NullString
	var sourceType sql.NullString
	var overallProgress sql.NullFloat64
	var stepProgress sql.NullFloat64
	var lastErrorCode sql.NullString
	var lastError sql.NullString
	var lastEventID sql.NullInt64
	var lastEventAt sql.NullTime
	var completedAt sql.NullTime

	err := db.QueryRow(ctx, `
		SELECT
			qij.id,
			qij.created_by,
			qij.bank_id,
			qij.status,
			qij.stage,
			qij.available_at,
			qij.persist_questions,
			qij.request_payload,
			qij.raw_result_json,
			qij.warning_messages,
			qij.total_questions,
			qij.imported_questions,
			qij.file_name,
			qij.source_type,
			qij.retry_count,
			qij.quality_score,
			qij.last_error_code,
			qij.last_error,
			qij.overall_progress_percent,
			qij.step_progress_percent,
			qij.last_event_id,
			qij.last_event_at,
			qij.created_at,
			qij.updated_at,
			qij.completed_at,
			(SELECT COUNT(*)::int FROM question_import_job_events WHERE job_id = qij.id) AS events,
			(SELECT COUNT(*)::int FROM question_import_job_outputs WHERE job_id = qij.id) AS outputs
		FROM question_import_jobs qij
		WHERE qij.id = $1 AND qij.created_by = $2
		LIMIT 1
	`, jobID, user.ID).Scan(
		&item.ID,
		&item.CreatedBy,
		&bankID,
		&item.Status,
		&item.Stage,
		&availableAt,
		&item.PersistQuestions,
		&item.RequestPayload,
		&rawResultJSON,
		&item.WarningMessages,
		&item.TotalQuestions,
		&item.ImportedQuestions,
		&fileName,
		&sourceType,
		&item.RetryCount,
		&item.QualityScore,
		&lastErrorCode,
		&lastError,
		&overallProgress,
		&stepProgress,
		&lastEventID,
		&lastEventAt,
		&item.CreatedAt,
		&item.UpdatedAt,
		&completedAt,
		&item.Events,
		&item.Outputs,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return ImportAnalytics{}, api.NewError(404, "NOT_FOUND", "Import job not found", nil)
	}
	if err != nil {
		return ImportAnalytics{}, err
	}

	item.BankID = analyticsNullableInt64(bankID)
	item.AvailableAt = analyticsNullableTime(availableAt)
	item.RawResultJSON = analyticsNullableString(rawResultJSON)
	item.FileName = analyticsNullableString(fileName)
	item.SourceType = analyticsNullableString(sourceType)
	item.OverallProgressPercent = analyticsNullableFloat64(overallProgress)
	item.StepProgressPercent = analyticsNullableFloat64(stepProgress)
	item.LastErrorCode = analyticsNullableString(lastErrorCode)
	item.LastError = analyticsNullableString(lastError)
	item.LastEventID = analyticsNullableInt64(lastEventID)
	item.LastEventAt = analyticsNullableTime(lastEventAt)
	item.CompletedAt = analyticsNullableTime(completedAt)
	return item, nil
}

func analyticsCacheTTL() time.Duration {
	return time.Duration(analyticsEnvInt("ANALYTICS_CACHE_TTL_SECONDS", 30)) * time.Second
}

func leaderboardCacheTTL() time.Duration {
	return time.Duration(analyticsEnvInt("LEADERBOARD_CACHE_TTL_SECONDS", 60)) * time.Second
}

func analyticsEnvInt(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func analyticsCacheVersion(ctx context.Context, scope string, id any) string {
	rdb := redisx.Client()
	if rdb == nil {
		return "0"
	}
	value, ok := redisx.GetText(ctx, rdb, redisx.RedisKey("cache-version", scope, id))
	if !ok || strings.TrimSpace(value) == "" {
		return "0"
	}
	return value
}

func loadAnalyticsCachedJSON[T any](ctx context.Context, key string, ttl time.Duration, loader func() (T, error)) (T, error) {
	rdb := redisx.Client()
	if rdb != nil {
		if cached, ok := redisx.GetJSON[T](ctx, rdb, key); ok {
			return cached, nil
		}
	}
	value, err := loader()
	if err != nil {
		var zero T
		return zero, err
	}
	if rdb != nil {
		_ = redisx.SetJSON(ctx, rdb, key, value, ttl)
	}
	return value, nil
}

func analyticsNullableString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return new(value.String)
}

func analyticsNullableInt64(value sql.NullInt64) *int64 {
	if !value.Valid {
		return nil
	}
	return new(value.Int64)
}

func analyticsNullableFloat64(value sql.NullFloat64) *float64 {
	if !value.Valid {
		return nil
	}
	return new(value.Float64)
}

func analyticsNullableTime(value sql.NullTime) *time.Time {
	if !value.Valid {
		return nil
	}
	return new(value.Time)
}
