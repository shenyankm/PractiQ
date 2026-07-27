package httpserver

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"openwook/internal/api"
	"openwook/internal/auth"
)

const maxJSONBodyBytes int64 = 1024 * 1024

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
