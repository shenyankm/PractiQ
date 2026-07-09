package services

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"openwook/internal/api"
	"openwook/internal/auth"
)

const (
	defaultObjectStorageMountDir = "/lhcos-data"
	defaultObjectStoragePrefix   = "oss://openwook"
	importSourceMaxBytes         = 25 * 1024 * 1024
	docxMimeType                 = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)

var genericUploadMimeTypes = map[string]bool{
	"application/octet-stream": true,
	"binary/octet-stream":      true,
}

type UploadedImportFile struct {
	Name        string
	ContentType string
	Content     []byte
}

func AddImportJobUploadedFile(ctx context.Context, pool *pgxpool.Pool, user auth.User, jobID int64, file UploadedImportFile) (map[string]any, error) {
	job, err := GetImportJob(ctx, pool, user, jobID)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(file.Name) == "" {
		return nil, api.NewError(400, "FILE_REQUIRED", "Upload file is required", nil)
	}

	stored, payload, err := storeImportSourceFile(user.ID, jobID, file)
	if err != nil {
		return nil, err
	}
	inferredSourceType := inferUploadedSourceType(file)
	jobSourceType := ""
	if job.SourceType != nil {
		jobSourceType = *job.SourceType
	}
	if inferredSourceType == "" {
		inferredSourceType = jobSourceType
	}
	sourceType, err := normalizeImportSourceType(user, inferredSourceType)
	if err != nil {
		return nil, err
	}
	content := buildImportSourceArtifactContent(stored, sourceType, payload)
	rawContent, err := marshalJSONString(content)
	if err != nil {
		return nil, err
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	if _, err := queryImportJobTx(ctx, tx, `
		WITH updated AS (
			UPDATE question_import_jobs
			SET source_type = $1, file_name = COALESCE(file_name, $2)
			WHERE id = $3
			RETURNING *
		)
		SELECT row_to_json(updated)::text FROM updated
	`, sourceType, stored.OriginalName, jobID); err != nil {
		return nil, err
	}

	artifact, err := queryJSONMapTx(ctx, tx, `
		WITH inserted AS (
			INSERT INTO question_import_job_artifacts (job_id, artifact_type, storage_path, content_json)
			VALUES ($1, 'source_file', $2, $3)
			RETURNING *
		)
		SELECT row_to_json(inserted)::text FROM inserted
	`, jobID, stored.ObjectURL, rawContent)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return artifact, nil
}

func storeImportSourceFile(userID int, jobID int64, file UploadedImportFile) (storedImportSource, []byte, error) {
	payload := file.Content
	if len(payload) == 0 {
		return storedImportSource{}, nil, api.NewError(400, "EMPTY_FILE", "Uploaded file is empty", nil)
	}
	if len(payload) > importSourceMaxBytes {
		return storedImportSource{}, nil, api.NewError(413, "FILE_TOO_LARGE", fmt.Sprintf("Uploaded file exceeds %d bytes", importSourceMaxBytes), nil)
	}

	extension, err := resolveImportFileExtension(file.Name, file.ContentType)
	if err != nil {
		return storedImportSource{}, nil, err
	}
	if err := validateImportSourcePayload(extension, file.ContentType, payload, file.Name); err != nil {
		return storedImportSource{}, nil, err
	}

	directory := filepath.Join("imports", sanitizeStorageSegment(fmt.Sprint(userID)), sanitizeStorageSegment(fmt.Sprint(jobID)))
	fileName, err := uniqueImportFileName(extension)
	if err != nil {
		return storedImportSource{}, nil, err
	}
	relativePath := filepath.ToSlash(filepath.Join(directory, fileName))
	absolutePath, err := resolveStoragePath(relativePath)
	if err != nil {
		return storedImportSource{}, nil, err
	}
	if err := os.MkdirAll(filepath.Dir(absolutePath), 0o755); err != nil {
		return storedImportSource{}, nil, err
	}
	if err := os.WriteFile(absolutePath, payload, 0o600); err != nil {
		return storedImportSource{}, nil, err
	}

	return storedImportSource{
		RelativePath: relativePath,
		ObjectURL:    objectURLForRelativePath(relativePath),
		OriginalName: file.Name,
		MimeType:     normalizeImportMimeType(extension, file.ContentType),
		SizeBytes:    int64(len(payload)),
	}, payload, nil
}

func inferUploadedSourceType(file UploadedImportFile) string {
	if kind := sourceTypeFromName(file.Name); kind != "" {
		return kind
	}
	switch strings.ToLower(strings.TrimSpace(file.ContentType)) {
	case docxMimeType:
		return "docx"
	case "text/plain":
		return "txt"
	default:
		return ""
	}
}

func resolveImportFileExtension(name string, contentType string) (string, error) {
	extension := strings.ToLower(filepath.Ext(strings.TrimSpace(name)))
	if extension == ".txt" || extension == ".docx" {
		return extension, nil
	}
	switch strings.ToLower(strings.TrimSpace(contentType)) {
	case docxMimeType:
		return ".docx", nil
	case "text/plain":
		return ".txt", nil
	default:
		return "", api.NewError(400, "UNSUPPORTED_FILE_TYPE", fmt.Sprintf("Unsupported file type: %s", strings.TrimSpace(name)), nil)
	}
}

func validateImportSourcePayload(extension string, contentType string, payload []byte, originalName string) error {
	mime := strings.ToLower(strings.TrimSpace(contentType))
	if mime != "" && !genericUploadMimeTypes[mime] {
		if extension == ".txt" && mime != "text/plain" {
			return api.NewError(400, "UNSUPPORTED_FILE_TYPE", fmt.Sprintf("Unsupported file type: %s", originalName), nil)
		}
		if extension == ".docx" && mime != docxMimeType {
			return api.NewError(400, "UNSUPPORTED_FILE_TYPE", fmt.Sprintf("Unsupported file type: %s", originalName), nil)
		}
	}
	if extension == ".txt" {
		for _, value := range payload {
			if value == 0 {
				return api.NewError(400, "UNSUPPORTED_FILE_TYPE", "TXT files must be plain text", nil)
			}
		}
		return nil
	}
	if len(payload) < 2 || string(payload[:2]) != "PK" {
		return api.NewError(400, "UNSUPPORTED_FILE_TYPE", "DOCX files must be valid Office Open XML documents", nil)
	}
	return nil
}

func uniqueImportFileName(extension string) (string, error) {
	randomBytes := make([]byte, 8)
	if _, err := rand.Read(randomBytes); err != nil {
		return "", err
	}
	return fmt.Sprintf("source-%d-%s%s", time.Now().UnixMilli(), hex.EncodeToString(randomBytes), extension), nil
}

func resolveStoragePath(relativePath string) (string, error) {
	mountDir := strings.TrimSpace(firstNonEmpty(os.Getenv("OBJECT_STORAGE_MOUNT_DIR"), os.Getenv("OSS_MOUNT_DIR"), defaultObjectStorageMountDir))
	cleanRelative := cleanStorageRelativePath(relativePath)
	if cleanRelative == "" {
		return "", api.NewError(400, "INVALID_STORAGE_PATH", "Storage path is empty", nil)
	}
	absolutePath := filepath.Clean(filepath.Join(mountDir, filepath.FromSlash(cleanRelative)))
	cleanMount := filepath.Clean(mountDir)
	if absolutePath != cleanMount && !strings.HasPrefix(absolutePath, cleanMount+string(os.PathSeparator)) {
		return "", api.NewError(400, "INVALID_STORAGE_PATH", "Invalid object storage path", nil)
	}
	return absolutePath, nil
}

func objectURLForRelativePath(relativePath string) string {
	base := strings.TrimRight(strings.TrimSpace(os.Getenv("OSS_PUBLIC_BASE_URL")), "/")
	cleanRelative := cleanStorageRelativePath(relativePath)
	if base != "" {
		return base + "/" + cleanRelative
	}
	prefix := strings.TrimRight(strings.TrimSpace(firstNonEmpty(os.Getenv("OSS_URL_PREFIX"), defaultObjectStoragePrefix)), "/")
	return prefix + "/" + cleanRelative
}

func normalizeImportMimeType(extension string, contentType string) string {
	trimmed := strings.TrimSpace(contentType)
	if trimmed != "" {
		return trimmed
	}
	if extension == ".docx" {
		return docxMimeType
	}
	return "text/plain"
}

func cleanStorageRelativePath(value string) string {
	segments := strings.Split(strings.ReplaceAll(value, "\\", "/"), "/")
	cleaned := make([]string, 0, len(segments))
	for _, segment := range segments {
		sanitized := sanitizeStorageSegment(segment)
		if sanitized == "" {
			continue
		}
		cleaned = append(cleaned, sanitized)
	}
	return strings.Join(cleaned, "/")
}

func sanitizeStorageSegment(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || trimmed == "." || trimmed == ".." {
		return ""
	}
	replacer := strings.NewReplacer(
		" ", "-",
		"/", "-",
		"\\", "-",
		":", "-",
		"?", "-",
		"#", "-",
	)
	sanitized := replacer.Replace(trimmed)
	builder := strings.Builder{}
	lastDash := false
	for _, r := range sanitized {
		allowed := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-'
		if !allowed {
			r = '-'
		}
		if r == '-' {
			if lastDash {
				continue
			}
			lastDash = true
		} else {
			lastDash = false
		}
		builder.WriteRune(r)
	}
	return strings.Trim(builder.String(), "-. ")
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
