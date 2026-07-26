package httpserver

import "net/http"

func registerMethodRoute(router *http.ServeMux, method string, pattern string, handler http.Handler) {
	if handler == nil {
		return
	}
	router.Handle(method+" "+pattern, handler)
	if method == http.MethodGet {
		router.HandleFunc(http.MethodHead+" "+pattern, apiNotFound)
	}
}
