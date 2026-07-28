package httpserver

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"practiq/internal/aiclient"
	"practiq/internal/api"
	"practiq/internal/auth"
	"practiq/internal/services"
)

const (
	maxImportUploadBytes           = 25 * 1024 * 1024
	maxImportMultipartRequestBytes = maxImportUploadBytes + 1024*1024
	maxImportArtifactJSONBytes     = maxImportUploadBytes*4/3 + 1024*1024
)

type importJobRequest struct {
	BankID         *int64         `json:"bankId"`
	FileName       *string        `json:"fileName"`
	SourceType     *string        `json:"sourceType"`
	RequestPayload map[string]any `json:"requestPayload"`
}

type importJobFileRequest struct {
	ArtifactType *string        `json:"artifactType"`
	StoragePath  *string        `json:"storagePath"`
	Content      map[string]any `json:"content"`
	SourceType   *string        `json:"sourceType"`
}

type importJobParseRequest struct {
	PersistQuestions *bool `json:"persistQuestions"`
}

type aiAnswerRequest struct {
	QuestionID *int                    `json:"questionId"`
	Stem       string                  `json:"stem"`
	AnswerMode string                  `json:"answerMode"`
	Options    []aiclient.ParsedOption `json:"options"`
	Analysis   *string                 `json:"analysis"`
}

type aiQuestionGenerateRequest struct {
	Apply *bool `json:"apply"`
}

func BuildImportHandlers(pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) ImportHandlers {
	return ImportHandlers{
		ImportJobs:        buildImportJobsHandler(pool, currentUser),
		ImportJob:         buildImportJobHandler(pool, currentUser),
		ImportJobFile:     buildImportJobFileHandler(pool, currentUser),
		ImportJobAction:   buildImportJobActionHandler(pool, currentUser),
		ImportJobChildren: buildImportJobChildrenHandler(pool, currentUser),
	}
}

func BuildAIHandlers(pool *pgxpool.Pool, currentUser auth.CurrentUserResolver, client *aiclient.Client) AIHandlers {
	return AIHandlers{
		AIParseDocument:        buildAIParseDocumentHandler(pool, currentUser, client),
		AIGenerateAnswer:       buildAIGenerateAnswerHandler(pool, currentUser, client),
		AILearningReport:       buildAILearningReportHandler(pool, currentUser, client),
		QuestionGenerateAnswer: buildQuestionGenerateAnswerHandler(pool, currentUser, client),
	}
}

func buildImportJobsHandler(pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUserHandler(w, r, currentUser)
		if !ok {
			return
		}

		switch r.Method {
		case http.MethodGet:
			limit, err := queryPageLimit(r, 100)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			jobs, err := services.ListImportJobs(
				r.Context(),
				pool,
				user,
				strings.TrimSpace(r.URL.Query().Get("status")),
				r.URL.Query().Get("cursor"),
				limit,
			)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.OK(w, r, jobs.Items, paginationMeta(jobs.PageInfo))
		case http.MethodPost:
			payload, err := decodeJSONBodyStrict[importJobRequest](r)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			job, err := services.CreateImportJob(r.Context(), pool, user, services.CreateImportJobInput{
				BankID:         payload.BankID,
				FileName:       trimStringPointer(payload.FileName),
				SourceType:     valueOrDefault(payload.SourceType, ""),
				RequestPayload: payload.RequestPayload,
			})
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.Created(w, r, job, nil)
		default:
			methodNotAllowed(w, r)
		}
	})
}

func buildImportJobHandler(pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUserHandler(w, r, currentUser)
		if !ok {
			return
		}
		jobID, err := parsePathID(r, "jobId")
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		job, err := services.GetImportJob(r.Context(), pool, user, jobID)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		api.OK(w, r, job, nil)
	})
}

