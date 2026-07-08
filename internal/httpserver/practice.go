package httpserver

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"openwook/internal/api"
	"openwook/internal/auth"
	"openwook/internal/services"
)

func BuildPracticeHandlers(pool *pgxpool.Pool, resolve auth.CurrentUserResolver) PracticeHandlers {
	return PracticeHandlers{
		List: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, err := auth.RequireUser(r, resolve)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			options := services.PracticeSessionListOptions{Status: strings.TrimSpace(r.URL.Query().Get("status"))}
			if limit, err := strconv.Atoi(strings.TrimSpace(r.URL.Query().Get("limit"))); err == nil {
				options.Limit = limit
			}
			data, err := services.ListPracticeSessions(r.Context(), pool, user, options)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.OK(w, r, data, nil)
		}),
		Start: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, err := auth.RequireUser(r, resolve)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			body, err := decodeJSONBodyStrict[map[string]json.RawMessage](r)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			input, err := parsePracticeStartInput(body)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := services.StartPracticeSession(r.Context(), pool, user, input)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.Created(w, r, data, nil)
		}),
		Get: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, err := auth.RequireUser(r, resolve)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			sessionID, err := parsePathID(r, "sessionId")
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := services.GetPracticeSession(r.Context(), pool, user, sessionID)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.OK(w, r, data, nil)
		}),
		QuestionPage: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, err := auth.RequireUser(r, resolve)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			sessionID, err := parsePathID(r, "sessionId")
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			var index *int
			if raw := strings.TrimSpace(r.URL.Query().Get("index")); raw != "" {
				if parsed, err := strconv.Atoi(raw); err == nil {
					index = &parsed
				}
			}
			data, err := services.GetPracticeQuestionPage(r.Context(), pool, user, sessionID, services.PracticeQuestionPageOptions{Index: index})
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.OK(w, r, data, nil)
		}),
		Questions: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, err := auth.RequireUser(r, resolve)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			sessionID, err := parsePathID(r, "sessionId")
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := services.GetPracticeQuestions(r.Context(), pool, user, sessionID)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.OK(w, r, data, nil)
		}),
		Results: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, err := auth.RequireUser(r, resolve)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			sessionID, err := parsePathID(r, "sessionId")
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := services.GetPracticeResults(r.Context(), pool, user, sessionID)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.OK(w, r, data, nil)
		}),
		SubmitAnswer: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, err := auth.RequireUser(r, resolve)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			sessionID, err := parsePathID(r, "sessionId")
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			body, err := decodeJSONBodyStrict[map[string]json.RawMessage](r)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			input, err := parsePracticeAnswerInput(body)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := services.SubmitAnswer(r.Context(), pool, user, sessionID, input)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.Created(w, r, data, nil)
		}),
		Complete: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			handlePracticeTerminalState(w, r, resolve, pool, "completed")
		}),
		Abandon: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			handlePracticeTerminalState(w, r, resolve, pool, "abandoned")
		}),
	}
}

func handlePracticeTerminalState(w http.ResponseWriter, r *http.Request, resolve auth.CurrentUserResolver, pool *pgxpool.Pool, status string) {
	user, err := auth.RequireUser(r, resolve)
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	sessionID, err := parsePathID(r, "sessionId")
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	data, err := services.CompletePracticeSession(r.Context(), pool, user, sessionID, status)
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	api.OK(w, r, data, nil)
}

func parsePracticeStartInput(body map[string]json.RawMessage) (services.PracticeSessionInput, error) {
	var details []api.ValidationDetail
	var input services.PracticeSessionInput

	input.BankID = parseRequiredPositiveInt64(body, "bankId", &details)
	input.SessionType = parseOptionalEnumString(body, "sessionType", []string{"practice", "review", "exam"}, &details)
	if questionCount, ok := parseOptionalPositiveInt(body, "questionCount", 500, &details); ok {
		input.QuestionCount = questionCount
	}
	input.Mode = parseOptionalEnumString(body, "mode", []string{"all", "wrong", "by_type", "exam"}, &details)
	input.QuestionTypeID = parseOptionalNullableString(body, "questionTypeId", 64, &details)
	input.AllQuestions = parseOptionalBool(body, "allQuestions", &details)

	if len(details) > 0 {
		return services.PracticeSessionInput{}, api.ValidationError(details)
	}
	return input, nil
}

