package storage

import "testing"

func TestObjectStorageDefaults(t *testing.T) {
	resetStorageEnv(t)

	if got := objectStorageMountDir(); got != "/lhcos-data" {
		t.Fatalf("objectStorageMountDir() = %q, want %q", got, "/lhcos-data")
	}
	if got := objectStoragePublicBaseURL(); got != "" {
		t.Fatalf("objectStoragePublicBaseURL() = %q, want empty string by default", got)
	}
	if got := objectStorageURLPrefix(); got != "oss://openwook" {
		t.Fatalf("objectStorageURLPrefix() = %q, want %q", got, "oss://openwook")
	}
}

func TestValidateAvatarSizeLimit(t *testing.T) {
	tests := []struct {
		name    string
		size    int64
		wantErr bool
	}{
		{name: "at limit", size: 5 * 1024 * 1024},
		{name: "above limit", size: 5*1024*1024 + 1, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateAvatarSize(tt.size)
			if tt.wantErr && err == nil {
				t.Fatalf("validateAvatarSize(%d) returned nil error, want error", tt.size)
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("validateAvatarSize(%d) returned error: %v", tt.size, err)
			}
		})
	}
}

func TestValidateImportSourceSizeLimit(t *testing.T) {
	tests := []struct {
		name    string
		size    int64
		wantErr bool
	}{
		{name: "at limit", size: 25 * 1024 * 1024},
		{name: "above limit", size: 25*1024*1024 + 1, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateImportSourceSize(tt.size)
			if tt.wantErr && err == nil {
				t.Fatalf("validateImportSourceSize(%d) returned nil error, want error", tt.size)
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("validateImportSourceSize(%d) returned error: %v", tt.size, err)
			}
		})
	}
}

func TestValidateImportSourceExtension(t *testing.T) {
	tests := []struct {
		name     string
		fileName string
		wantErr  bool
	}{
		{name: "txt", fileName: "questions.txt"},
		{name: "docx", fileName: "questions.docx"},
		{name: "unsupported", fileName: "questions.pdf", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateImportSourceExtension(tt.fileName)
			if tt.wantErr && err == nil {
				t.Fatalf("validateImportSourceExtension(%q) returned nil error, want error", tt.fileName)
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("validateImportSourceExtension(%q) returned error: %v", tt.fileName, err)
			}
		})
	}
}

func TestValidateFileSignature(t *testing.T) {
	tests := []struct {
		name      string
		extension string
		payload   []byte
		wantErr   bool
	}{
		{name: "docx zip header", extension: ".docx", payload: []byte("PK\x03\x04")},
		{name: "docx wrong header", extension: ".docx", payload: []byte("not a docx"), wantErr: true},
		{name: "txt plain text", extension: ".txt", payload: []byte("plain text")},
		{name: "txt with null byte", extension: ".txt", payload: []byte{65, 0, 66}, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateFileSignature(tt.extension, tt.payload)
			if tt.wantErr && err == nil {
				t.Fatalf("validateFileSignature(%q, %v) returned nil error, want error", tt.extension, tt.payload)
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("validateFileSignature(%q, %v) returned error: %v", tt.extension, tt.payload, err)
			}
		})
	}
}

func TestSanitizePathSegment(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "keeps safe characters", input: "File_Name-01.txt", want: "File_Name-01.txt"},
		{name: "replaces unsafe characters", input: "banks:夏? 01", want: "banks-01"},
		{name: "drops dot directory", input: "..", want: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := sanitizePathSegment(tt.input); got != tt.want {
				t.Fatalf("sanitizePathSegment(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func resetStorageEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"OBJECT_STORAGE_MOUNT_DIR",
		"OSS_MOUNT_DIR",
		"OSS_PUBLIC_BASE_URL",
		"OBJECT_STORAGE_PUBLIC_BASE_URL",
		"OSS_URL_PREFIX",
		"OBJECT_STORAGE_URL_PREFIX",
	} {
		t.Setenv(key, "")
	}
}
