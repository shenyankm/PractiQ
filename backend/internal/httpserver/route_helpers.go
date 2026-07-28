package httpserver

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"practiq/internal/api"
	"practiq/internal/auth"
	"practiq/internal/services"
)

const maxJSONBodyBytes int64 = 1024 * 1024

type optionalJSONField[T any] struct {
	Value T
	Set   bool
}

func (field *optionalJSONField[T]) UnmarshalJSON(data []byte) error {
	field.Set = true
	return json.Unmarshal(data, &field.Value)
}

func decodeJSONBodyStrict[T any](r *http.Request, allowEmpty ...bool) (T, error) {
	return decodeJSONBodyStrictLimit[T](r, maxJSONBodyBytes, allowEmpty...)
}

func decodeJSONBodyStrictLimit[T any](r *http.Request, maxBytes int64, allowEmpty ...bool) (T, error) {
	var body T
	r.Body = http.MaxBytesReader(nil, r.Body, maxBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		if err == io.EOF && len(allowEmpty) > 0 && allowEmpty[0] {
			return body, nil
		}
		return body, strictJSONError(err)
	}
	var extra struct{}
	if err := decoder.Decode(&extra); err != io.EOF {
		return body, strictJSONError(err)
	}
	return body, nil
}

func strictJSONError(err error) error {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return err
	}
	return api.NewError(http.StatusBadRequest, "INVALID_JSON", "Request body must be valid JSON", nil)
}

func parsePathID(r *http.Request, name string) (int64, error) {
	id, err := strconv.ParseInt(strings.TrimSpace(r.PathValue(name)), 10, 64)
	if err != nil || id <= 0 {
		return 0, api.NewError(http.StatusUnprocessableEntity, "VALIDATION_ERROR", "Invalid "+name, nil)
	}
	return id, nil
}

func queryPageLimit(r *http.Request, maximum int) (int, error) {
	raw := strings.TrimSpace(r.URL.Query().Get("limit"))
	if raw == "" {
		return 0, nil
	}
	limit, err := strconv.Atoi(raw)
	if err != nil || limit < 1 || limit > maximum {
		return 0, api.ValidationError([]api.ValidationDetail{{Field: "limit", Message: "must be between 1 and " + strconv.Itoa(maximum)}})
	}
	return limit, nil
}

func requireCurrentUser(r *http.Request, resolve auth.CurrentUserResolver) (auth.User, error) {
	user, err := auth.RequireUser(r, resolve)
	if err != nil {
		return auth.User{}, err
	}
	return *user, nil
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

func paginationMeta(info services.PageInfo) map[string]any {
	return map[string]any{
		"pagination": map[string]any{
			"cursor":  info.Cursor,
			"limit":   info.Limit,
			"hasMore": info.HasMore,
		},
	}
}
