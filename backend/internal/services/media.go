package services

import (
	"context"
	"time"

	"openwook/internal/api"
	"openwook/internal/auth"
	"openwook/internal/redisx"
)

type MediaAsset struct {
	ID           int64   `json:"id"`
	StoragePath  string  `json:"storage_path"`
	StorageDisk  string  `json:"storage_disk"`
	ExternalURL  *string `json:"external_url"`
	OriginalName *string `json:"original_name"`
	MimeType     *string `json:"mime_type"`
	Width        *int64  `json:"width"`
	Height       *int64  `json:"height"`
	SizeBytes    *int64  `json:"size_bytes"`
	DurationMS   *int64  `json:"duration_ms"`
	CreatedAt    string  `json:"created_at"`
}

type CreateMediaAssetInput struct {
	StoragePath  string  `json:"storage_path"`
	ExternalURL  *string `json:"external_url"`
	OriginalName *string `json:"original_name"`
	MimeType     *string `json:"mime_type"`
	SizeBytes    *int64  `json:"size_bytes"`
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

func CreateMediaAsset(ctx context.Context, db queryer, input CreateMediaAssetInput) (*MediaAsset, error) {
	rows, err := db.Query(ctx, `
		INSERT INTO media_assets (storage_path, external_url, original_name, mime_type, size_bytes)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, storage_path, storage_disk, external_url, original_name, mime_type, width, height, size_bytes, duration_ms, created_at
	`, input.StoragePath, nullableStringPointer(input.ExternalURL), nullableStringPointer(input.OriginalName), nullableStringPointer(input.MimeType), nullableInt64Pointer(input.SizeBytes))
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

func GetMediaAsset(ctx context.Context, db queryer, _ auth.User, mediaID int64) (*MediaAsset, error) {
	rows, err := db.Query(ctx, `
		SELECT id, storage_path, storage_disk, external_url, original_name, mime_type, width, height, size_bytes, duration_ms, created_at
		FROM media_assets
		WHERE id = $1
		LIMIT 1
	`, mediaID)
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

func DeleteMediaAsset(ctx context.Context, db execer, _ auth.User, mediaID int64) error {
	_, err := db.Exec(ctx, `DELETE FROM media_assets WHERE id = $1`, mediaID)
	return err
}

func LinkQuestionMedia(ctx context.Context, db queryer, user auth.User, questionID int64, input MediaLinkInput) (*QuestionMediaLink, error) {
	if err := ensureQuestionEditableForMedia(ctx, db, user, questionID); err != nil {
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
	invalidateQuestionCachesForMedia(ctx, db, questionID)
	return &item, rows.Err()
}

func LinkGroupMedia(ctx context.Context, db queryer, user auth.User, groupID int64, input MediaLinkInput) (*GroupMediaLink, error) {
	if err := ensureGroupEditableForMedia(ctx, db, user, groupID); err != nil {
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
	invalidateGroupBankCaches(ctx, db, groupID)
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
	invalidateQuestionCachesForMedia(ctx, db, questionID)
	return &item, rows.Err()
}

func scanMediaAsset(row interface{ Scan(...any) error }) (MediaAsset, error) {
	var item MediaAsset
	var createdAt time.Time
	if err := row.Scan(&item.ID, &item.StoragePath, &item.StorageDisk, &item.ExternalURL, &item.OriginalName, &item.MimeType, &item.Width, &item.Height, &item.SizeBytes, &item.DurationMS, &createdAt); err != nil {
		return MediaAsset{}, err
	}
	item.CreatedAt = formatTimestamp(createdAt)
	return item, nil
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

func invalidateQuestionCachesForMedia(ctx context.Context, db queryer, questionID int64) {
	if rdb := redisx.Client(); rdb != nil {
		redisx.Delete(ctx, rdb, redisx.RedisKey("cache", "answer-key", questionID))
	}
	bumpSliceCacheVersion(ctx, "question", questionID)
	rows, err := db.Query(ctx, `
		SELECT bank_id FROM bank_question_links WHERE question_id = $1
		UNION
		SELECT bgl.bank_id
		FROM bank_group_links bgl
		JOIN group_question_links gql ON gql.group_id = bgl.group_id
		WHERE gql.question_id = $1
	`, questionID)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var bankID int64
		if err := rows.Scan(&bankID); err == nil {
			bumpSliceCacheVersion(ctx, "bank", bankID)
			bumpSliceCacheVersion(ctx, "bank-items", bankID)
			bumpSliceCacheVersion(ctx, "bank-practice-summary", bankID)
		}
	}
}

func invalidateGroupBankCaches(ctx context.Context, db queryer, groupID int64) {
	rows, err := db.Query(ctx, `SELECT bank_id FROM bank_group_links WHERE group_id = $1`, groupID)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var bankID int64
		if err := rows.Scan(&bankID); err == nil {
			bumpSliceCacheVersion(ctx, "bank", bankID)
			bumpSliceCacheVersion(ctx, "bank-items", bankID)
			bumpSliceCacheVersion(ctx, "bank-practice-summary", bankID)
		}
	}
}

func linkSortOrder(value *int) int {
	if value == nil || *value < 1 {
		return 1
	}
	return *value
}
