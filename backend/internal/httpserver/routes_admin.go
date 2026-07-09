package httpserver

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

type AdminHandlers struct {
	Overview             http.Handler
	Users                http.Handler
	KnowledgePoints      http.Handler
	SetUserStatus        http.Handler
	UpdateUserAccess     http.Handler
	CreateKnowledgePoint http.Handler
	UpdateKnowledgePoint http.Handler
}

func registerAdminRoutes(router chi.Router, handlers AdminHandlers) {
	registerMethodRoute(router, http.MethodGet, "/admin/overview", handlers.Overview)
	registerMethodRoute(router, http.MethodGet, "/admin/users", handlers.Users)
	registerMethodRoute(router, http.MethodGet, "/admin/knowledge-points", handlers.KnowledgePoints)
	registerMethodRoute(router, http.MethodPatch, "/users/{userId}/status", handlers.SetUserStatus)
	registerMethodRoute(router, http.MethodPatch, "/users/{userId}/access", handlers.UpdateUserAccess)
	registerMethodRoute(router, http.MethodPost, "/knowledge-points", handlers.CreateKnowledgePoint)
	registerMethodRoute(router, http.MethodPatch, "/knowledge-points/{knowledgePointId}", handlers.UpdateKnowledgePoint)
}
