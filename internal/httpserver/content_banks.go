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

func handleBankGet(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	user, bankID, ok := requireUserAndBankID(w, r, currentUser)
	if !ok {
		return
	}
	data, err := services.GetBank(r.Context(), pool, user, bankID)
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	api.OK(w, r, data, nil)
}

func handleBankUpdate(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	user, bankID, ok := requireUserAndBankID(w, r, currentUser)
	if !ok {
		return
	}
	var body struct {
		Name        *string `json:"name"`
		Description *string `json:"description"`
		IsPublic    *bool   `json:"isPublic"`
	}
	if err := readJSONBody(r, &body); err != nil {
		api.HandleError(w, r, err)
		return
	}
	data, err := services.UpdateBank(r.Context(), pool, user, bankID, services.UpdateBankInput{
		Name:        body.Name,
		Description: body.Description,
		IsPublic:    body.IsPublic,
	})
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	api.OK(w, r, data, nil)
}

func handleBankDelete(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	user, bankID, ok := requireUserAndBankID(w, r, currentUser)
	if !ok {
		return
	}
	if err := services.DeleteBank(r.Context(), pool, user, bankID); err != nil {
		api.HandleError(w, r, err)
		return
	}
	api.NoContent(w, r)
}

func handleBankItems(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	user, bankID, ok := requireUserAndBankID(w, r, currentUser)
	if !ok {
		return
	}
	data, err := services.ListBankItems(r.Context(), pool, user, bankID, services.ListBankItemsParams{
		Status: r.URL.Query().Get("status"),
		Type:   r.URL.Query().Get("type"),
		Limit:  queryInt(r, "limit"),
	})
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	api.OK(w, r, data, nil)
}

func handleBankItemsReorder(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	user, bankID, ok := requireUserAndBankID(w, r, currentUser)
	if !ok {
		return
	}
	var body struct {
		Items []struct {
			QuestionID *int64 `json:"questionId"`
			GroupID    *int64 `json:"groupId"`
			SortOrder  int    `json:"sortOrder"`
		} `json:"items"`
	}
	if err := readJSONBody(r, &body); err != nil {
		api.HandleError(w, r, err)
		return
	}
	items := make([]services.ReorderBankItem, 0, len(body.Items))
	for index, item := range body.Items {
		if item.SortOrder <= 0 {
			api.HandleError(w, r, api.ValidationError([]api.ValidationDetail{{Field: "items." + strconv.Itoa(index) + ".sortOrder", Message: "must be positive"}}))
			return
		}
		if item.QuestionID == nil && item.GroupID == nil {
			api.HandleError(w, r, api.ValidationError([]api.ValidationDetail{{Field: "items." + strconv.Itoa(index), Message: "questionId or groupId is required"}}))
			return
		}
		items = append(items, services.ReorderBankItem{QuestionID: item.QuestionID, GroupID: item.GroupID, SortOrder: item.SortOrder})
	}
	if err := services.ReorderBankItems(r.Context(), pool, user, bankID, items); err != nil {
		api.HandleError(w, r, err)
		return
	}
	api.NoContent(w, r)
}

func handleBankFavoriteCreate(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	handleBankFavorite(w, r, pool, currentUser, true)
}

func handleBankFavoriteDelete(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	handleBankFavorite(w, r, pool, currentUser, false)
}

func handleBankFavorite(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver, favorite bool) {
	user, bankID, ok := requireUserAndBankID(w, r, currentUser)
	if !ok {
		return
	}
	if err := services.SetFavorite(r.Context(), pool, user, bankID, favorite); err != nil {
		api.HandleError(w, r, err)
		return
	}
	api.NoContent(w, r)
}

func handleBankQuestionCreate(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	user, bankID, ok := requireUserAndBankID(w, r, currentUser)
	if !ok {
		return
	}
	raw, err := readRawBody(r)
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	if err := api.ValidateQuestionPayload(raw); err != nil {
		api.HandleError(w, r, err)
		return
	}
	var body struct {
		QuestionTypeID string  `json:"questionTypeId"`
		AnswerMode     string  `json:"answerMode"`
		Stem           string  `json:"stem"`
		Analysis       *string `json:"analysis"`
		ChoiceVariant  *string `json:"choiceVariant"`
		Status         string  `json:"status"`
		Options        []struct {
			Label     string `json:"label"`
			Content   string `json:"content"`
			IsCorrect bool   `json:"isCorrect"`
		} `json:"options"`
		AnswerPayload map[string]any `json:"answerPayload"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		api.HandleError(w, r, api.NewError(http.StatusBadRequest, "INVALID_JSON", "Request body must be valid JSON", nil))
		return
	}
	options := make([]services.QuestionOptionInput, 0, len(body.Options))
	for _, option := range body.Options {
		options = append(options, services.QuestionOptionInput{Label: option.Label, Content: option.Content, IsCorrect: option.IsCorrect})
	}
	data, err := services.CreateQuestion(r.Context(), pool, user, bankID, services.CreateQuestionInput{
		QuestionTypeID: body.QuestionTypeID,
		AnswerMode:     body.AnswerMode,
		Stem:           body.Stem,
		Analysis:       body.Analysis,
		ChoiceVariant:  body.ChoiceVariant,
		Status:         body.Status,
		Options:        options,
		AnswerPayload:  body.AnswerPayload,
	}, nil)
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	api.Created(w, r, data, nil)
}

func handleBankGroupCreate(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	user, bankID, ok := requireUserAndBankID(w, r, currentUser)
	if !ok {
		return
	}
	var body struct {
		Title        string  `json:"title"`
		Instructions *string `json:"instructions"`
		GroupTypeID  *string `json:"groupTypeId"`
		ContentMode  *string `json:"contentMode"`
		Status       string  `json:"status"`
	}
	if err := readJSONBody(r, &body); err != nil {
		api.HandleError(w, r, err)
		return
	}
	if strings.TrimSpace(body.Title) == "" {
		api.HandleError(w, r, api.ValidationError([]api.ValidationDetail{{Field: "title", Message: "is required"}}))
		return
	}
	data, err := services.CreateGroup(r.Context(), pool, user, bankID, services.CreateGroupInput{
		Title:        body.Title,
		Instructions: body.Instructions,
		GroupTypeID:  trimmedString(body.GroupTypeID),
		ContentMode:  body.ContentMode,
		Status:       body.Status,
	})
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	api.Created(w, r, data, nil)
}

func requireUserAndBankID(w http.ResponseWriter, r *http.Request, currentUser auth.CurrentUserResolver) (*auth.User, int64, bool) {
	user, err := auth.RequireUser(r, currentUser)
	if err != nil {
		api.HandleError(w, r, err)
		return nil, 0, false
	}
	bankID, err := parsePathID(r, "bankId")
	if err != nil {
		api.HandleError(w, r, err)
		return nil, 0, false
	}
	return user, bankID, true
}
