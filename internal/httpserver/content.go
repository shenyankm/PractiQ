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
		Banks:           http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleBanks(w, r, pool, currentUser) }),
		BankSubtree:     http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleBankSubtree(w, r, pool, currentUser) }),
		QuestionSubtree: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleQuestionSubtree(w, r, pool, currentUser) }),
		GroupSubtree:    http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handleGroupSubtree(w, r, pool, currentUser) }),
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

func handleBankSubtree(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	user, err := auth.RequireUser(r, currentUser)
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	parts := pathParts(r.URL.Path, "/api/v1/banks/")
	if len(parts) == 0 {
		api.HandleError(w, r, api.NewError(http.StatusNotFound, "NOT_FOUND", "Endpoint not found", nil))
		return
	}
	bankID, err := parseID(parts[0], "bankId")
	if err != nil {
		api.HandleError(w, r, err)
		return
	}

	switch {
	case len(parts) == 1 && r.Method == http.MethodGet:
		data, err := services.GetBank(r.Context(), pool, user, bankID)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		api.OK(w, r, data, nil)
	case len(parts) == 1 && r.Method == http.MethodPatch:
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
	case len(parts) == 1 && r.Method == http.MethodDelete:
		if err := services.DeleteBank(r.Context(), pool, user, bankID); err != nil {
			api.HandleError(w, r, err)
			return
		}
		api.NoContent(w, r)
	case len(parts) == 2 && parts[1] == "items" && r.Method == http.MethodGet:
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
	case len(parts) == 3 && parts[1] == "items" && parts[2] == "reorder" && r.Method == http.MethodPatch:
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
	case len(parts) == 2 && parts[1] == "favorite" && r.Method == http.MethodPost:
		if err := services.SetFavorite(r.Context(), pool, user, bankID, true); err != nil {
			api.HandleError(w, r, err)
			return
		}
		api.NoContent(w, r)
	case len(parts) == 2 && parts[1] == "favorite" && r.Method == http.MethodDelete:
		if err := services.SetFavorite(r.Context(), pool, user, bankID, false); err != nil {
			api.HandleError(w, r, err)
			return
		}
		api.NoContent(w, r)
	case len(parts) == 2 && parts[1] == "questions" && r.Method == http.MethodPost:
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
			QuestionTypeID string `json:"questionTypeId"`
			AnswerMode     string `json:"answerMode"`
			Stem           string `json:"stem"`
			Analysis       *string `json:"analysis"`
			ChoiceVariant  *string `json:"choiceVariant"`
			Status         string `json:"status"`
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
	case len(parts) == 2 && parts[1] == "groups" && r.Method == http.MethodPost:
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
	default:
		api.HandleError(w, r, api.NewError(http.StatusNotFound, "NOT_FOUND", "Endpoint not found", nil))
	}
}

func handleQuestionSubtree(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	user, err := auth.RequireUser(r, currentUser)
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	parts := pathParts(r.URL.Path, "/api/v1/questions/")
	if len(parts) == 0 {
		api.HandleError(w, r, api.NewError(http.StatusNotFound, "NOT_FOUND", "Endpoint not found", nil))
		return
	}
	questionID, err := parseID(parts[0], "questionId")
	if err != nil {
		api.HandleError(w, r, err)
		return
	}

	switch {
	case len(parts) == 1 && r.Method == http.MethodGet:
		data, err := services.GetQuestion(r.Context(), pool, user, questionID)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		api.OK(w, r, data, nil)
	case len(parts) == 1 && r.Method == http.MethodPatch:
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
	case len(parts) == 1 && r.Method == http.MethodDelete:
		if err := services.DeleteQuestion(r.Context(), pool, user, questionID); err != nil {
			api.HandleError(w, r, err)
			return
		}
		api.NoContent(w, r)
	case len(parts) == 2 && parts[1] == "publish" && r.Method == http.MethodPost:
		data, err := services.SetQuestionStatus(r.Context(), pool, user, questionID, "active")
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		api.OK(w, r, data, nil)
	case len(parts) == 2 && parts[1] == "archive" && r.Method == http.MethodPost:
		data, err := services.SetQuestionStatus(r.Context(), pool, user, questionID, "archived")
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		api.OK(w, r, data, nil)
	case len(parts) == 2 && parts[1] == "options" && r.Method == http.MethodPost:
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
	case len(parts) == 3 && parts[1] == "options" && r.Method == http.MethodPatch:
		optionID, err := parseID(parts[2], "optionId")
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
	case len(parts) == 2 && parts[1] == "answer-key" && r.Method == http.MethodPut:
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
	case len(parts) == 2 && parts[1] == "metadata" && r.Method == http.MethodPut:
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
	case len(parts) == 2 && parts[1] == "knowledge-points" && r.Method == http.MethodPut:
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
	case len(parts) == 2 && parts[1] == "content-blocks" && r.Method == http.MethodPut:
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
	case len(parts) == 2 && parts[1] == "media-links" && r.Method == http.MethodPost:
		var body struct {
			MediaID   int64  `json:"mediaId"`
			MediaKind string `json:"mediaKind"`
			SortOrder *int   `json:"sortOrder"`
		}
		if err := readJSONBody(r, &body); err != nil {
			api.HandleError(w, r, err)
			return
		}
		if body.MediaID <= 0 || strings.TrimSpace(body.MediaKind) == "" {
			api.HandleError(w, r, api.ValidationError([]api.ValidationDetail{{Field: "mediaId", Message: "mediaId and mediaKind are required"}}))
			return
		}
		data, err := services.LinkQuestionMedia(r.Context(), pool, *user, questionID, services.MediaLinkInput{MediaID: body.MediaID, MediaKind: body.MediaKind, SortOrder: body.SortOrder})
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		api.Created(w, r, data, nil)
	default:
		api.HandleError(w, r, api.NewError(http.StatusNotFound, "NOT_FOUND", "Endpoint not found", nil))
	}
}

