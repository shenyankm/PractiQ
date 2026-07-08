package httpserver

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"openwook/internal/api"
	"openwook/internal/auth"
)

func withStdPathValues(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		routeContext := chi.RouteContext(r.Context())
		if routeContext != nil {
			for index, key := range routeContext.URLParams.Keys {
				if key == "" || key == "*" || index >= len(routeContext.URLParams.Values) {
					continue
				}
				r.SetPathValue(key, routeContext.URLParams.Values[index])
			}
		}
		next.ServeHTTP(w, r)
	})
}
func decodeJSONBodyStrict[T any](r *http.Request) (T, error) {
	var body T
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		return body, api.NewError(http.StatusBadRequest, "INVALID_JSON", "Request body must be valid JSON", nil)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return body, api.NewError(http.StatusBadRequest, "INVALID_JSON", "Request body must be valid JSON", nil)
	}
	return body, nil
}

func parsePathID(r *http.Request, name string) (int64, error) {
	id, err := strconv.ParseInt(r.PathValue(name), 10, 64)
	if err != nil || id <= 0 {
		return 0, api.NewError(http.StatusUnprocessableEntity, "VALIDATION_ERROR", "Invalid "+name, nil)
	}
	return id, nil
}

func requireCurrentUser(r *http.Request, resolve auth.CurrentUserResolver) (auth.User, error) {
	user, err := auth.RequireUser(r, resolve)
	if err != nil {
		return auth.User{}, err
	}
	return *user, nil
}

func validateURLString(raw string) bool {
	_, err := url.ParseRequestURI(raw)
	return err == nil
}

func trimmedOrNil(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}
