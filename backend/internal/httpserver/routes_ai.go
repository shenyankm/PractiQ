package httpserver

import "net/http"

type AIHandlers struct {
	AIParseDocument        http.Handler
	AIGenerateAnswer       http.Handler
	AILearningReport       http.Handler
	QuestionGenerateAnswer http.Handler
}

func registerAIRoutes(router *http.ServeMux, handlers AIHandlers) {
	registerMethodRoute(router, http.MethodPost, "/api/v1/ai/parse-document", handlers.AIParseDocument)
	registerMethodRoute(router, http.MethodPost, "/api/v1/ai/generate-answer", handlers.AIGenerateAnswer)
	registerMethodRoute(router, http.MethodPost, "/api/v1/ai/learning-report", handlers.AILearningReport)
	registerMethodRoute(router, http.MethodPost, "/api/v1/questions/{questionId}/generate-answer", handlers.QuestionGenerateAnswer)
}
