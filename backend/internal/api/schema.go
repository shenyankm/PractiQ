package api

import (
	"encoding/json"
	"fmt"
)

var answerModes = set("choice", "true_false", "fill_blank", "short_answer")
var questionStatuses = set("draft", "active", "archived")
var importChildKinds = set("events", "pages", "blocks", "review-items", "outputs", "artifacts")
var publicSourceTypes = set("docx", "txt", "text")

func ValidateQuestionPayload(body []byte) error {
	var payload struct {
		QuestionTypeID string `json:"questionTypeId"`
		AnswerMode     string `json:"answerMode"`
		Stem           string `json:"stem"`
		Status         string `json:"status"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return NewError(400, "INVALID_JSON", "Request body must be valid JSON", nil)
	}
	var details []ValidationDetail
	if payload.QuestionTypeID == "" {
		details = append(details, ValidationDetail{Field: "questionTypeId", Message: "is required"})
	}
	if payload.Stem == "" {
		details = append(details, ValidationDetail{Field: "stem", Message: "is required"})
	}
	if !answerModes[payload.AnswerMode] {
		details = append(details, ValidationDetail{Field: "answerMode", Message: "must be one of choice, true_false, fill_blank, short_answer"})
	}
	if payload.Status != "" && !questionStatuses[payload.Status] {
		details = append(details, ValidationDetail{Field: "status", Message: "must be one of draft, active, archived"})
	}
	if len(details) > 0 {
		return ValidationError(details)
	}
	return nil
}

func ValidateQuestionUpdatePayload(body []byte) error {
	var payload struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return NewError(400, "INVALID_JSON", "Request body must be valid JSON", nil)
	}
	if payload.Status != "" && !questionStatuses[payload.Status] {
		return ValidationError([]ValidationDetail{{Field: "status", Message: "must be one of draft, active, archived"}})
	}
	return nil
}

func ValidateImportJobPayload(body []byte) error {
	var payload struct {
		SourceType string `json:"sourceType"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return NewError(400, "INVALID_JSON", "Request body must be valid JSON", nil)
	}
	if payload.SourceType != "" && !publicSourceTypes[payload.SourceType] {
		return ValidationError([]ValidationDetail{{Field: "sourceType", Message: "must be one of docx, txt, text"}})
	}
	return nil
}

func ValidateImportChildKind(kind string) error {
	if !importChildKinds[kind] {
		return ValidationError([]ValidationDetail{{Field: "kind", Message: fmt.Sprintf("unsupported import child kind %q", kind)}})
	}
	return nil
}

func ValidateAIDocumentParsePayload(body []byte) error {
	var payload struct {
		SourceType string `json:"sourceType"`
		Text       string `json:"text"`
		FileBase64 string `json:"fileBase64"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return NewError(400, "INVALID_JSON", "Request body must be valid JSON", nil)
	}
	var details []ValidationDetail
	if !publicSourceTypes[payload.SourceType] {
		details = append(details, ValidationDetail{Field: "sourceType", Message: "must be one of docx, txt, text"})
	}
	if payload.Text == "" && payload.FileBase64 == "" {
		details = append(details, ValidationDetail{Field: "text", Message: "text or fileBase64 is required"})
	}
	if len(details) > 0 {
		return ValidationError(details)
	}
	return nil
}

func set(values ...string) map[string]bool {
	out := make(map[string]bool, len(values))
	for _, value := range values {
		out[value] = true
	}
	return out
}
