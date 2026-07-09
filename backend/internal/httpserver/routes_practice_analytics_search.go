package httpserver

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

type PracticeHandlers struct {
	List         http.Handler
	Start        http.Handler
	Get          http.Handler
	QuestionPage http.Handler
	Questions    http.Handler
	Results      http.Handler
	SubmitAnswer http.Handler
	Complete     http.Handler
	Abandon      http.Handler
}

type AnalyticsHandlers struct {
	MeSummary       http.Handler
	MeSnapshot      http.Handler
	Bank            http.Handler
	BankLeaderboard http.Handler
	Import          http.Handler
}

type SearchHandlers struct {
	Kind http.Handler
}

func registerPracticeAnalyticsSearchRoutes(router chi.Router, practice PracticeHandlers, analytics AnalyticsHandlers, search SearchHandlers) {
	registerMethodRoute(router, http.MethodGet, "/api/v1/practice-sessions", practice.List)
	registerMethodRoute(router, http.MethodPost, "/api/v1/practice-sessions", practice.Start)
	registerMethodRoute(router, http.MethodGet, "/api/v1/practice-sessions/{sessionId}", practice.Get)
	registerMethodRoute(router, http.MethodGet, "/api/v1/practice-sessions/{sessionId}/question-page", practice.QuestionPage)
	registerMethodRoute(router, http.MethodGet, "/api/v1/practice-sessions/{sessionId}/questions", practice.Questions)
	registerMethodRoute(router, http.MethodGet, "/api/v1/practice-sessions/{sessionId}/results", practice.Results)
	registerMethodRoute(router, http.MethodPost, "/api/v1/practice-sessions/{sessionId}/answers", practice.SubmitAnswer)
	registerMethodRoute(router, http.MethodPost, "/api/v1/practice-sessions/{sessionId}/complete", practice.Complete)
	registerMethodRoute(router, http.MethodPost, "/api/v1/practice-sessions/{sessionId}/abandon", practice.Abandon)
	registerMethodRoute(router, http.MethodGet, "/api/v1/analytics/me/summary", analytics.MeSummary)
	registerMethodRoute(router, http.MethodGet, "/api/v1/analytics/me/snapshot", analytics.MeSnapshot)
	registerMethodRoute(router, http.MethodGet, "/api/v1/analytics/banks/{bankId}", analytics.Bank)
	registerMethodRoute(router, http.MethodGet, "/api/v1/analytics/banks/{bankId}/leaderboard", analytics.BankLeaderboard)
	registerMethodRoute(router, http.MethodGet, "/api/v1/analytics/imports/{jobId}", analytics.Import)
	registerMethodRoute(router, http.MethodGet, "/api/v1/search/{kind}", search.Kind)
}
