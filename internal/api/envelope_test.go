package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOKWritesDataEnvelopeWithRequestIDMeta(t *testing.T) {
	rr := httptest.NewRecorder()

	OK(rr, requestWithRequestID(t, "req-ok-123"), map[string]any{"name": "algebra"}, nil)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusOK)
	}

	body := decodeJSONBody(t, rr.Body.Bytes())
	if len(body) != 2 {
		t.Fatalf("body keys = %d, want 2; body=%#v", len(body), body)
	}

	data, ok := body["data"].(map[string]any)
	if !ok {
		t.Fatalf("data = %#v, want object", body["data"])
	}
	if len(data) != 1 || data["name"] != "algebra" {
		t.Fatalf("data = %#v, want map[string]any{\"name\": \"algebra\"}", data)
	}

	meta, ok := body["meta"].(map[string]any)
	if !ok {
		t.Fatalf("meta = %#v, want object", body["meta"])
	}
	if len(meta) != 1 || meta["requestId"] != "req-ok-123" {
		t.Fatalf("meta = %#v, want only requestId", meta)
	}
}

func TestCreatedUsesHTTP201AndSameEnvelopeShape(t *testing.T) {
	rr := httptest.NewRecorder()

	Created(rr, requestWithRequestID(t, "req-created-456"), map[string]any{"id": "bank-42"}, nil)

	if rr.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusCreated)
	}

	body := decodeJSONBody(t, rr.Body.Bytes())
	if len(body) != 2 {
		t.Fatalf("body keys = %d, want 2; body=%#v", len(body), body)
	}

	data, ok := body["data"].(map[string]any)
	if !ok {
		t.Fatalf("data = %#v, want object", body["data"])
	}
	if len(data) != 1 || data["id"] != "bank-42" {
		t.Fatalf("data = %#v, want map[string]any{\"id\": \"bank-42\"}", data)
	}

	meta, ok := body["meta"].(map[string]any)
	if !ok {
		t.Fatalf("meta = %#v, want object", body["meta"])
	}
	if len(meta) != 1 || meta["requestId"] != "req-created-456" {
		t.Fatalf("meta = %#v, want only requestId", meta)
	}
}

func TestNoContentUsesHTTP204AndRequestIDHeader(t *testing.T) {
	rr := httptest.NewRecorder()

	NoContent(rr, requestWithRequestID(t, "req-empty-789"))

	if rr.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusNoContent)
	}
	if rr.Body.Len() != 0 {
		t.Fatalf("body length = %d, want 0", rr.Body.Len())
	}
	if got := rr.Header().Get("x-request-id"); got != "req-empty-789" {
		t.Fatalf("x-request-id = %q, want %q", got, "req-empty-789")
	}
}

func TestHandleErrorMapsValidationErrorsToHTTP422WithFieldDetails(t *testing.T) {
	rr := httptest.NewRecorder()

	HandleError(rr, requestWithRequestID(t, "req-validation-999"), ValidationError([]ValidationDetail{
		{Field: "answerMode", Message: "must be one of choice, true_false, fill_blank, short_answer"},
		{Field: "questions.0.status", Message: "is required"},
	}))

	if rr.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusUnprocessableEntity)
	}

	body := decodeJSONBody(t, rr.Body.Bytes())
	if len(body) != 1 {
		t.Fatalf("body keys = %d, want 1; body=%#v", len(body), body)
	}

	errorBody, ok := body["error"].(map[string]any)
	if !ok {
		t.Fatalf("error = %#v, want object", body["error"])
	}
	if got := errorBody["code"]; got != "VALIDATION_ERROR" {
		t.Fatalf("error.code = %#v, want %q", got, "VALIDATION_ERROR")
	}
	if got := errorBody["message"]; got != "Invalid request" {
		t.Fatalf("error.message = %#v, want %q", got, "Invalid request")
	}
	if got := errorBody["requestId"]; got != "req-validation-999" {
		t.Fatalf("error.requestId = %#v, want %q", got, "req-validation-999")
	}

	details, ok := errorBody["details"].([]any)
	if !ok {
		t.Fatalf("error.details = %#v, want array", errorBody["details"])
	}
	if len(details) != 2 {
		t.Fatalf("details length = %d, want 2", len(details))
	}

	assertValidationDetail(t, details[0], "answerMode", "must be one of choice, true_false, fill_blank, short_answer")
	assertValidationDetail(t, details[1], "questions.0.status", "is required")
}

func requestWithRequestID(t *testing.T, requestID string) *http.Request {
	t.Helper()

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	return req.WithContext(WithRequestID(context.Background(), requestID))
}

func decodeJSONBody(t *testing.T, body []byte) map[string]any {
	t.Helper()

	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("unmarshal body: %v", err)
	}
	return decoded
}

func assertValidationDetail(t *testing.T, raw any, field string, message string) {
	t.Helper()

	detail, ok := raw.(map[string]any)
	if !ok {
		t.Fatalf("detail = %#v, want object", raw)
	}
	if len(detail) != 2 {
		t.Fatalf("detail keys = %d, want 2; detail=%#v", len(detail), detail)
	}
	if got := detail["field"]; got != field {
		t.Fatalf("detail.field = %#v, want %q", got, field)
	}
	if got := detail["message"]; got != message {
		t.Fatalf("detail.message = %#v, want %q", got, message)
	}
}
