package httpserver

import "net/http"

type MediaHandlers struct {
	Create         http.Handler
	Get            http.Handler
	Content        http.Handler
	Delete         http.Handler
	LinkQuestion   http.Handler
	LinkGroup      http.Handler
	LinkOption     http.Handler
	UnlinkQuestion http.Handler
	UnlinkGroup    http.Handler
	UnlinkOption   http.Handler
}

func registerMediaRoutes(router *http.ServeMux, handlers MediaHandlers) {
	registerMethodRoute(router, http.MethodPost, "/api/v1/media", handlers.Create)
	registerMethodRoute(router, http.MethodGet, "/api/v1/media/{mediaId}", handlers.Get)
	registerMethodRoute(router, http.MethodGet, "/api/v1/media/{mediaId}/content", handlers.Content)
	registerMethodRoute(router, http.MethodDelete, "/api/v1/media/{mediaId}", handlers.Delete)
	registerMethodRoute(router, http.MethodPost, "/api/v1/questions/{questionId}/media-links", handlers.LinkQuestion)
	registerMethodRoute(router, http.MethodPost, "/api/v1/groups/{groupId}/media-links", handlers.LinkGroup)
	registerMethodRoute(router, http.MethodPost, "/api/v1/options/{optionId}/media-links", handlers.LinkOption)
	registerMethodRoute(router, http.MethodDelete, "/api/v1/questions/{questionId}/media-links/{mediaId}", handlers.UnlinkQuestion)
	registerMethodRoute(router, http.MethodDelete, "/api/v1/groups/{groupId}/media-links/{mediaId}", handlers.UnlinkGroup)
	registerMethodRoute(router, http.MethodDelete, "/api/v1/options/{optionId}/media-links/{mediaId}", handlers.UnlinkOption)
}
