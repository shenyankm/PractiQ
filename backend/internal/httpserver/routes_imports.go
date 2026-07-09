package httpserver

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

type ImportHandlers struct {
	ImportJobs             http.Handler
	ImportJob              http.Handler
	ImportJobFile          http.Handler
	ImportJobAction        http.Handler
	ImportJobChildren      http.Handler
	ImportJobEventStream   http.Handler
	ImportJobReviewResolve http.Handler
}

func registerImportRoutes(router chi.Router, handlers ImportHandlers) {
	registerMethodRoute(router, http.MethodGet, "/api/v1/import-jobs", handlers.ImportJobs)
	registerMethodRoute(router, http.MethodPost, "/api/v1/import-jobs", handlers.ImportJobs)
	registerMethodRoute(router, http.MethodGet, "/api/v1/import-jobs/{jobId}", handlers.ImportJob)
	registerMethodRoute(router, http.MethodPost, "/api/v1/import-jobs/{jobId}/file", handlers.ImportJobFile)
	registerMethodRoute(router, http.MethodPost, "/api/v1/import-jobs/{jobId}/{action}", handlers.ImportJobAction)
	registerMethodRoute(router, http.MethodGet, "/api/v1/import-jobs/{jobId}/{kind}", handlers.ImportJobChildren)
	registerMethodRoute(router, http.MethodGet, "/api/v1/import-jobs/{jobId}/events/stream", handlers.ImportJobEventStream)
	registerMethodRoute(router, http.MethodPost, "/api/v1/import-jobs/{jobId}/review-items/{itemId}/resolve", handlers.ImportJobReviewResolve)
}
