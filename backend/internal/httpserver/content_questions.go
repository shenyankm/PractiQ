package httpserver

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"practiq/internal/api"
	"practiq/internal/auth"
	"practiq/internal/services"
)

func handleQuestionGet(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	user, questionID, ok := requireUserAndQuestionID(w, r, currentUser)
	if !ok {
		return
	}
	data, err := services.GetQuestion(r.Context(), pool, user, questionID)
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	api.OK(w, r, data, nil)
}

func handleQuestionUpdate(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	user, questionID, ok := requireUserAndQuestionID(w, r, currentUser)
	if !ok {
		return
	}
	body, err := decodeJSONBodyStrict[struct {
		Stem     *string                    `json:"stem"`
		Analysis optionalJSONField[*string] `json:"analysis"`
	}](r)
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	data, err := services.UpdateQuestion(r.Context(), pool, user, questionID, services.UpdateQuestionInput{
		Stem:        body.Stem,
		Analysis:    body.Analysis.Value,
		AnalysisSet: body.Analysis.Set,
	})
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	api.OK(w, r, data, nil)
}

func handleQuestionDelete(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	user, questionID, ok := requireUserAndQuestionID(w, r, currentUser)
	if !ok {
		return
	}
	if err := services.DeleteQuestion(r.Context(), pool, user, questionID); err != nil {
		api.HandleError(w, r, err)
		return
	}
	api.NoContent(w, r)
}

func handleQuestionPublish(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	handleQuestionStatus(w, r, pool, currentUser, "active")
}

func handleQuestionArchive(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	handleQuestionStatus(w, r, pool, currentUser, "archived")
}

func handleQuestionStatus(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver, status string) {
	user, questionID, ok := requireUserAndQuestionID(w, r, currentUser)
	if !ok {
		return
	}
	data, err := services.SetQuestionStatus(r.Context(), pool, user, questionID, status)
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	api.OK(w, r, data, nil)
}

func handleQuestionOptionCreate(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	user, questionID, ok := requireUserAndQuestionID(w, r, currentUser)
	if !ok {
		return
	}
	body, err := decodeJSONBodyStrict[struct {
		Label     string `json:"label"`
		Content   string `json:"content"`
		IsCorrect *bool  `json:"isCorrect"`
		SortOrder *int   `json:"sortOrder"`
	}](r)
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	if strings.TrimSpace(body.Label) == "" || strings.TrimSpace(body.Content) == "" {
		api.HandleError(w, r, api.ValidationError([]api.ValidationDetail{{Field: "label", Message: "label and content are required"}}))
		return
	}
	data, err := services.CreateOption(r.Context(), pool, user, questionID, services.CreateOptionInput{Label: body.Label, Content: body.Content, IsCorrect: body.IsCorrect != nil && *body.IsCorrect, SortOrder: body.SortOrder})
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	api.Created(w, r, data, nil)
}

func handleQuestionOptionUpdate(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	user, questionID, ok := requireUserAndQuestionID(w, r, currentUser)
	if !ok {
		return
	}
	optionID, err := parsePathID(r, "optionId")
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	body, err := decodeJSONBodyStrict[struct {
		Label     *string `json:"label"`
		Content   *string `json:"content"`
		IsCorrect *bool   `json:"isCorrect"`
		SortOrder *int    `json:"sortOrder"`
	}](r)
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	data, err := services.UpdateOption(r.Context(), pool, user, questionID, optionID, services.UpdateOptionInput{Label: body.Label, Content: body.Content, IsCorrect: body.IsCorrect, SortOrder: body.SortOrder})
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	api.OK(w, r, data, nil)
}

func handleQuestionOptionDelete(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	user, questionID, ok := requireUserAndQuestionID(w, r, currentUser)
	if !ok {
		return
	}
	optionID, err := parsePathID(r, "optionId")
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	if err := services.DeleteOption(r.Context(), pool, user, questionID, optionID); err != nil {
		api.HandleError(w, r, err)
		return
	}
	api.NoContent(w, r)
}

func handleQuestionAnswerKeyPut(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	user, questionID, ok := requireUserAndQuestionID(w, r, currentUser)
	if !ok {
		return
	}
	body, err := decodeJSONBodyStrict[struct {
		AnswerMode         string         `json:"answerMode"`
		AnswerPayload      map[string]any `json:"answerPayload"`
		ExplanationPayload map[string]any `json:"explanationPayload"`
		ScorePayload       map[string]any `json:"scorePayload"`
	}](r)
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	if strings.TrimSpace(body.AnswerMode) == "" {
		api.HandleError(w, r, api.ValidationError([]api.ValidationDetail{{Field: "answerMode", Message: "is required"}}))
		return
	}
	data, err := services.UpsertAnswerKey(r.Context(), pool, user, questionID, services.UpsertAnswerKeyInput{
		AnswerMode:         body.AnswerMode,
		AnswerPayload:      body.AnswerPayload,
		ExplanationPayload: body.ExplanationPayload,
		ScorePayload:       body.ScorePayload,
	})
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	api.OK(w, r, data, nil)
}

func handleQuestionContentBlocksPut(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	user, questionID, ok := requireUserAndQuestionID(w, r, currentUser)
	if !ok {
		return
	}
	body, err := decodeJSONBodyStrict[struct {
		Blocks []struct {
			OwnerKind     *string `json:"ownerKind"`
			Role          *string `json:"role"`
			PartType      string  `json:"partType"`
			Sequence      *int    `json:"sequence"`
			ContentMode   *string `json:"contentMode"`
			TextFormat    *string `json:"textFormat"`
			TextValue     *string `json:"textValue"`
			LatexValue    *string `json:"latexValue"`
			MathMLValue   *string `json:"mathmlValue"`
			HTMLValue     *string `json:"htmlValue"`
			MarkdownValue *string `json:"markdownValue"`
			JSONValue     any     `json:"jsonValue"`
			MediaID       *int64  `json:"mediaId"`
		} `json:"blocks"`
	}](r)
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	blocks := make([]services.QuestionContentBlockInput, 0, len(body.Blocks))
	for index, block := range body.Blocks {
		if strings.TrimSpace(block.PartType) == "" {
			api.HandleError(w, r, api.ValidationError([]api.ValidationDetail{{Field: "blocks." + strconv.Itoa(index) + ".partType", Message: "is required"}}))
			return
		}
		blocks = append(blocks, services.QuestionContentBlockInput{
			OwnerKind:     block.OwnerKind,
			Role:          block.Role,
			PartType:      block.PartType,
			Sequence:      block.Sequence,
			ContentMode:   block.ContentMode,
			TextFormat:    block.TextFormat,
			TextValue:     block.TextValue,
			LatexValue:    block.LatexValue,
			MathMLValue:   block.MathMLValue,
			HTMLValue:     block.HTMLValue,
			MarkdownValue: block.MarkdownValue,
			JSONValue:     block.JSONValue,
			MediaID:       block.MediaID,
		})
	}
	if err := services.ReplaceQuestionContentBlocks(r.Context(), pool, user, questionID, blocks); err != nil {
		api.HandleError(w, r, err)
		return
	}
	api.NoContent(w, r)
}

func requireUserAndQuestionID(w http.ResponseWriter, r *http.Request, currentUser auth.CurrentUserResolver) (*auth.User, int64, bool) {
	user, err := auth.RequireUser(r, currentUser)
	if err != nil {
		api.HandleError(w, r, err)
		return nil, 0, false
	}
	questionID, err := parsePathID(r, "questionId")
	if err != nil {
		api.HandleError(w, r, err)
		return nil, 0, false
	}
	return user, questionID, true
}
