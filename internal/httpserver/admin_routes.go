package httpserver

import (
	"context"
	"net/http"
	"net/url"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"openwook/internal/api"
	"openwook/internal/auth"
	"openwook/internal/services"
)

type adminRouteDependencies struct {
	currentUser          auth.CurrentUserResolver
	getAdminOverview     func(context.Context, auth.User) (*services.AdminOverview, error)
	listAdminUsers       func(context.Context, auth.User, url.Values) ([]services.AdminUser, error)
	listKnowledgePoints  func(context.Context, auth.User, url.Values) ([]services.KnowledgePoint, error)
	createKnowledgePoint func(context.Context, auth.User, services.KnowledgePointInput) (*services.KnowledgePoint, error)
	updateKnowledgePoint func(context.Context, auth.User, int64, services.KnowledgePointUpdate) (*services.KnowledgePoint, error)
	setUserStatus        func(context.Context, auth.User, int64, bool) (*services.UserRecord, error)
	updateUserAccess     func(context.Context, auth.User, int64, services.UserAccessUpdate) (*services.UserRecord, error)
}

type knowledgePointCreateRequest struct {
	SubjectID   string         `json:"subjectId"`
	Code        string         `json:"code"`
	DisplayName string         `json:"displayName"`
	ParentID    *int64         `json:"parentId"`
	Metadata    map[string]any `json:"metadata"`
}

type knowledgePointUpdateRequest struct {
	SubjectID   *string        `json:"subjectId"`
	Code        *string        `json:"code"`
	DisplayName *string        `json:"displayName"`
	ParentID    *int64         `json:"parentId"`
	Metadata    map[string]any `json:"metadata"`
}

type userStatusRequest struct {
	IsActive *bool `json:"isActive"`
}

type userAccessRequest struct {
	Role       *string `json:"role"`
	Membership *string `json:"membership"`
}

func BuildAdminHandlers(pool *pgxpool.Pool) AdminHandlers {
	return buildAdminHandlers(adminRouteDependencies{
		currentUser:          auth.CurrentUserFromRequest(pool),
		getAdminOverview:     func(ctx context.Context, user auth.User) (*services.AdminOverview, error) { return services.GetAdminOverview(ctx, pool, user) },
		listAdminUsers:       func(ctx context.Context, user auth.User, params url.Values) ([]services.AdminUser, error) { return services.ListAdminUsers(ctx, pool, user, params) },
		listKnowledgePoints:  func(ctx context.Context, user auth.User, params url.Values) ([]services.KnowledgePoint, error) { return services.ListAdminKnowledgePoints(ctx, pool, user, params) },
		createKnowledgePoint: func(ctx context.Context, user auth.User, input services.KnowledgePointInput) (*services.KnowledgePoint, error) { return services.CreateKnowledgePoint(ctx, pool, user, input) },
		updateKnowledgePoint: func(ctx context.Context, user auth.User, id int64, input services.KnowledgePointUpdate) (*services.KnowledgePoint, error) { return services.UpdateKnowledgePoint(ctx, pool, user, id, input) },
		setUserStatus:        func(ctx context.Context, user auth.User, targetUserID int64, isActive bool) (*services.UserRecord, error) { return services.SetUserStatus(ctx, pool, user, targetUserID, isActive) },
		updateUserAccess:     func(ctx context.Context, user auth.User, targetUserID int64, input services.UserAccessUpdate) (*services.UserRecord, error) { return services.UpdateUserAccess(ctx, pool, user, targetUserID, input) },
	})
}

func buildAdminHandlers(deps adminRouteDependencies) AdminHandlers {
	return AdminHandlers{
		Overview: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, err := requireCurrentUser(r, deps.currentUser)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := deps.getAdminOverview(r.Context(), user)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.OK(w, r, data, nil)
		}),
		Users: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, err := requireCurrentUser(r, deps.currentUser)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := deps.listAdminUsers(r.Context(), user, r.URL.Query())
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.OK(w, r, data, nil)
		}),
		KnowledgePoints: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, err := requireCurrentUser(r, deps.currentUser)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := deps.listKnowledgePoints(r.Context(), user, r.URL.Query())
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.OK(w, r, data, nil)
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
			user, err := requireCurrentUser(r, deps.currentUser)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := deps.createKnowledgePoint(r.Context(), user, input)
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
			user, err := requireCurrentUser(r, deps.currentUser)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := deps.updateKnowledgePoint(r.Context(), user, knowledgePointID, input)
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
			user, err := requireCurrentUser(r, deps.currentUser)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := deps.setUserStatus(r.Context(), user, userID, isActive)
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
			user, err := requireCurrentUser(r, deps.currentUser)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := deps.updateUserAccess(r.Context(), user, userID, input)
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
	if len(subjectID) == 0 || len(subjectID) > 32 {
		details = append(details, api.ValidationDetail{Field: "subjectId", Message: "must be 1-32 characters"})
	}
	if len(code) == 0 || len(code) > 128 {
		details = append(details, api.ValidationDetail{Field: "code", Message: "must be 1-128 characters"})
	}
	if len(displayName) == 0 || len(displayName) > 256 {
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
		if len(trimmed) == 0 || len(trimmed) > 128 {
			details = append(details, api.ValidationDetail{Field: "code", Message: "must be 1-128 characters"})
		} else {
			code = &trimmed
		}
	}
	var displayName *string
	if body.DisplayName != nil {
		trimmed := strings.TrimSpace(*body.DisplayName)
		if len(trimmed) == 0 || len(trimmed) > 256 {
			details = append(details, api.ValidationDetail{Field: "displayName", Message: "must be 1-256 characters"})
		} else {
			displayName = &trimmed
		}
	}
	if body.SubjectID != nil {
		trimmed := strings.TrimSpace(*body.SubjectID)
		if len(trimmed) == 0 || len(trimmed) > 32 {
			details = append(details, api.ValidationDetail{Field: "subjectId", Message: "must be 1-32 characters"})
		}
	}
	if body.ParentID != nil && *body.ParentID <= 0 {
		details = append(details, api.ValidationDetail{Field: "parentId", Message: "must be a positive integer"})
	}
	if len(details) > 0 {
		return services.KnowledgePointUpdate{}, api.ValidationError(details)
	}
	return services.KnowledgePointUpdate{Code: code, DisplayName: displayName, ParentID: body.ParentID, Metadata: body.Metadata, MetadataSet: body.Metadata != nil}, nil
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
