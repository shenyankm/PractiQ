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
	raw, err := readRawBody(r)
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	if err := api.ValidateQuestionUpdatePayload(raw); err != nil {
		api.HandleError(w, r, err)
		return
	}
	var body struct {
		Stem     *string `json:"stem"`
		Analysis *string `json:"analysis"`
		Status   *string `json:"status"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		api.HandleError(w, r, api.NewError(http.StatusBadRequest, "INVALID_JSON", "Request body must be valid JSON", nil))
		return
	}
	data, err := services.UpdateQuestion(r.Context(), pool, user, questionID, services.UpdateQuestionInput{Stem: body.Stem, Analysis: body.Analysis, Status: body.Status})
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
	var body struct {
		Label     string `json:"label"`
		Content   string `json:"content"`
		IsCorrect *bool  `json:"isCorrect"`
		SortOrder *int   `json:"sortOrder"`
	}
	if err := readJSONBody(r, &body); err != nil {
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
	var body struct {
		Label     *string `json:"label"`
		Content   *string `json:"content"`
		IsCorrect *bool   `json:"isCorrect"`
		SortOrder *int    `json:"sortOrder"`
	}
	if err := readJSONBody(r, &body); err != nil {
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

func handleQuestionAnswerKeyPut(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	user, questionID, ok := requireUserAndQuestionID(w, r, currentUser)
	if !ok {
		return
	}
	var body struct {
		AnswerMode         string         `json:"answerMode"`
		AnswerPayload      map[string]any `json:"answerPayload"`
		ExplanationPayload map[string]any `json:"explanationPayload"`
		ScorePayload       map[string]any `json:"scorePayload"`
	}
	if err := readJSONBody(r, &body); err != nil {
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

func handleQuestionMetadataPut(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	user, questionID, ok := requireUserAndQuestionID(w, r, currentUser)
	if !ok {
		return
	}
	var body struct {
		DifficultyLevel    *string        `json:"difficultyLevel"`
		DifficultyScore    *float64       `json:"difficultyScore"`
		GradeLevel         *string        `json:"gradeLevel"`
		ExamType           *string        `json:"examType"`
		CurriculumStandard *string        `json:"curriculumStandard"`
		TextbookVersion    *string        `json:"textbookVersion"`
		KnowledgeTags      []string       `json:"knowledgeTags"`
		SkillTags          []string       `json:"skillTags"`
		Metadata           map[string]any `json:"metadata"`
	}
	if err := readJSONBody(r, &body); err != nil {
		api.HandleError(w, r, err)
		return
	}
	data, err := services.UpsertQuestionMetadata(r.Context(), pool, user, questionID, services.UpsertQuestionMetadataInput{
		DifficultyLevel:    body.DifficultyLevel,
		DifficultyScore:    body.DifficultyScore,
		GradeLevel:         body.GradeLevel,
		ExamType:           body.ExamType,
		CurriculumStandard: body.CurriculumStandard,
		TextbookVersion:    body.TextbookVersion,
		KnowledgeTags:      body.KnowledgeTags,
		SkillTags:          body.SkillTags,
		Metadata:           body.Metadata,
	})
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	api.OK(w, r, data, nil)
}

func handleQuestionKnowledgePut(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	user, questionID, ok := requireUserAndQuestionID(w, r, currentUser)
	if !ok {
		return
	}
	var body struct {
		KnowledgePointIDs []int64 `json:"knowledgePointIds"`
	}
	if err := readJSONBody(r, &body); err != nil {
		api.HandleError(w, r, err)
		return
	}
	for index, id := range body.KnowledgePointIDs {
		if id <= 0 {
			api.HandleError(w, r, api.ValidationError([]api.ValidationDetail{{Field: "knowledgePointIds." + strconv.Itoa(index), Message: "must be positive"}}))
			return
		}
	}
	if err := services.ReplaceQuestionKnowledgePoints(r.Context(), pool, user, questionID, body.KnowledgePointIDs); err != nil {
		api.HandleError(w, r, err)
		return
	}
	api.NoContent(w, r)
}

func handleQuestionContentBlocksPut(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	user, questionID, ok := requireUserAndQuestionID(w, r, currentUser)
	if !ok {
		return
	}
	var body struct {
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
	}
	if err := readJSONBody(r, &body); err != nil {
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
