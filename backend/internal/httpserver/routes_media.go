package httpserver

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

type MediaHandlers struct {
	Create       http.Handler
	Get          http.Handler
	Delete       http.Handler
	LinkQuestion http.Handler
	LinkGroup    http.Handler
	LinkOption   http.Handler
}

func registerMediaRoutes(router chi.Router, handlers MediaHandlers) {
	registerMethodRoute(router, http.MethodPost, "/media", handlers.Create)
	registerMethodRoute(router, http.MethodGet, "/media/{mediaId}", handlers.Get)
	registerMethodRoute(router, http.MethodDelete, "/media/{mediaId}", handlers.Delete)
	registerMethodRoute(router, http.MethodPost, "/questions/{questionId}/media-links", handlers.LinkQuestion)
	registerMethodRoute(router, http.MethodPost, "/groups/{groupId}/media-links", handlers.LinkGroup)
	registerMethodRoute(router, http.MethodPost, "/options/{optionId}/media-links", handlers.LinkOption)
}