func parsePracticeAnswerInput(body map[string]json.RawMessage) (services.PracticeAnswerInput, error) {
	var details []api.ValidationDetail
	var input services.PracticeAnswerInput

	input.QuestionID = parseRequiredPositiveInt64(body, "questionId", &details)
	input.AnswerPayload = parseRequiredObject(body, "answerPayload", &details)
	if durationMS, ok := parseOptionalNonNegativeInt(body, "durationMs", &details); ok {
		input.DurationMS = &durationMS
	}

	if len(details) > 0 {
		return services.PracticeAnswerInput{}, api.ValidationError(details)
	}
	return input, nil
}

func parseRequiredPositiveInt64(body map[string]json.RawMessage, field string, details *[]api.ValidationDetail) int64 {
	raw, ok := body[field]
	if !ok || string(raw) == "null" {
		*details = append(*details, api.ValidationDetail{Field: field, Message: "is required"})
		return 0
	}
	var value int64
	if err := json.Unmarshal(raw, &value); err != nil || value <= 0 {
		*details = append(*details, api.ValidationDetail{Field: field, Message: "must be a positive integer"})
		return 0
	}
	return value
}

func parseOptionalPositiveInt(body map[string]json.RawMessage, field string, max int, details *[]api.ValidationDetail) (int, bool) {
	raw, ok := body[field]
	if !ok || string(raw) == "null" {
		return 0, false
	}
	var value int
	if err := json.Unmarshal(raw, &value); err != nil || value <= 0 || value > max {
		*details = append(*details, api.ValidationDetail{Field: field, Message: "must be a positive integer no greater than 500"})
		return 0, false
	}
	return value, true
}

func parseOptionalNonNegativeInt(body map[string]json.RawMessage, field string, details *[]api.ValidationDetail) (int, bool) {
	raw, ok := body[field]
	if !ok || string(raw) == "null" {
		return 0, false
	}
	var value int
	if err := json.Unmarshal(raw, &value); err != nil || value < 0 {
		*details = append(*details, api.ValidationDetail{Field: field, Message: "must be a non-negative integer"})
		return 0, false
	}
	return value, true
}

func parseOptionalEnumString(body map[string]json.RawMessage, field string, allowed []string, details *[]api.ValidationDetail) string {
	raw, ok := body[field]
	if !ok || string(raw) == "null" {
		return ""
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		*details = append(*details, api.ValidationDetail{Field: field, Message: "must be a string"})
		return ""
	}
	value = strings.TrimSpace(value)
	for _, candidate := range allowed {
		if value == candidate {
			return value
		}
	}
	*details = append(*details, api.ValidationDetail{Field: field, Message: "has an invalid value"})
	return ""
}

func parseOptionalNullableString(body map[string]json.RawMessage, field string, maxLen int, details *[]api.ValidationDetail) *string {
	raw, ok := body[field]
	if !ok {
		return nil
	}
	if string(raw) == "null" {
		return nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		*details = append(*details, api.ValidationDetail{Field: field, Message: "must be a string"})
		return nil
	}
	value = strings.TrimSpace(value)
	if value == "" || len(value) > maxLen {
		*details = append(*details, api.ValidationDetail{Field: field, Message: "must be a non-empty string"})
		return nil
	}
	return &value
}

func parseOptionalBool(body map[string]json.RawMessage, field string, details *[]api.ValidationDetail) bool {
	raw, ok := body[field]
	if !ok || string(raw) == "null" {
		return false
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		*details = append(*details, api.ValidationDetail{Field: field, Message: "must be a boolean"})
		return false
	}
	return value
}

func parseRequiredObject(body map[string]json.RawMessage, field string, details *[]api.ValidationDetail) map[string]any {
	raw, ok := body[field]
	if !ok || string(raw) == "null" {
		*details = append(*details, api.ValidationDetail{Field: field, Message: "is required"})
		return nil
	}
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil || value == nil {
		*details = append(*details, api.ValidationDetail{Field: field, Message: "must be an object"})
		return nil
	}
	return value
}
