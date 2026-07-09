package httpserver

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

type ContentHandlers struct {
	Banks                    http.Handler
	BankGet                  http.Handler
	BankUpdate               http.Handler
	BankDelete               http.Handler
	BankItems                http.Handler
	BankItemsReorder         http.Handler
	BankFavoriteCreate       http.Handler
	BankFavoriteDelete       http.Handler
	BankQuestionCreate       http.Handler
	BankGroupCreate          http.Handler
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
	GroupGet                 http.Handler
	GroupUpdate              http.Handler
	GroupQuestionCreate      http.Handler
	GroupQuestionsReorder    http.Handler
	GroupQuestionDelete      http.Handler
}

func registerContentRoutes(router chi.Router, handlers ContentHandlers) {
	if handlers.Banks != nil {
		router.Handle("/banks", handlers.Banks)
	}
	registerMethodRoute(router, http.MethodGet, "/banks/{bankId}", handlers.BankGet)
	registerMethodRoute(router, http.MethodPatch, "/banks/{bankId}", handlers.BankUpdate)
	registerMethodRoute(router, http.MethodDelete, "/banks/{bankId}", handlers.BankDelete)
	registerMethodRoute(router, http.MethodGet, "/banks/{bankId}/items", handlers.BankItems)
	registerMethodRoute(router, http.MethodPatch, "/banks/{bankId}/items/reorder", handlers.BankItemsReorder)
	registerMethodRoute(router, http.MethodPost, "/banks/{bankId}/favorite", handlers.BankFavoriteCreate)
	registerMethodRoute(router, http.MethodDelete, "/banks/{bankId}/favorite", handlers.BankFavoriteDelete)
	registerMethodRoute(router, http.MethodPost, "/banks/{bankId}/questions", handlers.BankQuestionCreate)
	registerMethodRoute(router, http.MethodPost, "/banks/{bankId}/groups", handlers.BankGroupCreate)
	registerMethodRoute(router, http.MethodGet, "/questions/{questionId}", handlers.QuestionGet)
	registerMethodRoute(router, http.MethodPatch, "/questions/{questionId}", handlers.QuestionUpdate)
	registerMethodRoute(router, http.MethodDelete, "/questions/{questionId}", handlers.QuestionDelete)
	registerMethodRoute(router, http.MethodPost, "/questions/{questionId}/publish", handlers.QuestionPublish)
	registerMethodRoute(router, http.MethodPost, "/questions/{questionId}/archive", handlers.QuestionArchive)
	registerMethodRoute(router, http.MethodPost, "/questions/{questionId}/options", handlers.QuestionOptionCreate)
	registerMethodRoute(router, http.MethodPatch, "/questions/{questionId}/options/{optionId}", handlers.QuestionOptionUpdate)
	registerMethodRoute(router, http.MethodPut, "/questions/{questionId}/answer-key", handlers.QuestionAnswerKeyPut)
	registerMethodRoute(router, http.MethodPut, "/questions/{questionId}/metadata", handlers.QuestionMetadataPut)
	registerMethodRoute(router, http.MethodPut, "/questions/{questionId}/knowledge-points", handlers.QuestionKnowledgePut)
	registerMethodRoute(router, http.MethodPut, "/questions/{questionId}/content-blocks", handlers.QuestionContentBlocksPut)
	registerMethodRoute(router, http.MethodGet, "/groups/{groupId}", handlers.GroupGet)
	registerMethodRoute(router, http.MethodPatch, "/groups/{groupId}", handlers.GroupUpdate)
	registerMethodRoute(router, http.MethodPost, "/groups/{groupId}/questions", handlers.GroupQuestionCreate)
	registerMethodRoute(router, http.MethodPatch, "/groups/{groupId}/questions/reorder", handlers.GroupQuestionsReorder)
	registerMethodRoute(router, http.MethodDelete, "/groups/{groupId}/questions/{questionId}", handlers.GroupQuestionDelete)
}
