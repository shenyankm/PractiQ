package httpserver

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	paddle "github.com/PaddleHQ/paddle-go-sdk/v5"
	paddleerr "github.com/PaddleHQ/paddle-go-sdk/v5/pkg/paddleerr"
	"github.com/jackc/pgx/v5/pgxpool"

	"openwook/internal/aiclient"
	"openwook/internal/api"
	"openwook/internal/auth"
	"openwook/internal/billing"
	importqueue "openwook/internal/imports"
	"openwook/internal/redisx"
	"openwook/internal/services"
)

const maxImportUploadBytes = 25 * 1024 * 1024

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

type importReviewResolveRequest struct {
	Note *string `json:"note"`
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

type billingCheckoutRequest struct {
	PlanKey string `json:"planKey"`
}

type paddleEnvelope struct {
	EventType string         `json:"event_type"`
	Data      map[string]any `json:"data"`
}

func BuildImportsBillingAIHandlers(pool *pgxpool.Pool, currentUser auth.CurrentUserResolver, client *aiclient.Client) ImportsBillingAIHandlers {
	return ImportsBillingAIHandlers{
		ImportJobs:             buildImportJobsHandler(pool, currentUser),
		ImportJob:              buildImportJobHandler(pool, currentUser),
		ImportJobFile:          buildImportJobFileHandler(pool, currentUser),
		ImportJobAction:        buildImportJobActionHandler(pool, currentUser),
		ImportJobChildren:      buildImportJobChildrenHandler(pool, currentUser),
		ImportJobEventStream:   buildImportJobEventStreamHandler(pool, currentUser),
		ImportJobReviewResolve: buildImportJobReviewResolveHandler(pool, currentUser),
		AIParseDocument:        buildAIParseDocumentHandler(pool, currentUser, client),
		AIGenerateAnswer:       buildAIGenerateAnswerHandler(pool, currentUser, client),
		AILearningReport:       buildAILearningReportHandler(pool, currentUser, client),
		QuestionGenerateAnswer: buildQuestionGenerateAnswerHandler(pool, currentUser, client),
		BillingSummary:         buildBillingSummaryHandler(pool, currentUser),
		BillingCheckout:        buildBillingCheckoutHandler(pool, currentUser),
		BillingWebhook:         buildBillingWebhookHandler(pool),
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
			jobs, err := services.ListImportJobs(r.Context(), pool, user, strings.TrimSpace(r.URL.Query().Get("status")))
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.OK(w, r, jobs, nil)
		case http.MethodPost:
			body, err := readRequestBody(r)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			if err := api.ValidateImportJobPayload(body); err != nil {
				api.HandleError(w, r, err)
				return
			}
			var payload importJobRequest
			if err := json.Unmarshal(body, &payload); err != nil {
				api.HandleError(w, r, invalidJSON())
				return
			}
			if err := validateOptionalPositiveInt64(payload.BankID, "bankId"); err != nil {
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
		jobID, err := parsePathInt64(r, "jobId")
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
		jobID, err := parsePathInt64(r, "jobId")
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
		body, err := readRequestBody(r)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		var payload importJobFileRequest
		if err := json.Unmarshal(body, &payload); err != nil {
			api.HandleError(w, r, invalidJSON())
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
		jobID, err := parsePathInt64(r, "jobId")
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		switch r.PathValue("action") {
		case "start", "retry", "cancel":
			job, err := services.UpdateImportJobStatus(r.Context(), pool, user, jobID, r.PathValue("action"))
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.OK(w, r, job, nil)
		case "parse":
			body, err := readRequestBody(r)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			var payload importJobParseRequest
			if len(body) > 0 {
				if err := json.Unmarshal(body, &payload); err != nil {
					api.HandleError(w, r, invalidJSON())
					return
				}
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
		jobID, err := parsePathInt64(r, "jobId")
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		kind := r.PathValue("kind")
		if err := api.ValidateImportChildKind(kind); err != nil {
			api.HandleError(w, r, err)
			return
		}
		items, err := services.ListImportJobChildren(r.Context(), pool, user, jobID, services.ImportJobChildKind(kind))
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		api.OK(w, r, items, nil)
	})
}
func buildImportJobEventStreamHandler(pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUserHandler(w, r, currentUser)
		if !ok {
			return
		}
		jobID, err := parsePathInt64(r, "jobId")
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		items, err := services.ListImportJobChildren(r.Context(), pool, user, jobID, services.ImportJobChildrenEvents)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		flusher, ok := w.(http.Flusher)
		if !ok {
			api.HandleError(w, r, api.NewError(http.StatusInternalServerError, "STREAM_UNSUPPORTED", "Streaming is not supported", nil))
			return
		}
		importqueue.WriteEventStreamHeaders(w.Header())
		w.WriteHeader(http.StatusOK)
		for _, item := range items {
			if _, err := io.WriteString(w, importqueue.EncodeImportEvent(importEventFromMap(item))); err != nil {
				return
			}
		}
		flusher.Flush()
		rdb := redisx.Client()
		if rdb == nil {
			<-r.Context().Done()
			return
		}
		pubsub := rdb.Subscribe(r.Context(), redisx.ImportEventChannel(jobID))
		defer pubsub.Close()
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		channel := pubsub.Channel()
		for {
			select {
			case <-r.Context().Done():
				return
			case <-ticker.C:
				if _, err := io.WriteString(w, ": keepalive\n\n"); err != nil {
					return
				}
				flusher.Flush()
			case msg, ok := <-channel:
				if !ok {
					return
				}
				var payload importqueue.ImportEvent
				if err := json.Unmarshal([]byte(msg.Payload), &payload); err != nil {
					continue
				}
				if _, err := io.WriteString(w, importqueue.EncodeImportEvent(payload)); err != nil {
					return
				}
				flusher.Flush()
			}
		}
	})
}

func importEventFromMap(item map[string]any) importqueue.ImportEvent {
	event := importqueue.ImportEvent{
		ID:        int64Value(item, "id"),
		JobID:     int(int64Value(item, "job_id")),
		Stage:     stringValue(item, "stage"),
		StepCode:  stringValue(item, "step_code"),
		StepLabel: stringValue(item, "step_label"),
		Status:    stringValue(item, "status"),
		Message:   stringValue(item, "message"),
	}
	if value, ok := item["overall_progress_percent"].(float64); ok {
		progress := int(value)
		event.OverallProgressPercent = &progress
	}
	if value, ok := item["step_progress_percent"].(float64); ok {
		progress := int(value)
		event.StepProgressPercent = &progress
	}
	return event
}

func buildImportJobReviewResolveHandler(pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUserHandler(w, r, currentUser)
		if !ok {
			return
		}
		jobID, err := parsePathInt64(r, "jobId")
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		itemID, err := parsePathInt64(r, "itemId")
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		body, err := readRequestBody(r)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		var payload importReviewResolveRequest
		if err := json.Unmarshal(body, &payload); err != nil {
			api.HandleError(w, r, invalidJSON())
			return
		}
		item, err := services.ResolveImportReviewItem(r.Context(), pool, user, jobID, itemID, trimStringPointer(payload.Note))
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		api.OK(w, r, item, nil)
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
		body, err := readRequestBody(r)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		if err := api.ValidateAIDocumentParsePayload(body); err != nil {
			api.HandleError(w, r, err)
			return
		}
		var payload aiclient.DocumentParseRequest
		if err := json.Unmarshal(body, &payload); err != nil {
			api.HandleError(w, r, invalidJSON())
			return
		}
		if payload.SourceType == "" {
			payload.SourceType = "txt"
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
		body, err := readRequestBody(r)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		payload, err := decodeAIAnswerRequest(body)
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
		body, err := readRequestBody(r)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		payload, err := decodeAILearningReportRequest(body)
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
		questionID, err := parsePathInt64(r, "questionId")
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		body, err := readRequestBody(r)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		var payload aiQuestionGenerateRequest
		if err := json.Unmarshal(body, &payload); err != nil {
			api.HandleError(w, r, invalidJSON())
			return
		}
		detail, err := services.GetQuestion(r.Context(), pool, &user, questionID)
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

func buildBillingSummaryHandler(pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUserHandler(w, r, currentUser)
		if !ok {
			return
		}
		cfg, err := billing.LoadConfig()
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		row, err := loadBillingSubscriptionRow(r.Context(), pool, user.ID)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		subscription := billing.NormalizeSubscription(user.Membership, row)
		api.OK(w, r, map[string]any{
			"billing": map[string]any{
				"configured":   cfg.Configured,
				"environment":  cfg.Environment,
				"plans":        billingPlansResponse(cfg.Plans),
				"subscription": billingSubscriptionResponse(subscription),
			},
		}, nil)
	})
}

func buildBillingCheckoutHandler(pool *pgxpool.Pool, currentUser auth.CurrentUserResolver) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUserHandler(w, r, currentUser)
		if !ok {
			return
		}
		cfg, err := billing.LoadConfig()
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		if !cfg.Configured {
			api.HandleError(w, r, api.NewError(http.StatusServiceUnavailable, "BILLING_NOT_CONFIGURED", "Paddle billing is not configured", nil))
			return
		}
		body, err := readRequestBody(r)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		var payload billingCheckoutRequest
		if err := json.Unmarshal(body, &payload); err != nil {
			api.HandleError(w, r, invalidJSON())
			return
		}
		plan, ok := billingPlanByKey(cfg.Plans, payload.PlanKey)
		if !ok || strings.TrimSpace(plan.PriceID) == "" {
			api.HandleError(w, r, api.NewError(http.StatusUnprocessableEntity, "INVALID_PLAN", "Unknown paid plan", nil))
			return
		}
		transactionID, customerID, rawPayload, err := createPaddleTransaction(r.Context(), plan, user)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		if err := upsertCheckoutBillingState(r.Context(), pool, user.ID, plan, transactionID, customerID, rawPayload); err != nil {
			api.HandleError(w, r, err)
			return
		}
		api.Created(w, r, map[string]any{
			"checkout": map[string]any{
				"transactionId": transactionID,
				"clientToken":   strings.TrimSpace(os.Getenv("PADDLE_CLIENT_TOKEN")),
				"environment":   cfg.Environment,
			},
		}, nil)
	})
}

