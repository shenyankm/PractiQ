package httpserver

import (
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgxpool"
	"openwook/internal/api"
	"openwook/internal/auth"
	"openwook/internal/services"
)

func BuildContentHandlers(pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) ContentHandlers {
	return ContentHandlers{
		Banks:                    http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleBanks(w, r, pool, currentUser) }),
		BankGet:                  http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleBankGet(w, r, pool, currentUser) }),
		BankUpdate:               http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleBankUpdate(w, r, pool, currentUser) }),
		BankDelete:               http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleBankDelete(w, r, pool, currentUser) }),
		BankItems:                http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleBankItems(w, r, pool, currentUser) }),
		BankItemsReorder:         http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleBankItemsReorder(w, r, pool, currentUser) }),
		BankFavoriteCreate:       http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleBankFavoriteCreate(w, r, pool, currentUser) }),
		BankFavoriteDelete:       http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleBankFavoriteDelete(w, r, pool, currentUser) }),
		BankQuestionCreate:       http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleBankQuestionCreate(w, r, pool, currentUser) }),
		BankGroups:               http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleBankGroups(w, r, pool, currentUser) }),
		BankGroupCreate:          http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleBankGroupCreate(w, r, pool, currentUser) }),
		QuestionGet:              http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleQuestionGet(w, r, pool, currentUser) }),
		QuestionUpdate:           http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleQuestionUpdate(w, r, pool, currentUser) }),
		QuestionDelete:           http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleQuestionDelete(w, r, pool, currentUser) }),
		QuestionPublish:          http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleQuestionPublish(w, r, pool, currentUser) }),
		QuestionArchive:          http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleQuestionArchive(w, r, pool, currentUser) }),
		QuestionOptionCreate:     http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleQuestionOptionCreate(w, r, pool, currentUser) }),
		QuestionOptionUpdate:     http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleQuestionOptionUpdate(w, r, pool, currentUser) }),
		QuestionOptionDelete:     http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleQuestionOptionDelete(w, r, pool, currentUser) }),
		QuestionAnswerKeyPut:     http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleQuestionAnswerKeyPut(w, r, pool, currentUser) }),
		QuestionContentBlocksPut: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleQuestionContentBlocksPut(w, r, pool, currentUser) }),
		GroupGet:                 http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleGroupGet(w, r, pool, currentUser) }),
		GroupUpdate:              http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleGroupUpdate(w, r, pool, currentUser) }),
		GroupDelete:              http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleGroupDelete(w, r, pool, currentUser) }),
		GroupPublish:             http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleGroupStatus(w, r, pool, currentUser, "active") }),
		GroupArchive:             http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleGroupStatus(w, r, pool, currentUser, "archived") }),
		GroupQuestionCreate:      http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleGroupQuestionCreate(w, r, pool, currentUser) }),
		GroupQuestionsReorder:    http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleGroupQuestionsReorder(w, r, pool, currentUser) }),
		GroupQuestionDelete:      http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleGroupQuestionDelete(w, r, pool, currentUser) }),
	}
}

func handleBanks(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	switch r.Method {
	case http.MethodGet:
		user, err := auth.RequireUser(r, currentUser)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		limit, err := queryPageLimit(r, 100)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		data, err := services.ListBanks(r.Context(), pool, user, services.ListBanksParams{
			Scope:   r.URL.Query().Get("scope"),
			Subject: r.URL.Query().Get("subject"),
			Query:   r.URL.Query().Get("q"),
			Limit:   limit,
			Cursor:  r.URL.Query().Get("cursor"),
		})
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		api.OK(w, r, data.Items, paginationMeta(data.PageInfo))
	case http.MethodPost:
		user, err := auth.RequireUser(r, currentUser)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		body, err := decodeJSONBodyStrict[struct {
			Name        string  `json:"name"`
			Description *string `json:"description"`
			Subject     string  `json:"subject"`
			IsPublic    bool    `json:"isPublic"`
		}](r)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		var details []api.ValidationDetail
		body.Name = strings.TrimSpace(body.Name)
		if body.Name == "" || utf8.RuneCountInString(body.Name) > 100 {
			details = append(details, api.ValidationDetail{Field: "name", Message: "must be 1-100 characters"})
		}
		if body.Description != nil {
			description := strings.TrimSpace(*body.Description)
			body.Description = &description
			if utf8.RuneCountInString(description) > 500 {
				details = append(details, api.ValidationDetail{Field: "description", Message: "must be no more than 500 characters"})
			}
		}
		if strings.TrimSpace(body.Subject) == "" {
			details = append(details, api.ValidationDetail{Field: "subject", Message: "is required"})
		}
		if len(details) > 0 {
			api.HandleError(w, r, api.ValidationError(details))
			return
		}
		data, err := services.CreateBank(r.Context(), pool, user, services.CreateBankInput{
			Name:        body.Name,
			Description: body.Description,
			Subject:     body.Subject,
			IsPublic:    body.IsPublic,
		})
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		api.Created(w, r, data, nil)
	default:
		api.HandleError(w, r, api.NewError(http.StatusNotFound, "NOT_FOUND", "Endpoint not found", nil))
	}
}

func trimmedString(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}
