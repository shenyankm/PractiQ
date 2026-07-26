package httpserver

import (
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"openwook/internal/api"
	"openwook/internal/auth"
	"openwook/internal/services"
)

type practiceStartRequest struct {
	BankID         *int64  `json:"bankId"`
	SessionType    *string `json:"sessionType"`
	QuestionCount  *int    `json:"questionCount"`
	Mode           *string `json:"mode"`
	QuestionTypeID *string `json:"questionTypeId"`
	AllQuestions   *bool   `json:"allQuestions"`
}

type practiceAnswerRequest struct {
	QuestionID    *int64         `json:"questionId"`
	AnswerPayload map[string]any `json:"answerPayload"`
	DurationMS    *int           `json:"durationMs"`
}

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
			body, err := decodeJSONBodyStrict[practiceStartRequest](r)
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
			body, err := decodeJSONBodyStrict[practiceAnswerRequest](r)
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

func parsePracticeStartInput(body practiceStartRequest) (services.PracticeSessionInput, error) {
	var details []api.ValidationDetail
	var input services.PracticeSessionInput

	if body.BankID == nil {
		details = append(details, api.ValidationDetail{Field: "bankId", Message: "is required"})
	} else if *body.BankID <= 0 {
		details = append(details, api.ValidationDetail{Field: "bankId", Message: "must be a positive integer"})
	} else {
		input.BankID = *body.BankID
	}
	input.SessionType = parseOptionalPracticeEnum(body.SessionType, "sessionType", []string{"practice", "review", "exam"}, &details)
	if body.QuestionCount != nil {
		if *body.QuestionCount <= 0 || *body.QuestionCount > 500 {
			details = append(details, api.ValidationDetail{Field: "questionCount", Message: "must be a positive integer no greater than 500"})
		} else {
			input.QuestionCount = *body.QuestionCount
		}
	}
	input.Mode = parseOptionalPracticeEnum(body.Mode, "mode", []string{"all", "wrong", "by_type", "exam"}, &details)
	if body.QuestionTypeID != nil {
		questionTypeID := strings.TrimSpace(*body.QuestionTypeID)
		if questionTypeID == "" || len(questionTypeID) > 64 {
			details = append(details, api.ValidationDetail{Field: "questionTypeId", Message: "must be a non-empty string"})
		} else {
			input.QuestionTypeID = &questionTypeID
		}
	}
	if body.AllQuestions != nil {
		input.AllQuestions = *body.AllQuestions
	}

	if len(details) > 0 {
		return services.PracticeSessionInput{}, api.ValidationError(details)
	}
	return input, nil
}

func parsePracticeAnswerInput(body practiceAnswerRequest) (services.PracticeAnswerInput, error) {
	var details []api.ValidationDetail
	input := services.PracticeAnswerInput{AnswerPayload: body.AnswerPayload, DurationMS: body.DurationMS}
	if body.QuestionID == nil {
		details = append(details, api.ValidationDetail{Field: "questionId", Message: "is required"})
	} else if *body.QuestionID <= 0 {
		details = append(details, api.ValidationDetail{Field: "questionId", Message: "must be a positive integer"})
	} else {
		input.QuestionID = *body.QuestionID
	}
	if body.AnswerPayload == nil {
		details = append(details, api.ValidationDetail{Field: "answerPayload", Message: "is required"})
	}
	if body.DurationMS != nil && *body.DurationMS < 0 {
		details = append(details, api.ValidationDetail{Field: "durationMs", Message: "must be a non-negative integer"})
	}

	if len(details) > 0 {
		return services.PracticeAnswerInput{}, api.ValidationError(details)
	}
	return input, nil
}

func parseOptionalPracticeEnum(value *string, field string, allowed []string, details *[]api.ValidationDetail) string {
	if value == nil {
		return ""
	}
	trimmed := strings.TrimSpace(*value)
	if slices.Contains(allowed, trimmed) {
		return trimmed
	}
	*details = append(*details, api.ValidationDetail{Field: field, Message: "has an invalid value"})
	return ""
}
