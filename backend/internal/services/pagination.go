package services

import (
	"encoding/base64"
	"strconv"
	"strings"

	"openwook/internal/api"
)

type PageInfo struct {
	Cursor  string
	Limit   int
	HasMore bool
}

type Page[T any] struct {
	Items []T
	PageInfo
}

func parsePageCursor(value string) (int, error) {
	if strings.TrimSpace(value) == "" {
		return 0, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return 0, api.ValidationError([]api.ValidationDetail{{Field: "cursor", Message: "is invalid"}})
	}
	offset, err := strconv.Atoi(string(decoded))
	if err != nil || offset < 0 {
		return 0, api.ValidationError([]api.ValidationDetail{{Field: "cursor", Message: "is invalid"}})
	}
	return offset, nil
}

func parsePageLimit(value string, fallback, maximum int) (int, error) {
	if strings.TrimSpace(value) == "" {
		return fallback, nil
	}
	limit, err := strconv.Atoi(value)
	if err != nil || limit < 1 || limit > maximum {
		return 0, api.ValidationError([]api.ValidationDetail{{Field: "limit", Message: "is invalid"}})
	}
	return limit, nil
}

func buildPage[T any](items []T, limit, offset int) Page[T] {
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	next := ""
	if hasMore {
		// ponytail: opaque offset cursors are enough at the current 100-row page cap;
		// switch to per-query keysets if deep paging becomes measurable.
		next = base64.RawURLEncoding.EncodeToString([]byte(strconv.Itoa(offset + limit)))
	}
	return Page[T]{
		Items: items,
		PageInfo: PageInfo{
			Cursor:  next,
			Limit:   limit,
			HasMore: hasMore,
		},
	}
}
