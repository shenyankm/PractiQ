package httpserver

import (
	"net/http"
)

type ContentHandlers struct {
	Banks           http.Handler
	BankSubtree     http.Handler
	QuestionSubtree http.Handler
	GroupSubtree    http.Handler
}

type AdminHandlers struct {
	Overview             http.Handler
	Users                http.Handler
	KnowledgePoints      http.Handler
	SetUserStatus        http.Handler
	UpdateUserAccess     http.Handler
	CreateKnowledgePoint http.Handler
	UpdateKnowledgePoint http.Handler
}

type MediaHandlers struct {
	Create       http.Handler
	Get          http.Handler
	Delete       http.Handler
	LinkQuestion http.Handler
	LinkGroup    http.Handler
	LinkOption   http.Handler
}

type ImportsBillingAIHandlers struct {
	ImportJobs             http.Handler
	ImportJob              http.Handler
	ImportJobFile          http.Handler
	ImportJobAction        http.Handler
	ImportJobChildren      http.Handler
	ImportJobEventStream   http.Handler
	ImportJobReviewResolve http.Handler
	AIParseDocument        http.Handler
	AIGenerateAnswer       http.Handler
	AILearningReport       http.Handler
	QuestionGenerateAnswer http.Handler
	BillingSummary         http.Handler
	BillingCheckout        http.Handler
	BillingWebhook         http.Handler
}

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

func registerMethodRoute(mux *http.ServeMux, method string, pattern string, handler http.Handler) {
	if handler == nil {
		return
	}
	mux.Handle(method+" "+pattern, handler)
}

func registerContentRoutes(mux *http.ServeMux, handlers ContentHandlers) {
	if handlers.Banks != nil {
		mux.Handle("/api/v1/banks", handlers.Banks)
	}
	if handlers.BankSubtree != nil {
		mux.Handle("/api/v1/banks/", handlers.BankSubtree)
	}
	if handlers.QuestionSubtree != nil {
		mux.Handle("/api/v1/questions/", handlers.QuestionSubtree)
	}
	if handlers.GroupSubtree != nil {
		mux.Handle("/api/v1/groups/", handlers.GroupSubtree)
	}
}

func registerAdminRoutes(mux *http.ServeMux, handlers AdminHandlers) {
	registerMethodRoute(mux, http.MethodGet, "/api/v1/admin/overview", handlers.Overview)
	registerMethodRoute(mux, http.MethodGet, "/api/v1/admin/users", handlers.Users)
	registerMethodRoute(mux, http.MethodGet, "/api/v1/admin/knowledge-points", handlers.KnowledgePoints)
	registerMethodRoute(mux, http.MethodPatch, "/api/v1/users/{userId}/status", handlers.SetUserStatus)
	registerMethodRoute(mux, http.MethodPatch, "/api/v1/users/{userId}/access", handlers.UpdateUserAccess)
	registerMethodRoute(mux, http.MethodPost, "/api/v1/knowledge-points", handlers.CreateKnowledgePoint)
	registerMethodRoute(mux, http.MethodPatch, "/api/v1/knowledge-points/{knowledgePointId}", handlers.UpdateKnowledgePoint)
}

func registerMediaRoutes(mux *http.ServeMux, handlers MediaHandlers) {
	registerMethodRoute(mux, http.MethodPost, "/api/v1/media", handlers.Create)
	registerMethodRoute(mux, http.MethodGet, "/api/v1/media/{mediaId}", handlers.Get)
	registerMethodRoute(mux, http.MethodDelete, "/api/v1/media/{mediaId}", handlers.Delete)
	registerMethodRoute(mux, http.MethodPost, "/api/v1/questions/{questionId}/media-links", handlers.LinkQuestion)
	registerMethodRoute(mux, http.MethodPost, "/api/v1/groups/{groupId}/media-links", handlers.LinkGroup)
	registerMethodRoute(mux, http.MethodPost, "/api/v1/options/{optionId}/media-links", handlers.LinkOption)
}

