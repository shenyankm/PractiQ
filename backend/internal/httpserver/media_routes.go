package httpserver

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgxpool"
	"practiq/internal/api"
	"practiq/internal/auth"
	"practiq/internal/services"
)

type mediaLinkRequest struct {
	MediaID   *int64 `json:"mediaId"`
	MediaKind string `json:"mediaKind"`
	SortOrder *int   `json:"sortOrder"`
}

func BuildMediaHandlers(pool *pgxpool.Pool) MediaHandlers {
	currentUser := auth.CurrentUserFromRequest(pool)
	return MediaHandlers{
		Create: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, err := requireCurrentUser(r, currentUser)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			file, err := readMediaUpload(w, r)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := services.CreateUploadedMedia(r.Context(), pool, user, file)
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
			user, err := requireCurrentUser(r, currentUser)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := services.GetMediaAsset(r.Context(), pool, user, mediaID)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.OK(w, r, data, nil)
		}),
		Content: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			mediaID, err := parsePathID(r, "mediaId")
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			user, err := requireCurrentUser(r, currentUser)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			asset, content, err := services.ReadMediaAssetContent(r.Context(), pool, user, mediaID)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			w.Header().Set("Cache-Control", "private, max-age=3600")
			if asset.MimeType != nil {
				w.Header().Set("Content-Type", *asset.MimeType)
			}
			if asset.OriginalName != nil {
				w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": *asset.OriginalName}))
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(content)
		}),
		Delete: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			mediaID, err := parsePathID(r, "mediaId")
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			user, err := requireCurrentUser(r, currentUser)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			if err := services.DeleteMediaAsset(r.Context(), pool, user, mediaID); err != nil {
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
			user, err := requireCurrentUser(r, currentUser)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := services.LinkQuestionMedia(r.Context(), pool, user, questionID, input)
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
			user, err := requireCurrentUser(r, currentUser)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := services.LinkGroupMedia(r.Context(), pool, user, groupID, input)
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
			user, err := requireCurrentUser(r, currentUser)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := services.LinkOptionMedia(r.Context(), pool, user, optionID, input)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.Created(w, r, data, nil)
		}),
		UnlinkQuestion: buildMediaUnlinkHandler(pool, currentUser, "question"),
		UnlinkGroup:    buildMediaUnlinkHandler(pool, currentUser, "group"),
		UnlinkOption:   buildMediaUnlinkHandler(pool, currentUser, "option"),
	}
}

func readMediaUpload(w http.ResponseWriter, r *http.Request) (services.UploadedMediaFile, error) {
	const maxUploadBytes = 10 * 1024 * 1024
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes+1024*1024)
	if err := r.ParseMultipartForm(1024 * 1024); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return services.UploadedMediaFile{}, api.NewError(http.StatusRequestEntityTooLarge, "FILE_TOO_LARGE", "Media file exceeds 10 MiB", nil)
		}
		return services.UploadedMediaFile{}, api.NewError(http.StatusBadRequest, "INVALID_MULTIPART", "A multipart file upload is required", nil)
	}
	defer r.MultipartForm.RemoveAll()
	file, header, err := r.FormFile("file")
	if err != nil {
		return services.UploadedMediaFile{}, api.NewError(http.StatusBadRequest, "FILE_REQUIRED", "Upload file is required", nil)
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, maxUploadBytes+1))
	if err != nil {
		return services.UploadedMediaFile{}, err
	}
	if len(content) > maxUploadBytes {
		return services.UploadedMediaFile{}, api.NewError(http.StatusRequestEntityTooLarge, "FILE_TOO_LARGE", "Media file exceeds 10 MiB", nil)
	}
	return services.UploadedMediaFile{Name: header.Filename, Content: content}, nil
}

func buildMediaUnlinkHandler(pool *pgxpool.Pool, currentUser auth.CurrentUserResolver, ownerKind string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, err := requireCurrentUser(r, currentUser)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		mediaID, err := parsePathID(r, "mediaId")
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		ownerID, err := parsePathID(r, ownerKind+"Id")
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		switch ownerKind {
		case "question":
			err = services.UnlinkQuestionMedia(r.Context(), pool, pool, user, ownerID, mediaID)
		case "group":
			err = services.UnlinkGroupMedia(r.Context(), pool, pool, user, ownerID, mediaID)
		case "option":
			err = services.UnlinkOptionMedia(r.Context(), pool, pool, user, ownerID, mediaID)
		}
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		api.NoContent(w, r)
	})
}

func validateMediaLink(body mediaLinkRequest) (services.MediaLinkInput, error) {
	details := make([]api.ValidationDetail, 0, 3)
	if body.MediaID == nil || *body.MediaID <= 0 {
		details = append(details, api.ValidationDetail{Field: "mediaId", Message: "must be a positive integer"})
	}
	mediaKind := strings.TrimSpace(body.MediaKind)
	if mediaKind == "" || utf8.RuneCountInString(mediaKind) > 64 {
		details = append(details, api.ValidationDetail{Field: "mediaKind", Message: "must be 1-64 characters"})
	}
	if body.SortOrder != nil && (*body.SortOrder < 1 || *body.SortOrder > 32767) {
		details = append(details, api.ValidationDetail{Field: "sortOrder", Message: "must be between 1 and 32767"})
	}
	if len(details) > 0 {
		return services.MediaLinkInput{}, api.ValidationError(details)
	}
	return services.MediaLinkInput{MediaID: *body.MediaID, MediaKind: mediaKind, SortOrder: body.SortOrder}, nil
}
