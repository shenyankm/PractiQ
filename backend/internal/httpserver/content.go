package httpserver

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"

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
		BankGroupCreate:          http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleBankGroupCreate(w, r, pool, currentUser) }),
		QuestionGet:              http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleQuestionGet(w, r, pool, currentUser) }),
		QuestionUpdate:           http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleQuestionUpdate(w, r, pool, currentUser) }),
		QuestionDelete:           http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleQuestionDelete(w, r, pool, currentUser) }),
		QuestionPublish:          http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleQuestionPublish(w, r, pool, currentUser) }),
		QuestionArchive:          http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleQuestionArchive(w, r, pool, currentUser) }),
		QuestionOptionCreate:     http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleQuestionOptionCreate(w, r, pool, currentUser) }),
		QuestionOptionUpdate:     http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleQuestionOptionUpdate(w, r, pool, currentUser) }),
		QuestionAnswerKeyPut:     http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleQuestionAnswerKeyPut(w, r, pool, currentUser) }),
		QuestionMetadataPut:      http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleQuestionMetadataPut(w, r, pool, currentUser) }),
		QuestionKnowledgePut:     http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleQuestionKnowledgePut(w, r, pool, currentUser) }),
		QuestionContentBlocksPut: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleQuestionContentBlocksPut(w, r, pool, currentUser) }),
		GroupGet:                 http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleGroupGet(w, r, pool, currentUser) }),
		GroupUpdate:              http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleGroupUpdate(w, r, pool, currentUser) }),
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
		data, err := services.ListBanks(r.Context(), pool, user, services.ListBanksParams{
			Scope:   r.URL.Query().Get("scope"),
			Subject: r.URL.Query().Get("subject"),
			Query:   r.URL.Query().Get("q"),
			Limit:   queryInt(r, "limit"),
		})
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		api.OK(w, r, data, nil)
	case http.MethodPost:
		user, err := auth.RequireUser(r, currentUser)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		var body struct {
			Name        string  `json:"name"`
			Description *string `json:"description"`
			Subject     string  `json:"subject"`
			IsPublic    bool    `json:"isPublic"`
		}
		if err := readJSONBody(r, &body); err != nil {
			api.HandleError(w, r, err)
			return
		}
		var details []api.ValidationDetail
		if strings.TrimSpace(body.Name) == "" {
			details = append(details, api.ValidationDetail{Field: "name", Message: "is required"})
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

func readJSONBody(r *http.Request, target any) error {
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(target); err != nil {
		return api.NewError(http.StatusBadRequest, "INVALID_JSON", "Request body must be valid JSON", nil)
	}
	return nil
}

func readRawBody(r *http.Request) ([]byte, error) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return []byte("{}"), nil
	}
	return raw, nil
}

func queryInt(r *http.Request, key string) int {
	value := strings.TrimSpace(r.URL.Query().Get(key))
	if value == "" {
		return 0
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0
	}
	return parsed
}

func trimmedString(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}
