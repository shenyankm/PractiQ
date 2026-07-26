package httpserver

import (
	"net/http"
	"strconv"

	"github.com/jackc/pgx/v5/pgxpool"
	"openwook/internal/api"
	"openwook/internal/auth"
	"openwook/internal/services"
)

func handleGroupGet(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	user, groupID, ok := requireUserAndGroupID(w, r, currentUser)
	if !ok {
		return
	}
	data, err := services.GetGroup(r.Context(), pool, user, groupID)
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	api.OK(w, r, data, nil)
}

func handleGroupUpdate(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	user, groupID, ok := requireUserAndGroupID(w, r, currentUser)
	if !ok {
		return
	}
	body, err := decodeJSONBodyStrict[struct {
		Title        *string `json:"title"`
		Instructions *string `json:"instructions"`
		ContentMode  *string `json:"contentMode"`
	}](r)
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	data, err := services.UpdateGroup(r.Context(), pool, user, groupID, services.UpdateGroupInput{Title: body.Title, Instructions: body.Instructions, ContentMode: body.ContentMode})
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	api.OK(w, r, data, nil)
}

func handleGroupQuestionCreate(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	user, groupID, ok := requireUserAndGroupID(w, r, currentUser)
	if !ok {
		return
	}
	body, err := decodeJSONBodyStrict[struct {
		QuestionID int64 `json:"questionId"`
		SortOrder  *int  `json:"sortOrder"`
	}](r)
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	if body.QuestionID <= 0 {
		api.HandleError(w, r, api.ValidationError([]api.ValidationDetail{{Field: "questionId", Message: "must be positive"}}))
		return
	}
	data, err := services.AddQuestionToGroup(r.Context(), pool, user, groupID, body.QuestionID, body.SortOrder)
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	api.Created(w, r, data, nil)
}

func handleGroupQuestionsReorder(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	user, groupID, ok := requireUserAndGroupID(w, r, currentUser)
	if !ok {
		return
	}
	body, err := decodeJSONBodyStrict[struct {
		Items []struct {
			QuestionID int64 `json:"questionId"`
			SortOrder  int   `json:"sortOrder"`
		} `json:"items"`
	}](r)
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	items := make([]services.ReorderGroupQuestionItem, 0, len(body.Items))
	for index, item := range body.Items {
		if item.QuestionID <= 0 || item.SortOrder <= 0 {
			api.HandleError(w, r, api.ValidationError([]api.ValidationDetail{{Field: "items." + strconv.Itoa(index), Message: "questionId and sortOrder must be positive"}}))
			return
		}
		items = append(items, services.ReorderGroupQuestionItem{QuestionID: item.QuestionID, SortOrder: item.SortOrder})
	}
	if err := services.ReorderGroupQuestions(r.Context(), pool, user, groupID, items); err != nil {
		api.HandleError(w, r, err)
		return
	}
	api.NoContent(w, r)
}

func handleGroupQuestionDelete(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	user, groupID, ok := requireUserAndGroupID(w, r, currentUser)
	if !ok {
		return
	}
	questionID, err := parsePathID(r, "questionId")
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	if err := services.RemoveQuestionFromGroup(r.Context(), pool, user, groupID, questionID); err != nil {
		api.HandleError(w, r, err)
		return
	}
	api.NoContent(w, r)
}

func requireUserAndGroupID(w http.ResponseWriter, r *http.Request, currentUser auth.CurrentUserResolver) (*auth.User, int64, bool) {
	user, err := auth.RequireUser(r, currentUser)
	if err != nil {
		api.HandleError(w, r, err)
		return nil, 0, false
	}
	groupID, err := parsePathID(r, "groupId")
	if err != nil {
		api.HandleError(w, r, err)
		return nil, 0, false
	}
	return user, groupID, true
}