func buildImportJobFileHandler(pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUserHandler(w, r, currentUser)
		if !ok {
			return
		}
		jobID, err := parsePathID(r, "jobId")
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		if isMultipartFormRequest(r) {
			artifact, err := parseAndStoreImportUpload(w, r, pool, user, jobID)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.Created(w, r, artifact, nil)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxImportArtifactJSONBytes)
		payload, err := decodeJSONBodyStrictLimit[importJobFileRequest](r, maxImportArtifactJSONBytes)
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				api.HandleError(w, r, api.NewError(http.StatusRequestEntityTooLarge, "FILE_TOO_LARGE", "Import artifact exceeds the 25 MiB file limit", nil))
				return
			}
			api.HandleError(w, r, err)
			return
		}
		artifact, err := services.AddImportJobFile(r.Context(), pool, user, jobID, services.AddImportJobFileInput{
			ArtifactType: valueOrDefault(payload.ArtifactType, "source_file"),
			StoragePath:  trimStringPointer(payload.StoragePath),
			Content:      payload.Content,
			SourceType:   valueOrDefault(payload.SourceType, ""),
		})
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		api.Created(w, r, artifact, nil)
	})
}

func buildImportJobActionHandler(pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUserHandler(w, r, currentUser)
		if !ok {
			return
		}
		jobID, err := parsePathID(r, "jobId")
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		switch r.PathValue("action") {
		case "retry", "cancel":
			job, err := services.UpdateImportJobStatus(r.Context(), pool, user, jobID, r.PathValue("action"))
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.OK(w, r, job, nil)
		case "parse":
			payload, err := decodeJSONBodyStrict[importJobParseRequest](r, true)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			job, err := services.QueueImportJobForUser(r.Context(), pool, user, jobID, services.QueueImportJobOptions{PersistQuestions: payload.PersistQuestions})
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.OK(w, r, job, nil)
		default:
			api.HandleError(w, r, api.NewError(http.StatusNotFound, "NOT_FOUND", "Endpoint not found", nil))
		}
	})
}

func buildImportJobChildrenHandler(pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUserHandler(w, r, currentUser)
		if !ok {
			return
		}
		jobID, err := parsePathID(r, "jobId")
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		kind := services.ImportJobChildKind(r.PathValue("kind"))
		switch kind {
		case services.ImportJobChildrenEvents, services.ImportJobChildrenArtifacts, services.ImportJobChildrenOutputs:
		default:
			api.HandleError(w, r, api.ValidationError([]api.ValidationDetail{{Field: "kind", Message: "unsupported import child kind"}}))
			return
		}
		items, err := services.ListImportJobChildren(r.Context(), pool, user, jobID, kind)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		api.OK(w, r, items, nil)
	})
}
func buildAIParseDocumentHandler(pool *pgxpool.Pool, currentUser auth.CurrentUserResolver, client *aiclient.Client) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUserHandler(w, r, currentUser)
		if !ok {
			return
		}
		if err := services.RequirePlusEntitlement(r.Context(), pool, user, "AI document parsing"); err != nil {
			api.HandleError(w, r, err)
			return
		}
		payload, err := decodeJSONBodyStrictLimit[aiclient.DocumentParseRequest](r, maxImportArtifactJSONBytes)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		if err := validateAIDocumentParseRequest(payload); err != nil {
			api.HandleError(w, r, err)
			return
		}
		result, err := client.ParseDocument(r.Context(), payload)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		api.OK(w, r, result, nil)
	})
}

func buildAIGenerateAnswerHandler(pool *pgxpool.Pool, currentUser auth.CurrentUserResolver, client *aiclient.Client) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUserHandler(w, r, currentUser)
		if !ok {
			return
		}
		if err := services.RequirePlusEntitlement(r.Context(), pool, user, "AI answer generation"); err != nil {
			api.HandleError(w, r, err)
			return
		}
		body, err := decodeJSONBodyStrict[aiAnswerRequest](r)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		payload, err := validateAIAnswerRequest(body)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		result, err := client.GenerateAnswer(r.Context(), payload)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		api.OK(w, r, result, nil)
	})
}

func buildAILearningReportHandler(pool *pgxpool.Pool, currentUser auth.CurrentUserResolver, client *aiclient.Client) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUserHandler(w, r, currentUser)
		if !ok {
			return
		}
		if err := services.RequirePlusEntitlement(r.Context(), pool, user, "AI learning reports"); err != nil {
			api.HandleError(w, r, err)
			return
		}
		body, err := decodeJSONBodyStrict[aiclient.LearningReportRequest](r)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		payload, err := validateAILearningReportRequest(body)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		if payload.UserID != nil && *payload.UserID != user.ID && user.Role != "admin" {
			api.HandleError(w, r, api.NewError(http.StatusForbidden, "FORBIDDEN", "Administrator privileges required to generate reports for other users", nil))
			return
		}
		result, err := client.LearningReport(r.Context(), payload)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		api.OK(w, r, result, nil)
	})
}

