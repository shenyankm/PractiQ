package httpserver

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

func registerMethodRoute(router chi.Router, method string, pattern string, handler http.Handler) {
	if handler == nil {
		return
	}
	router.Method(method, pattern, withStdPathValues(handler))
}
