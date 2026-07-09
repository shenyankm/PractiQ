package httpserver

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

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
