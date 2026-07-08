package services

import (
	"strings"

	"openwook/internal/api"
	"openwook/internal/auth"
)

type storedImportSource struct {
	RelativePath string
	ObjectURL    string
	OriginalName string
	MimeType     string
	SizeBytes    int64
}

type importQueueTransition struct {
	status         string
	stage          string
	stepCode       string
	stepLabel      string
	eventStatus    string
	message        *string
	retryIncrement int
	completed      bool
}

func extractSourceTypeFromArtifact(storagePath string, content map[string]any) string {
	if value, ok := content["sourceType"].(string); ok && strings.TrimSpace(value) != "" {
		return strings.ToLower(strings.TrimSpace(value))
	}
	if value, ok := content["originalName"].(string); ok {
		if kind := sourceTypeFromName(value); kind != "" {
			return kind
		}
	}
	return sourceTypeFromName(storagePath)
}

func normalizeImportSourceType(user auth.User, value string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" {
		normalized = "txt"
	}
	switch normalized {
	case "text", "txt":
		return "txt", nil
	case "docx":
		if user.Membership == "plus" || user.Membership == "enterprise" || user.Role == "admin" {
			return "docx", nil
		}
		return "", api.NewError(403, "PLUS_REQUIRED", "DOCX upload requires Plus or Enterprise membership", nil)
	default:
		return "", api.NewError(400, "UNSUPPORTED_SOURCE_TYPE", "Only txt and docx imports are supported", nil)
	}
}

func queueTransitionForAction(action string) (importQueueTransition, error) {
	switch action {
	case "start":
		return importQueueTransition{status: "queued", stage: "queued", stepCode: "start", stepLabel: "加入导入队列", eventStatus: "queued"}, nil
	case "retry":
		return importQueueTransition{status: "queued", stage: "queued", stepCode: "retry", stepLabel: "重新排队", eventStatus: "queued", retryIncrement: 1}, nil
	case "cancel":
		return importQueueTransition{status: "failed", stage: "failed", stepCode: "cancel", stepLabel: "取消任务", eventStatus: "failed", message: new("任务已取消。"), completed: true}, nil
	default:
		return importQueueTransition{}, api.NewError(400, "INVALID_IMPORT_ACTION", "Unsupported import action", nil)
	}
}

func buildImportSourceArtifactContent(stored storedImportSource, sourceType string, payload []byte) map[string]any {
	content := map[string]any{
		"objectUrl":    stored.ObjectURL,
		"objectKey":    stored.RelativePath,
		"originalName": stored.OriginalName,
		"mimeType":     stored.MimeType,
		"sizeBytes":    stored.SizeBytes,
		"sourceType":   sourceType,
	}
	if sourceType == "txt" || sourceType == "text" {
		content["text"] = strings.TrimPrefix(string(payload), "\ufeff")
	}
	return content
}

func sourceTypeFromName(value string) string {
	lower := strings.ToLower(value)
	if strings.HasSuffix(lower, ".docx") {
		return "docx"
	}
	if strings.HasSuffix(lower, ".txt") {
		return "txt"
	}
	return ""
}
