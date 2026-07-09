package httpserver

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

type AIHandlers struct {
	AIParseDocument        http.Handler
	AIGenerateAnswer       http.Handler
	AILearningReport       http.Handler
	QuestionGenerateAnswer http.Handler
}

func registerAIRoutes(router chi.Router, handlers AIHandlers) {
	registerMethodRoute(router, http.MethodPost, "/ai/parse-document", handlers.AIParseDocument)
	registerMethodRoute(router, http.MethodPost, "/ai/generate-answer", handlers.AIGenerateAnswer)
	registerMethodRoute(router, http.MethodPost, "/ai/learning-report", handlers.AILearningReport)
	registerMethodRoute(router, http.MethodPost, "/questions/{questionId}/generate-answer", handlers.QuestionGenerateAnswer)
}
