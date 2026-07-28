package services

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"practiq/internal/api"
	"practiq/internal/auth"
)

type MediaAsset struct {
	ID           int64   `json:"id"`
	CreatedBy    int64   `json:"created_by"`
	StoragePath  string  `json:"-"`
	StorageDisk  string  `json:"-"`
	ExternalURL  *string `json:"external_url"`
	ContentURL   string  `json:"content_url"`
	OriginalName *string `json:"original_name"`
	MimeType     *string `json:"mime_type"`
	Width        *int64  `json:"width"`
	Height       *int64  `json:"height"`
	SizeBytes    *int64  `json:"size_bytes"`
	DurationMS   *int64  `json:"duration_ms"`
	CreatedAt    string  `json:"created_at"`
}

type UploadedMediaFile struct {
	Name    string
	Content []byte
}

type MediaLinkInput struct {
	MediaID   int64  `json:"media_id"`
	MediaKind string `json:"media_kind"`
	SortOrder *int   `json:"sort_order"`
}

type QuestionMediaLink struct {
	ID         int64  `json:"id"`
	QuestionID int64  `json:"question_id"`
	MediaID    int64  `json:"media_id"`
	MediaKind  string `json:"media_kind"`
	SortOrder  int    `json:"sort_order"`
	CreatedAt  string `json:"created_at"`
}

type GroupMediaLink struct {
	ID        int64  `json:"id"`
	GroupID   int64  `json:"group_id"`
	MediaID   int64  `json:"media_id"`
	MediaKind string `json:"media_kind"`
	SortOrder int    `json:"sort_order"`
	CreatedAt string `json:"created_at"`
}

type OptionMediaLink struct {
	ID        int64  `json:"id"`
	OptionID  int64  `json:"option_id"`
	MediaID   int64  `json:"media_id"`
	MediaKind string `json:"media_kind"`
	SortOrder int    `json:"sort_order"`
	CreatedAt string `json:"created_at"`
}

const maxMediaUploadBytes = 10 * 1024 * 1024

var mediaTypes = map[string]string{
	"image/gif":  ".gif",
	"image/jpeg": ".jpg",
	"image/png":  ".png",
	"image/webp": ".webp",
}

func CreateUploadedMedia(ctx context.Context, db queryer, user auth.User, file UploadedMediaFile) (*MediaAsset, error) {
	if len(file.Content) == 0 {
		return nil, api.NewError(400, "EMPTY_FILE", "Upload file is empty", nil)
	}
	if len(file.Content) > maxMediaUploadBytes {
		return nil, api.NewError(413, "FILE_TOO_LARGE", "Media file exceeds 10 MiB", nil)
	}
	name := strings.TrimSpace(filepath.Base(file.Name))
	if name == "" || len(name) > 255 {
		return nil, api.NewError(400, "INVALID_FILE_NAME", "Media file name must be 1-255 bytes", nil)
	}
	mimeType := http.DetectContentType(file.Content)
	extension, ok := mediaTypes[mimeType]
	if !ok {
		return nil, api.NewError(400, "UNSUPPORTED_FILE_TYPE", "Only PNG, JPEG, GIF, and WebP images are supported", nil)
	}
	random := make([]byte, 12)
	if _, err := rand.Read(random); err != nil {
		return nil, err
	}
	relativePath := filepath.ToSlash(filepath.Join("media", fmt.Sprint(user.ID), hex.EncodeToString(random)+extension))
	absolutePath, err := resolveStoragePath(relativePath)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(absolutePath), 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(absolutePath, file.Content, 0o600); err != nil {
		return nil, err
	}
	size := int64(len(file.Content))
	asset, err := createMediaAsset(ctx, db, user, relativePath, name, mimeType, size)
	if err != nil {
		_ = os.Remove(absolutePath)
		return nil, err
	}
	return asset, nil
}

func createMediaAsset(ctx context.Context, db queryer, user auth.User, storagePath, originalName, mimeType string, sizeBytes int64) (*MediaAsset, error) {
	rows, err := db.Query(ctx, `
		INSERT INTO media_assets (created_by, storage_path, original_name, mime_type, size_bytes)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, created_by, storage_path, storage_disk, external_url, original_name, mime_type, width, height, size_bytes, duration_ms, created_at
	`, user.ID, storagePath, originalName, mimeType, sizeBytes)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	item, err := scanMediaAsset(rows)
	if err != nil {
		return nil, err
	}
	return &item, rows.Err()
}