func registerImportsBillingAIRoutes(mux *http.ServeMux, handlers ImportsBillingAIHandlers) {
	registerMethodRoute(mux, http.MethodGet, "/api/v1/import-jobs", handlers.ImportJobs)
	registerMethodRoute(mux, http.MethodPost, "/api/v1/import-jobs", handlers.ImportJobs)
	registerMethodRoute(mux, http.MethodGet, "/api/v1/import-jobs/{jobId}", handlers.ImportJob)
	registerMethodRoute(mux, http.MethodPost, "/api/v1/import-jobs/{jobId}/file", handlers.ImportJobFile)
	registerMethodRoute(mux, http.MethodPost, "/api/v1/import-jobs/{jobId}/{action}", handlers.ImportJobAction)
	registerMethodRoute(mux, http.MethodGet, "/api/v1/import-jobs/{jobId}/{kind}", handlers.ImportJobChildren)
	registerMethodRoute(mux, http.MethodGet, "/api/v1/import-jobs/{jobId}/events/stream", handlers.ImportJobEventStream)
	registerMethodRoute(mux, http.MethodPost, "/api/v1/import-jobs/{jobId}/review-items/{itemId}/resolve", handlers.ImportJobReviewResolve)
	registerMethodRoute(mux, http.MethodPost, "/api/v1/ai/parse-document", handlers.AIParseDocument)
	registerMethodRoute(mux, http.MethodPost, "/api/v1/ai/generate-answer", handlers.AIGenerateAnswer)
	registerMethodRoute(mux, http.MethodPost, "/api/v1/ai/learning-report", handlers.AILearningReport)
	registerMethodRoute(mux, http.MethodPost, "/api/v1/questions/{questionId}/generate-answer", handlers.QuestionGenerateAnswer)
	registerMethodRoute(mux, http.MethodGet, "/api/v1/billing/summary", handlers.BillingSummary)
	registerMethodRoute(mux, http.MethodPost, "/api/v1/billing/checkout", handlers.BillingCheckout)
	registerMethodRoute(mux, http.MethodPost, "/api/v1/billing/webhook", handlers.BillingWebhook)
}

func registerPracticeAnalyticsSearchRoutes(mux *http.ServeMux, practice PracticeHandlers, analytics AnalyticsHandlers, search SearchHandlers) {
	registerMethodRoute(mux, http.MethodGet, "/api/v1/practice-sessions", practice.List)
	registerMethodRoute(mux, http.MethodPost, "/api/v1/practice-sessions", practice.Start)
	registerMethodRoute(mux, http.MethodGet, "/api/v1/practice-sessions/{sessionId}", practice.Get)
	registerMethodRoute(mux, http.MethodGet, "/api/v1/practice-sessions/{sessionId}/question-page", practice.QuestionPage)
	registerMethodRoute(mux, http.MethodGet, "/api/v1/practice-sessions/{sessionId}/questions", practice.Questions)
	registerMethodRoute(mux, http.MethodGet, "/api/v1/practice-sessions/{sessionId}/results", practice.Results)
	registerMethodRoute(mux, http.MethodPost, "/api/v1/practice-sessions/{sessionId}/answers", practice.SubmitAnswer)
	registerMethodRoute(mux, http.MethodPost, "/api/v1/practice-sessions/{sessionId}/complete", practice.Complete)
	registerMethodRoute(mux, http.MethodPost, "/api/v1/practice-sessions/{sessionId}/abandon", practice.Abandon)
	registerMethodRoute(mux, http.MethodGet, "/api/v1/analytics/me/summary", analytics.MeSummary)
	registerMethodRoute(mux, http.MethodGet, "/api/v1/analytics/me/snapshot", analytics.MeSnapshot)
	registerMethodRoute(mux, http.MethodGet, "/api/v1/analytics/banks/{bankId}", analytics.Bank)
	registerMethodRoute(mux, http.MethodGet, "/api/v1/analytics/banks/{bankId}/leaderboard", analytics.BankLeaderboard)
	registerMethodRoute(mux, http.MethodGet, "/api/v1/analytics/imports/{jobId}", analytics.Import)
	registerMethodRoute(mux, http.MethodGet, "/api/v1/search/{kind}", search.Kind)
}