func buildQuestionGenerateAnswerHandler(pool *pgxpool.Pool, currentUser auth.CurrentUserResolver, client *aiclient.Client) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUserHandler(w, r, currentUser)
		if !ok {
			return
		}
		if err := services.RequirePlusEntitlement(r.Context(), pool, user, "AI answer generation"); err != nil {
			api.HandleError(w, r, err)
			return
		}
		questionID, err := parsePathID(r, "questionId")
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		payload, err := decodeJSONBodyStrict[aiQuestionGenerateRequest](r)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		detail, err := services.GetQuestionForEditor(r.Context(), pool, &user, questionID)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		request := aiclient.AnswerGenerationRequest{
			Stem:       detail.Stem,
			AnswerMode: detail.AnswerMode,
			Analysis:   valueOrDefault(detail.Analysis, ""),
			Options:    make([]aiclient.ParsedOption, 0, len(detail.Options)),
		}
		questionIDInt := int(questionID)
		request.QuestionID = &questionIDInt
		for _, option := range detail.Options {
			request.Options = append(request.Options, aiclient.ParsedOption{Label: option.OptionLabel, Content: option.Content})
		}
		result, err := client.GenerateAnswer(r.Context(), request)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		apply := payload.Apply == nil || *payload.Apply
		if apply {
			if result.Confidence < aiApplyMinConfidence() {
				api.HandleError(w, r, api.NewError(http.StatusConflict, "INVALID_STATE", "AI generated answer confidence is too low to apply automatically", nil))
				return
			}
			if len(result.AnswerPayload) == 0 {
				api.HandleError(w, r, api.NewError(http.StatusConflict, "INVALID_STATE", "AI generated answer is incomplete and cannot be applied", nil))
				return
			}
			_, err = services.UpsertAnswerKey(r.Context(), pool, &user, questionID, services.UpsertAnswerKeyInput{
				AnswerMode:    detail.AnswerMode,
				AnswerPayload: result.AnswerPayload,
				ExplanationPayload: map[string]any{
					"canonicalAnswer":  result.CanonicalAnswer,
					"explanation":      result.Explanation,
					"steps":            result.Steps,
					"confidence":       result.Confidence,
					"educationalValue": result.EducationalValue,
				},
				ScorePayload: map[string]any{"maxScore": 1, "generatedBy": "ai"},
			})
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
		}
		api.OK(w, r, result, nil)
	})
}

func requireUserHandler(w http.ResponseWriter, r *http.Request, currentUser auth.CurrentUserResolver) (auth.User, bool) {
	user, err := auth.RequireUser(r, currentUser)
	if err != nil {
		api.HandleError(w, r, err)
		return auth.User{}, false
	}
	return *user, true
}

func parseAndStoreImportUpload(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, user auth.User, jobID int64) (map[string]any, error) {
	r.Body = http.MaxBytesReader(w, r.Body, maxImportMultipartRequestBytes)
	file, header, err := r.FormFile("file")
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "request body too large") {
			return nil, api.NewError(http.StatusRequestEntityTooLarge, "FILE_TOO_LARGE", "Upload file exceeds 25 MiB limit", nil)
		}
		return nil, api.NewError(http.StatusBadRequest, "FILE_REQUIRED", "Upload file is required", nil)
	}
	defer file.Close()
	payload, err := io.ReadAll(file)
	if err != nil {
		return nil, err
	}
	return services.AddImportJobUploadedFile(r.Context(), pool, user, jobID, services.UploadedImportFile{
		Name:        header.Filename,
		ContentType: header.Header.Get("Content-Type"),
		Content:     payload,
	})
}

func isMultipartFormRequest(r *http.Request) bool {
	return strings.Contains(strings.ToLower(r.Header.Get("Content-Type")), "multipart/form-data")
}

