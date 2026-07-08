package httpserver

import (
	"context"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"openwook/internal/api"
	"openwook/internal/auth"
	"openwook/internal/services"
)

type mediaRouteDependencies struct {
	currentUser      auth.CurrentUserResolver
	createMediaAsset func(context.Context, services.CreateMediaAssetInput) (*services.MediaAsset, error)
	getMediaAsset    func(context.Context, auth.User, int64) (*services.MediaAsset, error)
	deleteMediaAsset func(context.Context, auth.User, int64) error
	linkQuestion     func(context.Context, auth.User, int64, services.MediaLinkInput) (*services.QuestionMediaLink, error)
	linkGroup        func(context.Context, auth.User, int64, services.MediaLinkInput) (*services.GroupMediaLink, error)
	linkOption       func(context.Context, auth.User, int64, services.MediaLinkInput) (*services.OptionMediaLink, error)
}

type mediaCreateRequest struct {
	StoragePath  string  `json:"storagePath"`
	ExternalURL  *string `json:"externalUrl"`
	OriginalName *string `json:"originalName"`
	MimeType     *string `json:"mimeType"`
	SizeBytes    *int64  `json:"sizeBytes"`
}

type mediaLinkRequest struct {
	MediaID   *int64 `json:"mediaId"`
	MediaKind string `json:"mediaKind"`
	SortOrder *int   `json:"sortOrder"`
}

func BuildMediaHandlers(pool *pgxpool.Pool) MediaHandlers {
	return buildMediaHandlers(mediaRouteDependencies{
		currentUser:      auth.CurrentUserFromRequest(pool),
		createMediaAsset: func(ctx context.Context, input services.CreateMediaAssetInput) (*services.MediaAsset, error) { return services.CreateMediaAsset(ctx, pool, input) },
		getMediaAsset:    func(ctx context.Context, user auth.User, mediaID int64) (*services.MediaAsset, error) { return services.GetMediaAsset(ctx, pool, user, mediaID) },
		deleteMediaAsset: func(ctx context.Context, user auth.User, mediaID int64) error { return services.DeleteMediaAsset(ctx, pool, user, mediaID) },
		linkQuestion:     func(ctx context.Context, user auth.User, questionID int64, input services.MediaLinkInput) (*services.QuestionMediaLink, error) { return services.LinkQuestionMedia(ctx, pool, user, questionID, input) },
		linkGroup:        func(ctx context.Context, user auth.User, groupID int64, input services.MediaLinkInput) (*services.GroupMediaLink, error) { return services.LinkGroupMedia(ctx, pool, user, groupID, input) },
		linkOption:       func(ctx context.Context, user auth.User, optionID int64, input services.MediaLinkInput) (*services.OptionMediaLink, error) { return services.LinkOptionMedia(ctx, pool, user, optionID, input) },
	})
}

func buildMediaHandlers(deps mediaRouteDependencies) MediaHandlers {
	return MediaHandlers{
		Create: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			body, err := decodeJSONBodyStrict[mediaCreateRequest](r)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			input, err := validateMediaCreate(body)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			if _, err := requireCurrentUser(r, deps.currentUser); err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := deps.createMediaAsset(r.Context(), input)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.Created(w, r, data, nil)
		}),
		Get: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			mediaID, err := parsePathID(r, "mediaId")
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			user, err := requireCurrentUser(r, deps.currentUser)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := deps.getMediaAsset(r.Context(), user, mediaID)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.OK(w, r, data, nil)
		}),
		Delete: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			mediaID, err := parsePathID(r, "mediaId")
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			user, err := requireCurrentUser(r, deps.currentUser)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			if err := deps.deleteMediaAsset(r.Context(), user, mediaID); err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.NoContent(w, r)
		}),
		LinkQuestion: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			questionID, err := parsePathID(r, "questionId")
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			body, err := decodeJSONBodyStrict[mediaLinkRequest](r)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			input, err := validateMediaLink(body)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			user, err := requireCurrentUser(r, deps.currentUser)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := deps.linkQuestion(r.Context(), user, questionID, input)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.Created(w, r, data, nil)
		}),
		LinkGroup: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			groupID, err := parsePathID(r, "groupId")
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			body, err := decodeJSONBodyStrict[mediaLinkRequest](r)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			input, err := validateMediaLink(body)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			user, err := requireCurrentUser(r, deps.currentUser)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := deps.linkGroup(r.Context(), user, groupID, input)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.Created(w, r, data, nil)
		}),
		LinkOption: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			optionID, err := parsePathID(r, "optionId")
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			body, err := decodeJSONBodyStrict[mediaLinkRequest](r)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			input, err := validateMediaLink(body)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			user, err := requireCurrentUser(r, deps.currentUser)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := deps.linkOption(r.Context(), user, optionID, input)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.Created(w, r, data, nil)
		}),
	}
}

func validateMediaCreate(body mediaCreateRequest) (services.CreateMediaAssetInput, error) {
	details := make([]api.ValidationDetail, 0, 3)
	storagePath := strings.TrimSpace(body.StoragePath)
	if storagePath == "" {
		details = append(details, api.ValidationDetail{Field: "storagePath", Message: "is required"})
	}
	externalURL := trimmedOrNil(body.ExternalURL)
	if externalURL != nil && !validateURLString(*externalURL) {
		details = append(details, api.ValidationDetail{Field: "externalUrl", Message: "must be a valid URL"})
	}
	if body.SizeBytes != nil && *body.SizeBytes < 0 {
		details = append(details, api.ValidationDetail{Field: "sizeBytes", Message: "must be non-negative"})
	}
	if len(details) > 0 {
		return services.CreateMediaAssetInput{}, api.ValidationError(details)
	}
	return services.CreateMediaAssetInput{StoragePath: storagePath, ExternalURL: externalURL, OriginalName: trimmedOrNil(body.OriginalName), MimeType: trimmedOrNil(body.MimeType), SizeBytes: body.SizeBytes}, nil
}

func validateMediaLink(body mediaLinkRequest) (services.MediaLinkInput, error) {
	details := make([]api.ValidationDetail, 0, 3)
	if body.MediaID == nil || *body.MediaID <= 0 {
		details = append(details, api.ValidationDetail{Field: "mediaId", Message: "must be a positive integer"})
	}
	mediaKind := strings.TrimSpace(body.MediaKind)
	if mediaKind == "" {
		details = append(details, api.ValidationDetail{Field: "mediaKind", Message: "is required"})
	}
	if body.SortOrder != nil && *body.SortOrder <= 0 {
		details = append(details, api.ValidationDetail{Field: "sortOrder", Message: "must be a positive integer"})
	}
	if len(details) > 0 {
		return services.MediaLinkInput{}, api.ValidationError(details)
	}
	return services.MediaLinkInput{MediaID: *body.MediaID, MediaKind: mediaKind, SortOrder: body.SortOrder}, nil
}
