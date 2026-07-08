package httpserver

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

type ContentHandlers struct {
	Banks                    http.Handler
	BankSubtree              http.Handler
	BankGet                  http.Handler
	BankUpdate               http.Handler
	BankDelete               http.Handler
	BankItems                http.Handler
	BankItemsReorder         http.Handler
	BankFavoriteCreate       http.Handler
	BankFavoriteDelete       http.Handler
	BankQuestionCreate       http.Handler
	BankGroupCreate          http.Handler
	QuestionSubtree          http.Handler
	QuestionGet              http.Handler
	QuestionUpdate           http.Handler
	QuestionDelete           http.Handler
	QuestionPublish          http.Handler
	QuestionArchive          http.Handler
	QuestionOptionCreate     http.Handler
	QuestionOptionUpdate     http.Handler
	QuestionAnswerKeyPut     http.Handler
	QuestionMetadataPut      http.Handler
	QuestionKnowledgePut     http.Handler
	QuestionContentBlocksPut http.Handler
	GroupSubtree             http.Handler
	GroupGet                 http.Handler
	GroupUpdate              http.Handler
	GroupQuestionCreate      http.Handler
	GroupQuestionsReorder    http.Handler
	GroupQuestionDelete      http.Handler
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

func registerMethodRoute(router chi.Router, method string, pattern string, handler http.Handler) {
	if handler == nil {
		return
	}
	router.Method(method, pattern, withStdPathValues(handler))
}

func registerContentRoutes(router chi.Router, handlers ContentHandlers) {
	if handlers.Banks != nil {
		router.Handle("/api/v1/banks", handlers.Banks)
	}
	if handlers.BankGet != nil || handlers.BankUpdate != nil || handlers.BankDelete != nil || handlers.BankItems != nil || handlers.BankItemsReorder != nil || handlers.BankFavoriteCreate != nil || handlers.BankFavoriteDelete != nil || handlers.BankQuestionCreate != nil || handlers.BankGroupCreate != nil {
		registerMethodRoute(router, http.MethodGet, "/api/v1/banks/{bankId}", handlers.BankGet)
		registerMethodRoute(router, http.MethodPatch, "/api/v1/banks/{bankId}", handlers.BankUpdate)
		registerMethodRoute(router, http.MethodDelete, "/api/v1/banks/{bankId}", handlers.BankDelete)
		registerMethodRoute(router, http.MethodGet, "/api/v1/banks/{bankId}/items", handlers.BankItems)
		registerMethodRoute(router, http.MethodPatch, "/api/v1/banks/{bankId}/items/reorder", handlers.BankItemsReorder)
		registerMethodRoute(router, http.MethodPost, "/api/v1/banks/{bankId}/favorite", handlers.BankFavoriteCreate)
		registerMethodRoute(router, http.MethodDelete, "/api/v1/banks/{bankId}/favorite", handlers.BankFavoriteDelete)
		registerMethodRoute(router, http.MethodPost, "/api/v1/banks/{bankId}/questions", handlers.BankQuestionCreate)
		registerMethodRoute(router, http.MethodPost, "/api/v1/banks/{bankId}/groups", handlers.BankGroupCreate)
	} else if handlers.BankSubtree != nil {
		router.Handle("/api/v1/banks/*", handlers.BankSubtree)
	}
	if handlers.QuestionGet != nil || handlers.QuestionUpdate != nil || handlers.QuestionDelete != nil || handlers.QuestionPublish != nil || handlers.QuestionArchive != nil || handlers.QuestionOptionCreate != nil || handlers.QuestionOptionUpdate != nil || handlers.QuestionAnswerKeyPut != nil || handlers.QuestionMetadataPut != nil || handlers.QuestionKnowledgePut != nil || handlers.QuestionContentBlocksPut != nil {
		registerMethodRoute(router, http.MethodGet, "/api/v1/questions/{questionId}", handlers.QuestionGet)
		registerMethodRoute(router, http.MethodPatch, "/api/v1/questions/{questionId}", handlers.QuestionUpdate)
		registerMethodRoute(router, http.MethodDelete, "/api/v1/questions/{questionId}", handlers.QuestionDelete)
		registerMethodRoute(router, http.MethodPost, "/api/v1/questions/{questionId}/publish", handlers.QuestionPublish)
		registerMethodRoute(router, http.MethodPost, "/api/v1/questions/{questionId}/archive", handlers.QuestionArchive)
		registerMethodRoute(router, http.MethodPost, "/api/v1/questions/{questionId}/options", handlers.QuestionOptionCreate)
		registerMethodRoute(router, http.MethodPatch, "/api/v1/questions/{questionId}/options/{optionId}", handlers.QuestionOptionUpdate)
		registerMethodRoute(router, http.MethodPut, "/api/v1/questions/{questionId}/answer-key", handlers.QuestionAnswerKeyPut)
		registerMethodRoute(router, http.MethodPut, "/api/v1/questions/{questionId}/metadata", handlers.QuestionMetadataPut)
		registerMethodRoute(router, http.MethodPut, "/api/v1/questions/{questionId}/knowledge-points", handlers.QuestionKnowledgePut)
		registerMethodRoute(router, http.MethodPut, "/api/v1/questions/{questionId}/content-blocks", handlers.QuestionContentBlocksPut)
	} else if handlers.QuestionSubtree != nil {
		router.Handle("/api/v1/questions/*", handlers.QuestionSubtree)
	}
	if handlers.GroupGet != nil || handlers.GroupUpdate != nil || handlers.GroupQuestionCreate != nil || handlers.GroupQuestionsReorder != nil || handlers.GroupQuestionDelete != nil {
		registerMethodRoute(router, http.MethodGet, "/api/v1/groups/{groupId}", handlers.GroupGet)
		registerMethodRoute(router, http.MethodPatch, "/api/v1/groups/{groupId}", handlers.GroupUpdate)
		registerMethodRoute(router, http.MethodPost, "/api/v1/groups/{groupId}/questions", handlers.GroupQuestionCreate)
		registerMethodRoute(router, http.MethodPatch, "/api/v1/groups/{groupId}/questions/reorder", handlers.GroupQuestionsReorder)
		registerMethodRoute(router, http.MethodDelete, "/api/v1/groups/{groupId}/questions/{questionId}", handlers.GroupQuestionDelete)
	} else if handlers.GroupSubtree != nil {
		router.Handle("/api/v1/groups/*", handlers.GroupSubtree)
	}
}

func registerAdminRoutes(router chi.Router, handlers AdminHandlers) {
	registerMethodRoute(router, http.MethodGet, "/api/v1/admin/overview", handlers.Overview)
	registerMethodRoute(router, http.MethodGet, "/api/v1/admin/users", handlers.Users)
	registerMethodRoute(router, http.MethodGet, "/api/v1/admin/knowledge-points", handlers.KnowledgePoints)
	registerMethodRoute(router, http.MethodPatch, "/api/v1/users/{userId}/status", handlers.SetUserStatus)
	registerMethodRoute(router, http.MethodPatch, "/api/v1/users/{userId}/access", handlers.UpdateUserAccess)
	registerMethodRoute(router, http.MethodPost, "/api/v1/knowledge-points", handlers.CreateKnowledgePoint)
	registerMethodRoute(router, http.MethodPatch, "/api/v1/knowledge-points/{knowledgePointId}", handlers.UpdateKnowledgePoint)
}

func registerMediaRoutes(router chi.Router, handlers MediaHandlers) {
	registerMethodRoute(router, http.MethodPost, "/api/v1/media", handlers.Create)
	registerMethodRoute(router, http.MethodGet, "/api/v1/media/{mediaId}", handlers.Get)
	registerMethodRoute(router, http.MethodDelete, "/api/v1/media/{mediaId}", handlers.Delete)
	registerMethodRoute(router, http.MethodPost, "/api/v1/questions/{questionId}/media-links", handlers.LinkQuestion)
	registerMethodRoute(router, http.MethodPost, "/api/v1/groups/{groupId}/media-links", handlers.LinkGroup)
	registerMethodRoute(router, http.MethodPost, "/api/v1/options/{optionId}/media-links", handlers.LinkOption)
}

func registerImportsBillingAIRoutes(router chi.Router, handlers ImportsBillingAIHandlers) {
	registerMethodRoute(router, http.MethodGet, "/api/v1/import-jobs", handlers.ImportJobs)
	registerMethodRoute(router, http.MethodPost, "/api/v1/import-jobs", handlers.ImportJobs)
	registerMethodRoute(router, http.MethodGet, "/api/v1/import-jobs/{jobId}", handlers.ImportJob)
	registerMethodRoute(router, http.MethodPost, "/api/v1/import-jobs/{jobId}/file", handlers.ImportJobFile)
	registerMethodRoute(router, http.MethodPost, "/api/v1/import-jobs/{jobId}/{action}", handlers.ImportJobAction)
	registerMethodRoute(router, http.MethodGet, "/api/v1/import-jobs/{jobId}/{kind}", handlers.ImportJobChildren)
	registerMethodRoute(router, http.MethodGet, "/api/v1/import-jobs/{jobId}/events/stream", handlers.ImportJobEventStream)
	registerMethodRoute(router, http.MethodPost, "/api/v1/import-jobs/{jobId}/review-items/{itemId}/resolve", handlers.ImportJobReviewResolve)
	registerMethodRoute(router, http.MethodPost, "/api/v1/ai/parse-document", handlers.AIParseDocument)
	registerMethodRoute(router, http.MethodPost, "/api/v1/ai/generate-answer", handlers.AIGenerateAnswer)
	registerMethodRoute(router, http.MethodPost, "/api/v1/ai/learning-report", handlers.AILearningReport)
	registerMethodRoute(router, http.MethodPost, "/api/v1/questions/{questionId}/generate-answer", handlers.QuestionGenerateAnswer)
	registerMethodRoute(router, http.MethodGet, "/api/v1/billing/summary", handlers.BillingSummary)
	registerMethodRoute(router, http.MethodPost, "/api/v1/billing/checkout", handlers.BillingCheckout)
	registerMethodRoute(router, http.MethodPost, "/api/v1/billing/webhook", handlers.BillingWebhook)
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
