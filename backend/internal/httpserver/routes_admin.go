package httpserver

import "net/http"

type AdminHandlers struct {
	Overview             http.Handler
	Users                http.Handler
	KnowledgePoints      http.Handler
	SetUserStatus        http.Handler
	UpdateUserAccess     http.Handler
	CreateKnowledgePoint http.Handler
	UpdateKnowledgePoint http.Handler
}

func registerAdminRoutes(router *http.ServeMux, handlers AdminHandlers) {
	registerMethodRoute(router, http.MethodGet, "/api/v1/admin/overview", handlers.Overview)
	registerMethodRoute(router, http.MethodGet, "/api/v1/admin/users", handlers.Users)
	registerMethodRoute(router, http.MethodGet, "/api/v1/admin/knowledge-points", handlers.KnowledgePoints)
	registerMethodRoute(router, http.MethodPatch, "/api/v1/users/{userId}/status", handlers.SetUserStatus)
	registerMethodRoute(router, http.MethodPatch, "/api/v1/users/{userId}/access", handlers.UpdateUserAccess)
	registerMethodRoute(router, http.MethodPost, "/api/v1/knowledge-points", handlers.CreateKnowledgePoint)
	registerMethodRoute(router, http.MethodPatch, "/api/v1/knowledge-points/{knowledgePointId}", handlers.UpdateKnowledgePoint)
}