func GetMediaAsset(ctx context.Context, db queryer, user auth.User, mediaID int64) (*MediaAsset, error) {
	rows, err := db.Query(ctx, `
		WITH accessible_questions AS (
			SELECT DISTINCT item.question_id
			FROM v_bank_question_items item
			JOIN question_banks b ON b.id = item.bank_id
			LEFT JOIN user_bank_links ubl ON ubl.bank_id = b.id AND ubl.user_id = $2
			WHERE COALESCE(ubl.is_owner, false)
			   OR ((b.is_public OR ubl.id IS NOT NULL) AND item.bank_link_status = 'active' AND item.question_status = 'active')
		),
		accessible_groups AS (
			SELECT DISTINCT bgl.group_id
			FROM bank_group_links bgl
			JOIN question_banks b ON b.id = bgl.bank_id
			LEFT JOIN user_bank_links ubl ON ubl.bank_id = b.id AND ubl.user_id = $2
			WHERE COALESCE(ubl.is_owner, false)
			   OR ((b.is_public OR ubl.id IS NOT NULL) AND bgl.status = 'active')
		)
		SELECT m.id, m.created_by, m.storage_path, m.storage_disk, m.external_url, m.original_name, m.mime_type,
		       m.width, m.height, m.size_bytes, m.duration_ms, m.created_at
		FROM media_assets m
		WHERE m.id = $1
		  AND (
		    m.created_by = $2
		    OR $3 = 'admin'
		    OR EXISTS (SELECT 1 FROM question_media_links l JOIN accessible_questions q ON q.question_id = l.question_id WHERE l.media_id = m.id)
		    OR EXISTS (SELECT 1 FROM question_option_media_links l JOIN question_options o ON o.id = l.option_id JOIN accessible_questions q ON q.question_id = o.question_id WHERE l.media_id = m.id)
		    OR EXISTS (SELECT 1 FROM question_group_media_links l JOIN accessible_groups g ON g.group_id = l.group_id WHERE l.media_id = m.id)
		    OR EXISTS (SELECT 1 FROM question_content_blocks b JOIN accessible_questions q ON q.question_id = b.question_id WHERE b.media_id = m.id)
		    OR EXISTS (SELECT 1 FROM question_content_blocks b JOIN accessible_groups g ON g.group_id = b.group_id WHERE b.media_id = m.id)
		    OR EXISTS (SELECT 1 FROM question_content_blocks b JOIN question_options o ON o.id = b.option_id JOIN accessible_questions q ON q.question_id = o.question_id WHERE b.media_id = m.id)
		  )
		LIMIT 1
	`, mediaID, user.ID, user.Role)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, api.NewError(404, "NOT_FOUND", "Media asset not found", nil)
	}
	item, err := scanMediaAsset(rows)
	if err != nil {
		return nil, err
	}
	return &item, rows.Err()
}

func ReadMediaAssetContent(ctx context.Context, db queryer, user auth.User, mediaID int64) (*MediaAsset, []byte, error) {
	asset, err := GetMediaAsset(ctx, db, user, mediaID)
	if err != nil {
		return nil, nil, err
	}
	absolutePath, err := resolveStoragePath(asset.StoragePath)
	if err != nil {
		return nil, nil, err
	}
	content, err := os.ReadFile(absolutePath)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil, api.NewError(404, "MEDIA_CONTENT_NOT_FOUND", "Media content not found", nil)
	}
	if err != nil {
		return nil, nil, err
	}
	return asset, content, nil
}

