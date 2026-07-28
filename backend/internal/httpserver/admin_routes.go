package httpserver

import (
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgxpool"
	"practiq/internal/api"
	"practiq/internal/auth"
	"practiq/internal/services"
)

type knowledgePointCreateRequest struct {
	SubjectID   string         `json:"subjectId"`
	Code        string         `json:"code"`
	DisplayName string         `json:"displayName"`
	ParentID    *int64         `json:"parentId"`
	Metadata    map[string]any `json:"metadata"`
}

type knowledgePointUpdateRequest struct {
	Code        *string                   `json:"code"`
	DisplayName *string                   `json:"displayName"`
	ParentID    optionalJSONField[*int64] `json:"parentId"`
	Metadata    map[string]any            `json:"metadata"`
}

type userStatusRequest struct {
	IsActive *bool `json:"isActive"`
}

type userAccessRequest struct {
	Role       *string `json:"role"`
	Membership *string `json:"membership"`
}

func BuildAdminHandlers(pool *pgxpool.Pool) AdminHandlers {
	currentUser := auth.CurrentUserFromRequest(pool)
	return AdminHandlers{
		Overview: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, err := requireCurrentUser(r, currentUser)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := services.GetAdminOverview(r.Context(), pool, user)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.OK(w, r, data, nil)
		}),
		Users: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, err := requireCurrentUser(r, currentUser)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := services.ListAdminUsers(r.Context(), pool, user, r.URL.Query())
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.OK(w, r, data.Items, paginationMeta(data.PageInfo))
		}),
		KnowledgePoints: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, err := requireCurrentUser(r, currentUser)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := services.ListAdminKnowledgePoints(r.Context(), pool, user, r.URL.Query())
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.OK(w, r, data.Items, paginationMeta(data.PageInfo))
		}),
		CreateKnowledgePoint: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			body, err := decodeJSONBodyStrict[knowledgePointCreateRequest](r)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			input, err := validateKnowledgePointCreate(body)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			user, err := requireCurrentUser(r, currentUser)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := services.CreateKnowledgePoint(r.Context(), pool, user, input)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.Created(w, r, data, nil)
		}),
		UpdateKnowledgePoint: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			knowledgePointID, err := parsePathID(r, "knowledgePointId")
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			body, err := decodeJSONBodyStrict[knowledgePointUpdateRequest](r)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			input, err := validateKnowledgePointUpdate(body)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			user, err := requireCurrentUser(r, currentUser)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := services.UpdateKnowledgePoint(r.Context(), pool, user, knowledgePointID, input)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.OK(w, r, data, nil)
		}),
		SetUserStatus: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			userID, err := parsePathID(r, "userId")
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			body, err := decodeJSONBodyStrict[userStatusRequest](r)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			isActive, err := validateUserStatus(body)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			user, err := requireCurrentUser(r, currentUser)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := services.SetUserStatus(r.Context(), pool, user, userID, isActive)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.OK(w, r, data, nil)
		}),
		UpdateUserAccess: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			userID, err := parsePathID(r, "userId")
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			body, err := decodeJSONBodyStrict[userAccessRequest](r)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			input, err := validateUserAccess(body)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			user, err := requireCurrentUser(r, currentUser)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := services.UpdateUserAccess(r.Context(), pool, user, userID, input)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.OK(w, r, data, nil)
		}),
	}
}

func validateKnowledgePointCreate(body knowledgePointCreateRequest) (services.KnowledgePointInput, error) {
	details := make([]api.ValidationDetail, 0, 3)
	subjectID := strings.TrimSpace(body.SubjectID)
	code := strings.TrimSpace(body.Code)
	displayName := strings.TrimSpace(body.DisplayName)
	if utf8.RuneCountInString(subjectID) == 0 || utf8.RuneCountInString(subjectID) > 32 {
		details = append(details, api.ValidationDetail{Field: "subjectId", Message: "must be 1-32 characters"})
	}
	if utf8.RuneCountInString(code) == 0 || utf8.RuneCountInString(code) > 128 {
		details = append(details, api.ValidationDetail{Field: "code", Message: "must be 1-128 characters"})
	}
	if utf8.RuneCountInString(displayName) == 0 || utf8.RuneCountInString(displayName) > 256 {
		details = append(details, api.ValidationDetail{Field: "displayName", Message: "must be 1-256 characters"})
	}
	if body.ParentID != nil && *body.ParentID <= 0 {
		details = append(details, api.ValidationDetail{Field: "parentId", Message: "must be a positive integer"})
	}
	if len(details) > 0 {
		return services.KnowledgePointInput{}, api.ValidationError(details)
	}
	return services.KnowledgePointInput{SubjectID: subjectID, Code: code, DisplayName: displayName, ParentID: body.ParentID, Metadata: body.Metadata}, nil
}

func validateKnowledgePointUpdate(body knowledgePointUpdateRequest) (services.KnowledgePointUpdate, error) {
	details := make([]api.ValidationDetail, 0, 4)
	var code *string
	if body.Code != nil {
		trimmed := strings.TrimSpace(*body.Code)
		if utf8.RuneCountInString(trimmed) == 0 || utf8.RuneCountInString(trimmed) > 128 {
			details = append(details, api.ValidationDetail{Field: "code", Message: "must be 1-128 characters"})
		} else {
			code = &trimmed
		}
	}
	var displayName *string
	if body.DisplayName != nil {
		trimmed := strings.TrimSpace(*body.DisplayName)
		if utf8.RuneCountInString(trimmed) == 0 || utf8.RuneCountInString(trimmed) > 256 {
			details = append(details, api.ValidationDetail{Field: "displayName", Message: "must be 1-256 characters"})
		} else {
			displayName = &trimmed
		}
	}
	if body.ParentID.Value != nil && *body.ParentID.Value <= 0 {
		details = append(details, api.ValidationDetail{Field: "parentId", Message: "must be a positive integer"})
	}
	if body.Code == nil && body.DisplayName == nil && !body.ParentID.Set && body.Metadata == nil {
		details = append(details, api.ValidationDetail{Field: "body", Message: "must include a field to update"})
	}
	if len(details) > 0 {
		return services.KnowledgePointUpdate{}, api.ValidationError(details)
	}
	return services.KnowledgePointUpdate{
		Code:        code,
		DisplayName: displayName,
		ParentID:    body.ParentID.Value,
		ParentIDSet: body.ParentID.Set,
		Metadata:    body.Metadata,
		MetadataSet: body.Metadata != nil,
	}, nil
}

func validateUserStatus(body userStatusRequest) (bool, error) {
	if body.IsActive == nil {
		return false, api.ValidationError([]api.ValidationDetail{{Field: "isActive", Message: "is required"}})
	}
	return *body.IsActive, nil
}

func validateUserAccess(body userAccessRequest) (services.UserAccessUpdate, error) {
	details := make([]api.ValidationDetail, 0, 2)
	role := trimmedOrNil(body.Role)
	membership := trimmedOrNil(body.Membership)
	if role == nil && membership == nil {
		details = append(details, api.ValidationDetail{Field: "body", Message: "must include role or membership"})
	}
	if role != nil && *role != "admin" && *role != "user" {
		details = append(details, api.ValidationDetail{Field: "role", Message: "must be one of admin, user"})
	}
	if membership != nil && *membership != "free" && *membership != "plus" && *membership != "enterprise" {
		details = append(details, api.ValidationDetail{Field: "membership", Message: "must be one of free, plus, enterprise"})
	}
	if len(details) > 0 {
		return services.UserAccessUpdate{}, api.ValidationError(details)
	}
	return services.UserAccessUpdate{Role: role, Membership: membership}, nil
}