func methodNotAllowed(w http.ResponseWriter, r *http.Request) {
	api.HandleError(w, r, api.NewError(http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Method not allowed", nil))
}

func validateAIDocumentParseRequest(payload aiclient.DocumentParseRequest) error {
	var details []api.ValidationDetail
	switch payload.SourceType {
	case "docx", "txt", "text", "pdf", "xlsx":
	default:
		details = append(details, api.ValidationDetail{Field: "sourceType", Message: "must be one of docx, txt, text, pdf, xlsx"})
	}
	if payload.Text == "" && payload.FileBase64 == "" {
		details = append(details, api.ValidationDetail{Field: "text", Message: "text or fileBase64 is required"})
	}
	if len(details) > 0 {
		return api.ValidationError(details)
	}
	return nil
}

func validateAIAnswerRequest(payload aiAnswerRequest) (aiclient.AnswerGenerationRequest, error) {
	var details []api.ValidationDetail
	if strings.TrimSpace(payload.Stem) == "" {
		details = append(details, api.ValidationDetail{Field: "stem", Message: "is required"})
	}
	if !validAnswerMode(payload.AnswerMode) {
		details = append(details, api.ValidationDetail{Field: "answerMode", Message: "must be one of choice, true_false, fill_blank, short_answer"})
	}
	if payload.QuestionID != nil && *payload.QuestionID <= 0 {
		details = append(details, api.ValidationDetail{Field: "questionId", Message: "must be a positive integer"})
	}
	if len(details) > 0 {
		return aiclient.AnswerGenerationRequest{}, api.ValidationError(details)
	}
	return aiclient.AnswerGenerationRequest{
		QuestionID: payload.QuestionID,
		Stem:       payload.Stem,
		AnswerMode: payload.AnswerMode,
		Options:    payload.Options,
		Analysis:   valueOrDefault(payload.Analysis, ""),
	}, nil
}

func validateAILearningReportRequest(payload aiclient.LearningReportRequest) (aiclient.LearningReportRequest, error) {
	if payload.Scope == "" {
		payload.Scope = "individual"
	}
	var details []api.ValidationDetail
	if !validReportScope(payload.Scope) {
		details = append(details, api.ValidationDetail{Field: "scope", Message: "must be one of individual, class, bank"})
	}
	if payload.UserID != nil && *payload.UserID <= 0 {
		details = append(details, api.ValidationDetail{Field: "userId", Message: "must be a positive integer"})
	}
	if payload.BankID != nil && *payload.BankID <= 0 {
		details = append(details, api.ValidationDetail{Field: "bankId", Message: "must be a positive integer"})
	}
	if payload.PracticeSessionID != nil && *payload.PracticeSessionID <= 0 {
		details = append(details, api.ValidationDetail{Field: "practiceSessionId", Message: "must be a positive integer"})
	}
	if payload.Stats != nil {
		if encoded, err := json.Marshal(payload.Stats); err != nil || len(encoded) > 100_000 {
			details = append(details, api.ValidationDetail{Field: "stats", Message: "must be a JSON object of at most 100,000 bytes"})
		}
	}
	if len(details) > 0 {
		return aiclient.LearningReportRequest{}, api.ValidationError(details)
	}
	return payload, nil
}

func validAnswerMode(value string) bool {
	switch value {
	case "choice", "true_false", "fill_blank", "short_answer":
		return true
	default:
		return false
	}
}

func validReportScope(value string) bool {
	switch value {
	case "individual", "class", "bank":
		return true
	default:
		return false
	}
}

func valueOrDefault(value *string, fallback string) string {
	if value == nil {
		return fallback
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return fallback
	}
	return trimmed
}

func trimStringPointer(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func aiApplyMinConfidence() float64 {
	threshold, err := strconv.ParseFloat(strings.TrimSpace(os.Getenv("AI_APPLY_MIN_CONFIDENCE")), 64)
	if err != nil || threshold <= 0 {
		return 0.7
	}
	return threshold
}

func stringValue(values map[string]any, key string) string {
	if values == nil {
		return ""
	}
	if raw, ok := values[key]; ok {
		switch typed := raw.(type) {
		case string:
			return typed
		case fmt.Stringer:
			return typed.String()
		}
	}
	return ""
}