func DeleteMediaAsset(ctx context.Context, db *pgxpool.Pool, user auth.User, mediaID int64) error {
	if err := requireAdminRole(user); err != nil {
		return err
	}
	var storagePath string
	if err := db.QueryRow(ctx, `DELETE FROM media_assets WHERE id = $1 RETURNING storage_path`, mediaID).Scan(&storagePath); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return api.NewError(404, "NOT_FOUND", "Media asset not found", nil)
		}
		return err
	}
	absolutePath, err := resolveStoragePath(storagePath)
	if err != nil {
		return err
	}
	if err := os.Remove(absolutePath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func LinkQuestionMedia(ctx context.Context, db queryer, user auth.User, questionID int64, input MediaLinkInput) (*QuestionMediaLink, error) {
	if err := ensureQuestionEditableForMedia(ctx, db, user, questionID); err != nil {
		return nil, err
	}
	if err := ensureMediaOwned(ctx, db, user, input.MediaID); err != nil {
		return nil, err
	}
	rows, err := db.Query(ctx, `
		INSERT INTO question_media_links (question_id, media_id, media_kind, sort_order)
		VALUES ($1, $2, $3, $4)
		RETURNING id, question_id, media_id, media_kind, sort_order, created_at
	`, questionID, input.MediaID, input.MediaKind, linkSortOrder(input.SortOrder))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	item, err := scanQuestionMediaLink(rows)
	if err != nil {
		return nil, err
	}
	return &item, rows.Err()
}

func LinkGroupMedia(ctx context.Context, db queryer, user auth.User, groupID int64, input MediaLinkInput) (*GroupMediaLink, error) {
	if err := ensureGroupEditableForMedia(ctx, db, user, groupID); err != nil {
		return nil, err
	}
	if err := ensureMediaOwned(ctx, db, user, input.MediaID); err != nil {
		return nil, err
	}
	rows, err := db.Query(ctx, `
		INSERT INTO question_group_media_links (group_id, media_id, media_kind, sort_order)
		VALUES ($1, $2, $3, $4)
		RETURNING id, group_id, media_id, media_kind, sort_order, created_at
	`, groupID, input.MediaID, input.MediaKind, linkSortOrder(input.SortOrder))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	item, err := scanGroupMediaLink(rows)
	if err != nil {
		return nil, err
	}
	return &item, rows.Err()
}

func LinkOptionMedia(ctx context.Context, db queryer, user auth.User, optionID int64, input MediaLinkInput) (*OptionMediaLink, error) {
	questionID, err := optionQuestionID(ctx, db, optionID)
	if err != nil {
		return nil, err
	}
	if err := ensureQuestionEditableForMedia(ctx, db, user, questionID); err != nil {
		return nil, err
	}
	if err := ensureMediaOwned(ctx, db, user, input.MediaID); err != nil {
		return nil, err
	}
	rows, err := db.Query(ctx, `
		INSERT INTO question_option_media_links (option_id, media_id, media_kind, sort_order)
		VALUES ($1, $2, $3, $4)
		RETURNING id, option_id, media_id, media_kind, sort_order, created_at
	`, optionID, input.MediaID, input.MediaKind, linkSortOrder(input.SortOrder))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	item, err := scanOptionMediaLink(rows)
	if err != nil {
		return nil, err
	}
	return &item, rows.Err()
}

func scanMediaAsset(row interface{ Scan(...any) error }) (MediaAsset, error) {
	var item MediaAsset
	var createdAt time.Time
	if err := row.Scan(&item.ID, &item.CreatedBy, &item.StoragePath, &item.StorageDisk, &item.ExternalURL, &item.OriginalName, &item.MimeType, &item.Width, &item.Height, &item.SizeBytes, &item.DurationMS, &createdAt); err != nil {
		return MediaAsset{}, err
	}
	item.CreatedAt = formatTimestamp(createdAt)
	item.ContentURL = fmt.Sprintf("/api/v1/media/%d/content", item.ID)
	return item, nil
}

func ensureMediaOwned(ctx context.Context, db queryer, user auth.User, mediaID int64) error {
	rows, err := db.Query(ctx, `SELECT id FROM media_assets WHERE id = $1 AND (created_by = $2 OR $3 = 'admin') LIMIT 1`, mediaID, user.ID, user.Role)
	if err != nil {
		return err
	}
	defer rows.Close()
	if !rows.Next() {
		return api.NewError(403, "FORBIDDEN", "Media owner access required", nil)
	}
	return rows.Err()
}

func UnlinkQuestionMedia(ctx context.Context, db execer, authDB queryer, user auth.User, questionID, mediaID int64) error {
	if err := ensureQuestionEditableForMedia(ctx, authDB, user, questionID); err != nil {
		return err
	}
	return deleteMediaLink(ctx, db, `DELETE FROM question_media_links WHERE question_id = $1 AND media_id = $2`, questionID, mediaID)
}

func UnlinkGroupMedia(ctx context.Context, db execer, authDB queryer, user auth.User, groupID, mediaID int64) error {
	if err := ensureGroupEditableForMedia(ctx, authDB, user, groupID); err != nil {
		return err
	}
	return deleteMediaLink(ctx, db, `DELETE FROM question_group_media_links WHERE group_id = $1 AND media_id = $2`, groupID, mediaID)
}

func UnlinkOptionMedia(ctx context.Context, db execer, authDB queryer, user auth.User, optionID, mediaID int64) error {
	questionID, err := optionQuestionID(ctx, authDB, optionID)
	if err != nil {
		return err
	}
	if err := ensureQuestionEditableForMedia(ctx, authDB, user, questionID); err != nil {
		return err
	}
	return deleteMediaLink(ctx, db, `DELETE FROM question_option_media_links WHERE option_id = $1 AND media_id = $2`, optionID, mediaID)
}

func deleteMediaLink(ctx context.Context, db execer, statement string, ownerID, mediaID int64) error {
	result, err := db.Exec(ctx, statement, ownerID, mediaID)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return api.NewError(404, "NOT_FOUND", "Media link not found", nil)
	}
	return nil
}

