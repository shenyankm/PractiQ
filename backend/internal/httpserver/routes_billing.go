package httpserver

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

type BillingHandlers struct {
	BillingSummary  http.Handler
	BillingCheckout http.Handler
	BillingWebhook  http.Handler
}

func registerBillingRoutes(router chi.Router, handlers BillingHandlers) {
	registerMethodRoute(router, http.MethodGet, "/api/v1/billing/summary", handlers.BillingSummary)
	registerMethodRoute(router, http.MethodPost, "/api/v1/billing/checkout", handlers.BillingCheckout)
	registerMethodRoute(router, http.MethodPost, "/api/v1/billing/webhook", handlers.BillingWebhook)
}
