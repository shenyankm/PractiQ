package httpserver

import (
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"openwook/internal/api"
	"openwook/internal/auth"
	"openwook/internal/redisx"
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

type offlinePracticeRequest struct {
	BankID  *int64 `json:"bankId"`
	Answers []struct {
		QuestionID    *int64         `json:"questionId"`
		AnswerPayload map[string]any `json:"answerPayload"`
	} `json:"answers"`
}

func BuildPracticeHandlers(pool *pgxpool.Pool, resolve auth.CurrentUserResolver) PracticeHandlers {
	return PracticeHandlers{
		List: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, err := auth.RequireUser(r, resolve)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			limit, err := queryPageLimit(r, 100)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			options := services.PracticeSessionListOptions{
				Status: strings.TrimSpace(r.URL.Query().Get("status")),
				Cursor: r.URL.Query().Get("cursor"),
				Limit:  limit,
			}
			data, err := services.ListPracticeSessions(r.Context(), pool, user, options)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.OK(w, r, data.Items, paginationMeta(data.PageInfo))
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
		OfflineUpload: buildOfflinePracticeHandler(pool, resolve),
	}
}

func buildOfflinePracticeHandler(pool *pgxpool.Pool, resolve auth.CurrentUserResolver) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, err := auth.RequireUser(r, resolve)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		body, err := decodeJSONBodyStrict[offlinePracticeRequest](r)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		if body.BankID == nil || *body.BankID < 1 || len(body.Answers) < 1 || len(body.Answers) > 500 {
			api.HandleError(w, r, api.ValidationError([]api.ValidationDetail{{Field: "answers", Message: "bankId and 1-500 answers are required"}}))
			return
		}
		questionIDs := make(map[int64]struct{}, len(body.Answers))
		for index, answer := range body.Answers {
			if answer.QuestionID == nil || *answer.QuestionID < 1 {
				api.HandleError(w, r, api.ValidationError([]api.ValidationDetail{{Field: "answers." + strconv.Itoa(index) + ".questionId", Message: "must be positive"}}))
				return
			}
			if _, duplicate := questionIDs[*answer.QuestionID]; duplicate {
				api.HandleError(w, r, api.ValidationError([]api.ValidationDetail{{Field: "answers." + strconv.Itoa(index) + ".questionId", Message: "must be unique"}}))
				return
			}
			questionIDs[*answer.QuestionID] = struct{}{}
		}
		idempotencyKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
		if idempotencyKey == "" {
			api.HandleError(w, r, api.ValidationError([]api.ValidationDetail{{Field: "Idempotency-Key", Message: "is required"}}))
			return
		}
		rdb := redisx.Client()
		if rdb == nil {
			api.HandleError(w, r, api.NewError(http.StatusServiceUnavailable, "IDEMPOTENCY_UNAVAILABLE", "Offline practice upload is temporarily unavailable", nil))
			return
		}
		sessionKey := redisx.RedisKey("offline-practice", user.ID, idempotencyKey)
		sessionID, _ := rdb.Get(r.Context(), sessionKey).Int64()
		var session *services.PracticeSession
		if sessionID > 0 {
			session, err = services.GetPracticeSession(r.Context(), pool, user, sessionID)
		} else {
			session, err = services.StartPracticeSession(r.Context(), pool, user, services.PracticeSessionInput{
				BankID:        *body.BankID,
				SessionType:   "practice",
				QuestionCount: len(body.Answers),
				Mode:          "all",
			})
			if err == nil {
				sessionID = session.ID
				err = rdb.Set(r.Context(), sessionKey, sessionID, idempotencyTTL).Err()
			}
		}
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		for _, answer := range body.Answers {
			if _, err := services.SubmitAnswer(r.Context(), pool, user, sessionID, services.PracticeAnswerInput{
				QuestionID:    *answer.QuestionID,
				AnswerPayload: answer.AnswerPayload,
			}); err != nil {
				api.HandleError(w, r, err)
				return
			}
		}
		session, err = services.GetPracticeSession(r.Context(), pool, user, sessionID)
		if err == nil && session.Status == "active" {
			session, err = services.CompletePracticeSession(r.Context(), pool, user, sessionID, "completed")
		}
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		api.OK(w, r, session, nil)
	})
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
