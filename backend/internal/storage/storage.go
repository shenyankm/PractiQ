package storage

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	defaultMountDir      = "/lhcos-data"
	defaultURLPrefix     = "oss://openwook"
	avatarMaxBytes       = 5 * 1024 * 1024
	importSourceMaxBytes = 25 * 1024 * 1024
)

var safePathPattern = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

func objectStorageMountDir() string {
	return strings.TrimSpace(firstNonEmpty(os.Getenv("OBJECT_STORAGE_MOUNT_DIR"), os.Getenv("OSS_MOUNT_DIR"), defaultMountDir))
}

func objectStoragePublicBaseURL() string {
	return strings.TrimRight(strings.TrimSpace(firstNonEmpty(os.Getenv("OSS_PUBLIC_BASE_URL"), os.Getenv("OBJECT_STORAGE_PUBLIC_BASE_URL"))), "/")
}

func objectStorageURLPrefix() string {
	return strings.TrimRight(strings.TrimSpace(firstNonEmpty(os.Getenv("OSS_URL_PREFIX"), os.Getenv("OBJECT_STORAGE_URL_PREFIX"), defaultURLPrefix)), "/")
}

func validateAvatarSize(size int64) error {
	if size > avatarMaxBytes {
		return fmt.Errorf("avatar exceeds %d bytes", avatarMaxBytes)
	}
	return nil
}

func validateImportSourceSize(size int64) error {
	if size > importSourceMaxBytes {
		return fmt.Errorf("import source exceeds %d bytes", importSourceMaxBytes)
	}
	return nil
}

func validateImportSourceExtension(fileName string) error {
	extension := strings.ToLower(filepath.Ext(fileName))
	if extension != ".txt" && extension != ".docx" {
		return fmt.Errorf("unsupported import source extension %q", extension)
	}
	return nil
}

func validateFileSignature(extension string, payload []byte) error {
	if extension == ".docx" && (len(payload) < 2 || string(payload[:2]) != "PK") {
		return fmt.Errorf("DOCX files must start with PK")
	}
	if extension == ".txt" {
		for _, value := range payload {
			if value == 0 {
				return fmt.Errorf("TXT files must not contain null bytes")
			}
		}
	}
	return nil
}

func sanitizePathSegment(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "." || trimmed == ".." {
		return ""
	}
	sanitized := safePathPattern.ReplaceAllString(trimmed, "-")
	sanitized = strings.Trim(sanitized, "-. ")
	sanitized = strings.ReplaceAll(sanitized, "--", "-")
	return sanitized
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
