package services

import (
	"encoding/base64"
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
	status           string
	stage            string
	stepCode         string
	stepLabel        string
	eventStatus      string
	message          *string
	completed        bool
	available        bool
	resetAttempts    bool
	persistQuestions *bool
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
	case "docx", "pdf", "xlsx":
		if user.Membership == "plus" || user.Membership == "enterprise" || user.Role == "admin" {
			return normalized, nil
		}
		return "", api.NewError(403, "PLUS_REQUIRED", "DOCX, PDF, and XLSX uploads require Plus or Enterprise membership", nil)
	default:
		return "", api.NewError(400, "UNSUPPORTED_SOURCE_TYPE", "Only txt, docx, pdf, and xlsx imports are supported", nil)
	}
}

func queueTransitionForAction(action string) (importQueueTransition, error) {
	switch action {
	case "retry":
		return importQueueTransition{status: "queued", stage: "queued", stepCode: "retry", stepLabel: "重新排队", eventStatus: "queued", available: true, resetAttempts: true}, nil
	case "cancel":
		return importQueueTransition{status: "cancelled", stage: "cancelled", stepCode: "cancel", stepLabel: "取消任务", eventStatus: "cancelled", message: new("任务已取消。"), completed: true}, nil
	default:
		return importQueueTransition{}, api.NewError(400, "INVALID_IMPORT_ACTION", "Unsupported import action", nil)
	}
}

func queueTransitionForParse(persistQuestions bool) importQueueTransition {
	return importQueueTransition{
		status:           "queued",
		stage:            "queued",
		stepCode:         "queue_parse",
		stepLabel:        "加入导入队列",
		eventStatus:      "queued",
		available:        true,
		resetAttempts:    true,
		persistQuestions: &persistQuestions,
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
	} else if sourceType == "docx" {
		content["fileBase64"] = base64.StdEncoding.EncodeToString(payload)
	}
	return content
}

func validateImportArtifactContent(sourceType string, content map[string]any) error {
	if sourceType == "docx" {
		raw, _ := content["fileBase64"].(string)
		if strings.TrimSpace(raw) == "" {
			return api.NewError(400, "FILE_REQUIRED", "DOCX artifacts require fileBase64", nil)
		}
		payload, err := decodeBoundedImportBase64(raw, importSourceMaxBytes)
		if err != nil {
			return err
		}
		mime, _ := content["mimeType"].(string)
		name, _ := content["originalName"].(string)
		return validateImportSourcePayload(".docx", mime, payload, firstNonEmpty(name, "source.docx"))
	}

	totalBytes := 0
	found := false
	if rawText, exists := content["text"]; exists {
		text, ok := rawText.(string)
		if !ok {
			return api.NewError(400, "INVALID_FILE_CONTENT", "text must be a string", nil)
		}
		if len(text) > importSourceMaxBytes {
			return api.NewError(413, "FILE_TOO_LARGE", "Import content exceeds the 25 MiB limit", nil)
		}
		if err := validateImportSourcePayload(".txt", "text/plain", []byte(text), "source.txt"); err != nil {
			return err
		}
		totalBytes += len(text)
		found = true
	}
	if rawFile, exists := content["fileBase64"]; exists {
		raw, ok := rawFile.(string)
		if !ok {
			return api.NewError(400, "INVALID_FILE_CONTENT", "fileBase64 must be a string", nil)
		}
		payload, err := decodeBoundedImportBase64(raw, importSourceMaxBytes)
		if err != nil {
			return err
		}
		if err := validateImportSourcePayload(".txt", "text/plain", payload, "source.txt"); err != nil {
			return err
		}
		totalBytes += len(payload)
		found = true
	}
	if !found {
		return api.NewError(400, "FILE_REQUIRED", "TXT artifacts require text or fileBase64", nil)
	}
	if totalBytes > importSourceMaxBytes {
		return api.NewError(413, "FILE_TOO_LARGE", "Import content exceeds the 25 MiB limit", nil)
	}
	return nil
}

func decodeBoundedImportBase64(raw string, maxBytes int) ([]byte, error) {
	if base64.StdEncoding.DecodedLen(len(raw)) > maxBytes+2 {
		return nil, api.NewError(413, "FILE_TOO_LARGE", "Import content exceeds the 25 MiB limit", nil)
	}
	payload, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return nil, api.NewError(400, "INVALID_FILE_CONTENT", "fileBase64 must contain valid base64", nil)
	}
	if len(payload) == 0 {
		return nil, api.NewError(400, "EMPTY_FILE", "Uploaded file is empty", nil)
	}
	if len(payload) > maxBytes {
		return nil, api.NewError(413, "FILE_TOO_LARGE", "Import content exceeds the 25 MiB limit", nil)
	}
	return payload, nil
}

func sourceTypeFromName(value string) string {
	lower := strings.ToLower(value)
	for _, kind := range []string{"docx", "pdf", "xlsx", "txt"} {
		if strings.HasSuffix(lower, "."+kind) {
			return kind
		}
	}
	return ""
}
