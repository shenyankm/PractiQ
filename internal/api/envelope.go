package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
)

type requestIDKey struct{}

type Error struct {
	Status  int
	Code    string
	Message string
	Details any
}

func (e *Error) Error() string { return e.Message }

type ValidationDetail struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

func NewError(status int, code, message string, details any) *Error {
	return &Error{Status: status, Code: code, Message: message, Details: details}
}

func ValidationError(details []ValidationDetail) *Error {
	return NewError(http.StatusUnprocessableEntity, "VALIDATION_ERROR", "Invalid request", details)
}

func WithRequestID(ctx context.Context, requestID string) context.Context {
	return context.WithValue(ctx, requestIDKey{}, requestID)
}

func RequestID(ctx context.Context) string {
	requestID, _ := ctx.Value(requestIDKey{}).(string)
	return requestID
}

func OK(w http.ResponseWriter, r *http.Request, data any, meta map[string]any) {
	writeEnvelope(w, r, http.StatusOK, data, meta)
}

func Created(w http.ResponseWriter, r *http.Request, data any, meta map[string]any) {
	writeEnvelope(w, r, http.StatusCreated, data, meta)
}

func NoContent(w http.ResponseWriter, r *http.Request) {
	if requestID := RequestID(r.Context()); requestID != "" {
		w.Header().Set("x-request-id", requestID)
	}
	w.WriteHeader(http.StatusNoContent)
}

func HandleError(w http.ResponseWriter, r *http.Request, err error) {
	var apiErr *Error
	if !errors.As(err, &apiErr) {
		apiErr = NewError(http.StatusInternalServerError, "INTERNAL_ERROR", "Unexpected server error", nil)
	}
	requestID := RequestID(r.Context())
	body := map[string]any{
		"error": map[string]any{
			"code":    apiErr.Code,
			"message": apiErr.Message,
		},
	}
	errorBody := body["error"].(map[string]any)
	if apiErr.Details != nil {
		errorBody["details"] = apiErr.Details
	}
	if requestID != "" {
		errorBody["requestId"] = requestID
	}
	writeJSON(w, requestID, apiErr.Status, body)
}

func ValidationErrorEnvelope(err error) (int, string, string, []map[string]string) {
	var apiErr *Error
	if !errors.As(err, &apiErr) {
		return http.StatusInternalServerError, "INTERNAL_ERROR", "Unexpected server error", nil
	}
	return apiErr.Status, apiErr.Code, apiErr.Message, normalizeDetails(apiErr.Details)
}

func writeEnvelope(w http.ResponseWriter, r *http.Request, status int, data any, meta map[string]any) {
	requestID := RequestID(r.Context())
	resolvedMeta := map[string]any{}
	for key, value := range meta {
		resolvedMeta[key] = value
	}
	if requestID != "" {
		resolvedMeta["requestId"] = requestID
	}
	body := map[string]any{"data": data}
	if len(resolvedMeta) > 0 {
		body["meta"] = resolvedMeta
	}
	writeJSON(w, requestID, status, body)
}

func writeJSON(w http.ResponseWriter, requestID string, status int, body any) {
	if requestID != "" {
		w.Header().Set("x-request-id", requestID)
	}
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func normalizeDetails(details any) []map[string]string {
	switch value := details.(type) {
	case []ValidationDetail:
		out := make([]map[string]string, 0, len(value))
		for _, detail := range value {
			out = append(out, map[string]string{"field": detail.Field, "message": detail.Message})
		}
		return out
	case []map[string]string:
		return value
	default:
		return nil
	}
}