func buildBillingWebhookHandler(pool *pgxpool.Pool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rawBody, err := readRequestBody(r)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		signature := strings.TrimSpace(r.Header.Get("Paddle-Signature"))
		if signature == "" {
			api.HandleError(w, r, api.NewError(http.StatusBadRequest, "PADDLE_SIGNATURE_MISSING", "Missing paddle-signature header", nil))
			return
		}
		secret := strings.TrimSpace(os.Getenv("PADDLE_WEBHOOK_SECRET"))
		if secret == "" {
			api.HandleError(w, r, api.NewError(http.StatusInternalServerError, "BILLING_NOT_CONFIGURED", "Paddle webhook secret is not configured", nil))
			return
		}
		if err := verifyPaddleWebhookSignature(rawBody, signature, secret); err != nil {
			api.HandleError(w, r, err)
			return
		}
		eventType, data, err := decodePaddleWebhook(rawBody)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		fallbackUserID, err := lookupBillingFallbackUserID(r.Context(), pool, data)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		switch {
		case strings.HasPrefix(eventType, "subscription."):
			payload, err := billing.SubscriptionPayloadFromEvent(data, fallbackUserID)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			if payload != nil {
				if err := upsertSubscriptionBillingState(r.Context(), pool, *payload, data); err != nil {
					api.HandleError(w, r, err)
					return
				}
			}
		case strings.HasPrefix(eventType, "transaction."):
			payload, err := billing.TransactionPayloadFromEvent(data, fallbackUserID)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			if payload != nil {
				if err := upsertTransactionBillingState(r.Context(), pool, *payload, data); err != nil {
					api.HandleError(w, r, err)
					return
				}
			}
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok"))
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
	r.Body = http.MaxBytesReader(w, r.Body, maxImportUploadBytes)
	file, header, err := r.FormFile("file")
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "request body too large") {
			return nil, api.NewError(http.StatusBadRequest, "FILE_TOO_LARGE", "Upload file exceeds 25 MiB limit", nil)
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

func readRequestBody(r *http.Request) ([]byte, error) {
	defer r.Body.Close()
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	return body, nil
}

func invalidJSON() error {
	return api.NewError(http.StatusBadRequest, "INVALID_JSON", "Request body must be valid JSON", nil)
}

func methodNotAllowed(w http.ResponseWriter, r *http.Request) {
	api.HandleError(w, r, api.NewError(http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Method not allowed", nil))
}

func parsePathInt64(r *http.Request, name string) (int64, error) {
	value := strings.TrimSpace(r.PathValue(name))
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed <= 0 {
		return 0, api.NewError(http.StatusUnprocessableEntity, "VALIDATION_ERROR", "Invalid "+name, nil)
	}
	return parsed, nil
}

func validateOptionalPositiveInt64(value *int64, field string) error {
	if value == nil {
		return nil
	}
	if *value <= 0 {
		return api.ValidationError([]api.ValidationDetail{{Field: field, Message: "must be a positive integer"}})
	}
	return nil
}

func decodeAIAnswerRequest(body []byte) (aiclient.AnswerGenerationRequest, error) {
	var payload aiAnswerRequest
	if err := json.Unmarshal(body, &payload); err != nil {
		return aiclient.AnswerGenerationRequest{}, invalidJSON()
	}
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

func decodeAILearningReportRequest(body []byte) (aiclient.LearningReportRequest, error) {
	var payload aiclient.LearningReportRequest
	if err := json.Unmarshal(body, &payload); err != nil {
		return aiclient.LearningReportRequest{}, invalidJSON()
	}
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

func billingPlansResponse(plans []billing.Plan) []map[string]any {
	out := make([]map[string]any, 0, len(plans))
	for _, plan := range plans {
		var trialDays any
		if plan.TrialDays != nil {
			trialDays = *plan.TrialDays
		}
		out = append(out, map[string]any{
			"planKey":      plan.PlanKey,
			"label":        plan.Label,
			"priceId":      plan.PriceID,
			"amountCents":  plan.AmountCents,
			"currencyCode": plan.CurrencyCode,
			"interval":     plan.Interval,
			"trialDays":    trialDays,
		})
	}
	return out
}

func billingSubscriptionResponse(subscription billing.Subscription) map[string]any {
	var currentPeriodEndsAt any
	if subscription.CurrentPeriodEndsAt != nil {
		currentPeriodEndsAt = *subscription.CurrentPeriodEndsAt
	}
	var paddleSubscriptionID any
	if subscription.PaddleSubscriptionID != nil {
		paddleSubscriptionID = *subscription.PaddleSubscriptionID
	}
	var paddleTransactionID any
	if subscription.PaddleTransactionID != nil {
		paddleTransactionID = *subscription.PaddleTransactionID
	}
	var paddlePriceID any
	if subscription.PaddlePriceID != nil {
		paddlePriceID = *subscription.PaddlePriceID
	}
	return map[string]any{
		"membership":           subscription.Membership,
		"status":               subscription.Status,
		"source":               subscription.Source,
		"currentPeriodEndsAt":  currentPeriodEndsAt,
		"paddleSubscriptionId": paddleSubscriptionID,
		"paddleTransactionId":  paddleTransactionID,
		"paddlePriceId":        paddlePriceID,
	}
}

func loadBillingSubscriptionRow(ctx context.Context, pool *pgxpool.Pool, userID int) (*billing.SubscriptionRow, error) {
	rows, err := pool.Query(ctx, `
		SELECT membership, status, source, paddle_subscription_id, paddle_transaction_id, paddle_price_id, current_period_ends_at
		FROM billing_subscriptions
		WHERE user_id = $1
		LIMIT 1
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	var item billing.SubscriptionRow
	if err := rows.Scan(&item.Membership, &item.Status, &item.Source, &item.PaddleSubscriptionID, &item.PaddleTransactionID, &item.PaddlePriceID, &item.CurrentPeriodEndsAt); err != nil {
		return nil, err
	}
	return &item, rows.Err()
}

func billingPlanByKey(plans []billing.Plan, key string) (billing.Plan, bool) {
	for _, plan := range plans {
		if plan.PlanKey == key {
			return plan, true
		}
	}
	return billing.Plan{}, false
}

type paddleTransactionCreator interface {
	CreateTransaction(context.Context, *paddle.CreateTransactionRequest) (*paddle.Transaction, error)
}

func createPaddleTransaction(ctx context.Context, plan billing.Plan, user auth.User) (string, *string, map[string]any, error) {
	apiKey := strings.TrimSpace(os.Getenv("PADDLE_API_KEY"))
	if apiKey == "" {
		return "", nil, nil, api.NewError(http.StatusInternalServerError, "BILLING_NOT_CONFIGURED", "Paddle API key is not configured", nil)
	}

	client, err := newPaddleClient(apiKey, os.Getenv("PADDLE_ENVIRONMENT"))
	if err != nil {
		return "", nil, nil, api.NewError(http.StatusInternalServerError, "PADDLE_CLIENT_INIT_FAILED", "Unable to initialize Paddle client", map[string]any{"error": err.Error()})
	}
	return createPaddleTransactionWithClient(ctx, client, plan, user)
}

func newPaddleClient(apiKey string, environment string) (*paddle.SDK, error) {
	if strings.TrimSpace(environment) == "production" {
		return paddle.New(apiKey)
	}
	return paddle.NewSandbox(apiKey)
}

func createPaddleTransactionWithClient(ctx context.Context, client paddleTransactionCreator, plan billing.Plan, user auth.User) (string, *string, map[string]any, error) {
	transaction, err := client.CreateTransaction(ctx, &paddle.CreateTransactionRequest{
		Items: []paddle.CreateTransactionItems{
			*paddle.NewCreateTransactionItemsTransactionItemFromCatalog(&paddle.TransactionItemFromCatalog{
				PriceID:  plan.PriceID,
				Quantity: 1,
			}),
		},
		CollectionMode: paddle.PtrTo(paddle.CollectionModeAutomatic),
		CustomData:     paddle.CustomData{"userId": user.ID, "planKey": plan.PlanKey},
	})
	if err != nil {
		return "", nil, nil, paddleCheckoutError(err)
	}
	if transaction == nil || strings.TrimSpace(transaction.ID) == "" {
		return "", nil, nil, api.NewError(http.StatusBadGateway, "PADDLE_RESPONSE_INVALID", "Paddle transaction response is missing id", nil)
	}
	rawPayload, err := paddleTransactionPayload(transaction)
	if err != nil {
		return "", nil, nil, api.NewError(http.StatusBadGateway, "PADDLE_RESPONSE_INVALID", "Paddle returned invalid transaction data", map[string]any{"error": err.Error()})
	}
	return transaction.ID, transaction.CustomerID, rawPayload, nil
}

func paddleCheckoutError(err error) error {
	var paddleErr *paddleerr.Error
	if errors.As(err, &paddleErr) {
		details := map[string]any{
			"type":    paddleErr.Type,
			"code":    paddleErr.Code,
			"detail":  paddleErr.Detail,
			"status":  paddleErr.Status,
			"errors":  paddleErr.Errors,
			"extra":   paddleErr.Extra,
			"docsUrl": paddleErr.DocumentationURL,
		}
		return api.NewError(http.StatusBadGateway, "PADDLE_REQUEST_FAILED", "Paddle checkout request failed", details)
	}
	return api.NewError(http.StatusBadGateway, "PADDLE_REQUEST_FAILED", "Paddle checkout request failed", map[string]any{"error": err.Error()})
}

func paddleTransactionPayload(transaction *paddle.Transaction) (map[string]any, error) {
	body, err := json.Marshal(transaction)
	if err != nil {
		return nil, err
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	return payload, nil
}

func upsertCheckoutBillingState(ctx context.Context, pool *pgxpool.Pool, userID int, plan billing.Plan, transactionID string, customerID *string, rawPayload map[string]any) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollbackUnlessCommitted(ctx, tx)
	_, err = tx.Exec(ctx, `
		INSERT INTO billing_subscriptions (
			user_id, membership, status, source, paddle_transaction_id, paddle_customer_id, paddle_price_id, raw_payload
		)
		VALUES ($1, $2, 'inactive', 'paddle', $3, $4, $5, $6)
		ON CONFLICT (user_id) DO UPDATE SET
			membership = EXCLUDED.membership,
			source = EXCLUDED.source,
			paddle_transaction_id = EXCLUDED.paddle_transaction_id,
			paddle_customer_id = COALESCE(EXCLUDED.paddle_customer_id, billing_subscriptions.paddle_customer_id),
			paddle_price_id = COALESCE(EXCLUDED.paddle_price_id, billing_subscriptions.paddle_price_id),
			raw_payload = EXCLUDED.raw_payload
	`, userID, plan.PlanKey, transactionID, nullableString(customerID), nullableJSON(rawPayload))
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	invalidateUserCache(ctx, int64(userID))
	return nil
}

func upsertSubscriptionBillingState(ctx context.Context, pool *pgxpool.Pool, payload billing.SubscriptionPayload, rawPayload map[string]any) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollbackUnlessCommitted(ctx, tx)
	_, err = tx.Exec(ctx, `
		INSERT INTO billing_subscriptions (
			user_id, membership, status, source, paddle_subscription_id, paddle_transaction_id,
			paddle_customer_id, paddle_price_id, current_period_starts_at, current_period_ends_at,
			scheduled_change_action, scheduled_change_effective_at, raw_payload
		)
		VALUES ($1, $2, $3, 'paddle', $4, $5, $6, $7, $8, $9, $10, $11, $12)
		ON CONFLICT (user_id) DO UPDATE SET
			membership = EXCLUDED.membership,
			status = EXCLUDED.status,
			source = EXCLUDED.source,
			paddle_subscription_id = COALESCE(EXCLUDED.paddle_subscription_id, billing_subscriptions.paddle_subscription_id),
			paddle_transaction_id = COALESCE(EXCLUDED.paddle_transaction_id, billing_subscriptions.paddle_transaction_id),
			paddle_customer_id = COALESCE(EXCLUDED.paddle_customer_id, billing_subscriptions.paddle_customer_id),
			paddle_price_id = COALESCE(EXCLUDED.paddle_price_id, billing_subscriptions.paddle_price_id),
			current_period_starts_at = COALESCE(EXCLUDED.current_period_starts_at, billing_subscriptions.current_period_starts_at),
			current_period_ends_at = COALESCE(EXCLUDED.current_period_ends_at, billing_subscriptions.current_period_ends_at),
			scheduled_change_action = EXCLUDED.scheduled_change_action,
			scheduled_change_effective_at = EXCLUDED.scheduled_change_effective_at,
			raw_payload = EXCLUDED.raw_payload
	`, payload.UserID, payload.Membership, payload.Status, nullableString(payload.SubscriptionID), nullableString(payload.TransactionID), nullableString(payload.CustomerID), nullableString(payload.PriceID), nullableTimeString(payload.CurrentPeriodStartsAt), nullableTimeString(payload.CurrentPeriodEndsAt), nullableString(payload.ScheduledChangeAction), nullableTimeString(payload.ScheduledChangeEffectiveAt), nullableJSON(rawPayload))
	if err != nil {
		return err
	}
	nextMembership := payload.Membership
	nextExpiry := nullableTimeString(payload.CurrentPeriodEndsAt)
	if !billingKeepsPaidAccess(payload.Status, nullableTimeString(payload.CurrentPeriodEndsAt)) {
		nextMembership = "free"
		nextExpiry = nil
	}
	_, err = tx.Exec(ctx, `
		UPDATE users
		SET membership = $1, plus_expires_at = $2
		WHERE id = $3
	`, nextMembership, nextExpiry, payload.UserID)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	invalidateUserCache(ctx, int64(payload.UserID))
	return nil
}

func upsertTransactionBillingState(ctx context.Context, pool *pgxpool.Pool, payload billing.TransactionPayload, rawPayload map[string]any) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollbackUnlessCommitted(ctx, tx)
	_, err = tx.Exec(ctx, `
		INSERT INTO billing_subscriptions (
			user_id, membership, status, source, paddle_transaction_id, paddle_customer_id, paddle_price_id, raw_payload
		)
		VALUES ($1, $2, 'inactive', 'paddle', $3, $4, $5, $6)
		ON CONFLICT (user_id) DO UPDATE SET
			membership = EXCLUDED.membership,
			source = EXCLUDED.source,
			paddle_transaction_id = EXCLUDED.paddle_transaction_id,
			paddle_customer_id = COALESCE(EXCLUDED.paddle_customer_id, billing_subscriptions.paddle_customer_id),
			paddle_price_id = COALESCE(EXCLUDED.paddle_price_id, billing_subscriptions.paddle_price_id),
			raw_payload = EXCLUDED.raw_payload
	`, payload.UserID, payload.Membership, payload.TransactionID, nullableString(payload.CustomerID), nullableString(payload.PriceID), nullableJSON(rawPayload))
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	invalidateUserCache(ctx, int64(payload.UserID))
	return nil
}

func verifyPaddleWebhookSignature(rawBody []byte, header string, secret string) error {
	req, err := http.NewRequest(http.MethodPost, "https://webhook.paddle.local", bytes.NewReader(rawBody))
	if err != nil {
		return err
	}
	req.Header.Set("Paddle-Signature", header)
	ok, err := paddle.NewWebhookVerifier(secret).Verify(req)
	if err != nil {
		if errors.Is(err, paddle.ErrMissingSignature) || errors.Is(err, paddle.ErrInvalidSignatureFormat) || errors.Is(err, paddle.ErrReplayAttack) {
			return api.NewError(http.StatusUnauthorized, "PADDLE_SIGNATURE_INVALID", "Invalid paddle-signature header", nil)
		}
		return err
	}
	if !ok {
		return api.NewError(http.StatusUnauthorized, "PADDLE_SIGNATURE_INVALID", "Invalid paddle-signature header", nil)
	}
	return nil
}

func decodePaddleWebhook(rawBody []byte) (string, map[string]any, error) {
	var payload paddleEnvelope
	if err := json.Unmarshal(rawBody, &payload); err != nil {
		return "", nil, invalidJSON()
	}
	if payload.EventType == "" {
		var fallback map[string]any
		if err := json.Unmarshal(rawBody, &fallback); err != nil {
			return "", nil, invalidJSON()
		}
		payload.EventType = stringValue(fallback, "eventType")
		if payload.Data == nil {
			payload.Data = mapValue(fallback, "data")
		}
	}
	if payload.EventType == "" || payload.Data == nil {
		return "", nil, api.NewError(http.StatusBadRequest, "INVALID_WEBHOOK_EVENT", "Webhook payload is missing event type or data", nil)
	}
	return payload.EventType, payload.Data, nil
}

func lookupBillingFallbackUserID(ctx context.Context, pool *pgxpool.Pool, data map[string]any) (int, error) {
	for _, lookup := range []struct {
		query string
		arg   string
	}{
		{query: `SELECT user_id FROM billing_subscriptions WHERE paddle_subscription_id = $1 LIMIT 1`, arg: stringValue(data, "id")},
		{query: `SELECT user_id FROM billing_subscriptions WHERE paddle_subscription_id = $1 LIMIT 1`, arg: stringValue(data, "subscriptionId")},
		{query: `SELECT user_id FROM billing_subscriptions WHERE paddle_customer_id = $1 LIMIT 1`, arg: stringValue(data, "customerId")},
	} {
		if strings.TrimSpace(lookup.arg) == "" {
			continue
		}
		var userID int
		err := pool.QueryRow(ctx, lookup.query, lookup.arg).Scan(&userID)
		if err == nil {
			return userID, nil
		}
		if err == sql.ErrNoRows {
			continue
		}
	}
	return 0, nil
}

func invalidateUserCache(ctx context.Context, userID int64) {
	if rdb := redisx.Client(); rdb != nil {
		redisx.Delete(ctx, rdb, redisx.RedisKey("cache", "user", userID))
	}
}

func rollbackUnlessCommitted(ctx context.Context, tx interface{ Rollback(context.Context) error }) {
	_ = tx.Rollback(ctx)
}

func billingKeepsPaidAccess(status string, endsAt *time.Time) bool {
	switch status {
	case "active", "trialing", "past_due":
		return true
	default:
		return endsAt != nil && endsAt.After(time.Now().UTC())
	}
}

func nullableString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableJSON(value map[string]any) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func nullableTimeString(value *string) *time.Time {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil
	}
	parsed, err := time.Parse(time.RFC3339, *value)
	if err != nil {
		parsed, err = time.Parse("2006-01-02T15:04:05.000Z", *value)
		if err != nil {
			return nil
		}
	}
	return &parsed
}

func mapValue(values map[string]any, key string) map[string]any {
	if raw, ok := values[key]; ok {
		if mapped, ok := raw.(map[string]any); ok {
			return mapped
		}
	}
	return nil
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
func int64Value(values map[string]any, key string) int64 {
	if values == nil {
		return 0
	}
	switch value := values[key].(type) {
	case int64:
		return value
	case int:
		return int64(value)
	case float64:
		return int64(value)
	default:
		return 0
	}
}

func stringPtrValueAny(values map[string]any, keys ...string) *string {
	for _, key := range keys {
		if value := stringValue(values, key); value != "" {
			return &value
		}
	}
	return nil
}