func scanQuestionMediaLink(row interface{ Scan(...any) error }) (QuestionMediaLink, error) {
	var item QuestionMediaLink
	var createdAt time.Time
	if err := row.Scan(&item.ID, &item.QuestionID, &item.MediaID, &item.MediaKind, &item.SortOrder, &createdAt); err != nil {
		return QuestionMediaLink{}, err
	}
	item.CreatedAt = formatTimestamp(createdAt)
	return item, nil
}

func scanGroupMediaLink(row interface{ Scan(...any) error }) (GroupMediaLink, error) {
	var item GroupMediaLink
	var createdAt time.Time
	if err := row.Scan(&item.ID, &item.GroupID, &item.MediaID, &item.MediaKind, &item.SortOrder, &createdAt); err != nil {
		return GroupMediaLink{}, err
	}
	item.CreatedAt = formatTimestamp(createdAt)
	return item, nil
}

func scanOptionMediaLink(row interface{ Scan(...any) error }) (OptionMediaLink, error) {
	var item OptionMediaLink
	var createdAt time.Time
	if err := row.Scan(&item.ID, &item.OptionID, &item.MediaID, &item.MediaKind, &item.SortOrder, &createdAt); err != nil {
		return OptionMediaLink{}, err
	}
	item.CreatedAt = formatTimestamp(createdAt)
	return item, nil
}

func ensureQuestionEditableForMedia(ctx context.Context, db queryer, user auth.User, questionID int64) error {
	rows, err := db.Query(ctx, `
		SELECT q.id
		FROM questions q
		JOIN bank_question_links bql ON bql.question_id = q.id
		JOIN user_bank_links ubl ON ubl.bank_id = bql.bank_id
		WHERE q.id = $1
		  AND ubl.user_id = $2
		  AND ubl.is_owner = true
		LIMIT 1
	`, questionID, user.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	if !rows.Next() {
		return api.NewError(403, "FORBIDDEN", "Question editor access required", nil)
	}
	return rows.Err()
}

func ensureGroupEditableForMedia(ctx context.Context, db queryer, user auth.User, groupID int64) error {
	rows, err := db.Query(ctx, `
		SELECT g.id
		FROM question_groups g
		JOIN bank_group_links bgl ON bgl.group_id = g.id
		JOIN user_bank_links ubl ON ubl.bank_id = bgl.bank_id
		WHERE g.id = $1
		  AND ubl.user_id = $2
		  AND ubl.is_owner = true
		LIMIT 1
	`, groupID, user.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	if !rows.Next() {
		return api.NewError(403, "FORBIDDEN", "Group editor access required", nil)
	}
	return rows.Err()
}

func optionQuestionID(ctx context.Context, db queryer, optionID int64) (int64, error) {
	rows, err := db.Query(ctx, `
		SELECT question_id
		FROM question_options
		WHERE id = $1
		LIMIT 1
	`, optionID)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	if !rows.Next() {
		return 0, api.NewError(404, "NOT_FOUND", "Option not found", nil)
	}
	var questionID int64
	if err := rows.Scan(&questionID); err != nil {
		return 0, err
	}
	return questionID, rows.Err()
}

func linkSortOrder(value *int) int {
	if value == nil || *value < 1 {
		return 1
	}
	return *value
}