func handleGroupSubtree(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) {
	user, err := auth.RequireUser(r, currentUser)
	if err != nil {
		api.HandleError(w, r, err)
		return
	}
	parts := pathParts(r.URL.Path, "/api/v1/groups/")
	if len(parts) == 0 {
		api.HandleError(w, r, api.NewError(http.StatusNotFound, "NOT_FOUND", "Endpoint not found", nil))
		return
	}
	groupID, err := parseID(parts[0], "groupId")
	if err != nil {
		api.HandleError(w, r, err)
		return
	}

	switch {
	case len(parts) == 1 && r.Method == http.MethodGet:
		data, err := services.GetGroup(r.Context(), pool, user, groupID)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		api.OK(w, r, data, nil)
	case len(parts) == 1 && r.Method == http.MethodPatch:
		var body struct {
			Title        *string `json:"title"`
			Instructions *string `json:"instructions"`
			ContentMode  *string `json:"contentMode"`
		}
		if err := readJSONBody(r, &body); err != nil {
			api.HandleError(w, r, err)
			return
		}
		data, err := services.UpdateGroup(r.Context(), pool, user, groupID, services.UpdateGroupInput{Title: body.Title, Instructions: body.Instructions, ContentMode: body.ContentMode})
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		api.OK(w, r, data, nil)
	case len(parts) == 2 && parts[1] == "questions" && r.Method == http.MethodPost:
		var body struct {
			QuestionID int64 `json:"questionId"`
			SortOrder  *int  `json:"sortOrder"`
		}
		if err := readJSONBody(r, &body); err != nil {
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
	case len(parts) == 3 && parts[1] == "questions" && parts[2] == "reorder" && r.Method == http.MethodPatch:
		var body struct {
			Items []struct {
				QuestionID int64 `json:"questionId"`
				SortOrder  int   `json:"sortOrder"`
			} `json:"items"`
		}
		if err := readJSONBody(r, &body); err != nil {
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
	case len(parts) == 3 && parts[1] == "questions" && r.Method == http.MethodDelete:
		questionID, err := parseID(parts[2], "questionId")
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		if err := services.RemoveQuestionFromGroup(r.Context(), pool, user, groupID, questionID); err != nil {
			api.HandleError(w, r, err)
			return
		}
		api.NoContent(w, r)
	case len(parts) == 2 && parts[1] == "media-links" && r.Method == http.MethodPost:
		var body struct {
			MediaID   int64  `json:"mediaId"`
			MediaKind string `json:"mediaKind"`
			SortOrder *int   `json:"sortOrder"`
		}
		if err := readJSONBody(r, &body); err != nil {
			api.HandleError(w, r, err)
			return
		}
		if body.MediaID <= 0 || strings.TrimSpace(body.MediaKind) == "" {
			api.HandleError(w, r, api.ValidationError([]api.ValidationDetail{{Field: "mediaId", Message: "mediaId and mediaKind are required"}}))
			return
		}
		data, err := services.LinkGroupMedia(r.Context(), pool, *user, groupID, services.MediaLinkInput{MediaID: body.MediaID, MediaKind: body.MediaKind, SortOrder: body.SortOrder})
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

func pathParts(path string, prefix string) []string {
	trimmed := strings.Trim(strings.TrimPrefix(path, prefix), "/")
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, "/")
}

func parseID(raw string, label string) (int64, error) {
	id, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || id <= 0 {
		return 0, api.NewError(http.StatusUnprocessableEntity, "VALIDATION_ERROR", "Invalid "+label, nil)
	}
	return id, nil
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
