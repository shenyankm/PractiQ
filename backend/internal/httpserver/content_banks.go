package httpserver

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgxpool"
	"practiq/internal/api"
	"practiq/internal/auth"
	"practiq/internal/services"
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
	body, err := decodeJSONBodyStrict[struct {
		Name        *string                    `json:"name"`
		Description optionalJSONField[*string] `json:"description"`
		IsPublic    *bool                      `json:"isPublic"`
	}](r)
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	var details []api.ValidationDetail
	if body.Name != nil {
		name := strings.TrimSpace(*body.Name)
		body.Name = &name
		if name == "" || utf8.RuneCountInString(name) > 100 {
			details = append(details, api.ValidationDetail{Field: "name", Message: "must be 1-100 characters"})
		}
	}
	if body.Description.Value != nil {
		description := strings.TrimSpace(*body.Description.Value)
		body.Description.Value = &description
		if utf8.RuneCountInString(description) > 500 {
			details = append(details, api.ValidationDetail{Field: "description", Message: "must be no more than 500 characters"})
		}
	}
	if len(details) > 0 {
		api.HandleError(w, r, api.ValidationError(details))
		return
	}
	data, err := services.UpdateBank(r.Context(), pool, user, bankID, services.UpdateBankInput{
		Name:           body.Name,
		Description:    body.Description.Value,
		DescriptionSet: body.Description.Set,
		IsPublic:       body.IsPublic,
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
	limit, err := queryPageLimit(r, 100)
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	data, err := services.ListBankItems(r.Context(), pool, user, bankID, services.ListBankItemsParams{
		Status:         r.URL.Query().Get("status"),
		Type:           r.URL.Query().Get("type"),
		Limit:          limit,
		IncludeAnswers: r.URL.Query().Get("includeAnswers") == "true",
		Cursor:         r.URL.Query().Get("cursor"),
	})
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	api.OK(w, r, data.Items, paginationMeta(data.PageInfo))
}

func handleBankItemsReorder(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	user, bankID, ok := requireUserAndBankID(w, r, currentUser)
	if !ok {
		return
	}
	body, err := decodeJSONBodyStrict[struct {
		Items []struct {
			QuestionID *int64 `json:"questionId"`
			GroupID    *int64 `json:"groupId"`
			SortOrder  int    `json:"sortOrder"`
		} `json:"items"`
	}](r)
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	if len(body.Items) == 0 {
		api.HandleError(w, r, api.ValidationError([]api.ValidationDetail{{Field: "items", Message: "must not be empty"}}))
		return
	}
	items := make([]services.ReorderBankItem, 0, len(body.Items))
	ids := map[string]bool{}
	sorts := map[int]bool{}
	for index, item := range body.Items {
		if item.SortOrder <= 0 || item.SortOrder > 2_147_483_647 {
			api.HandleError(w, r, api.ValidationError([]api.ValidationDetail{{Field: "items." + strconv.Itoa(index) + ".sortOrder", Message: "must be positive"}}))
			return
		}
		if (item.QuestionID == nil) == (item.GroupID == nil) {
			api.HandleError(w, r, api.ValidationError([]api.ValidationDetail{{Field: "items." + strconv.Itoa(index), Message: "exactly one of questionId or groupId is required"}}))
			return
		}
		key := ""
		if item.QuestionID != nil {
			key = "q:" + fmt.Sprint(*item.QuestionID)
		} else {
			key = "g:" + fmt.Sprint(*item.GroupID)
		}
		if ids[key] || sorts[item.SortOrder] {
			api.HandleError(w, r, api.ValidationError([]api.ValidationDetail{{Field: "items." + strconv.Itoa(index), Message: "item IDs and sortOrder values must be unique"}}))
			return
		}
		ids[key] = true
		sorts[item.SortOrder] = true
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
	body, err := decodeJSONBodyStrict[struct {
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
	}](r)
	if err != nil {
		api.HandleError(w, r, err)
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
	})
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	api.Created(w, r, data, nil)
}

func handleBankGroups(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	user, bankID, ok := requireUserAndBankID(w, r, currentUser)
	if !ok {
		return
	}
	limit, err := queryPageLimit(r, 100)
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	data, err := services.ListBankGroups(r.Context(), pool, user, bankID, limit, r.URL.Query().Get("cursor"))
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	api.OK(w, r, data.Items, paginationMeta(data.PageInfo))
}

func handleBankGroupCreate(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	user, bankID, ok := requireUserAndBankID(w, r, currentUser)
	if !ok {
		return
	}
	body, err := decodeJSONBodyStrict[struct {
		Title        string  `json:"title"`
		Instructions *string `json:"instructions"`
		GroupTypeID  *string `json:"groupTypeId"`
		ContentMode  *string `json:"contentMode"`
		Status       string  `json:"status"`
	}](r)
	if err != nil {
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
