package services

import (
	"encoding/base64"
	"errors"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"openwook/internal/api"
	"openwook/internal/auth"
)

func TestInsertSourceArtifactSQLRejectsDuplicatesWithoutReplacingThem(t *testing.T) {
	query := strings.ToUpper(strings.Join(strings.Fields(insertSourceArtifactSQL), " "))
	for _, fragment := range []string{
		"ON CONFLICT (JOB_ID)",
		"WHERE ARTIFACT_TYPE = 'SOURCE_FILE'",
		"DO NOTHING",
	} {
		if !strings.Contains(query, fragment) {
			t.Fatalf("source artifact SQL missing %q: %s", fragment, query)
		}
	}
}

func TestListImportJobEventsAfterSQLUsesAscendingCursorOrder(t *testing.T) {
	query := strings.ToUpper(strings.Join(strings.Fields(listImportJobEventsAfterSQL), " "))
	for _, fragment := range []string{"ID > $2", "ORDER BY ID", "LIMIT 1000"} {
		if !strings.Contains(query, fragment) {
			t.Fatalf("event backlog SQL missing %q: %s", fragment, query)
		}
	}
}

func TestExtractSourceTypeFromArtifactPrefersContentThenFallsBackToPath(t *testing.T) {
	tests := []struct {
		name        string
		storagePath string
		content     map[string]any
		want        string
	}{
		{name: "explicit source type wins", storagePath: "oss://openwook/questions.docx", content: map[string]any{"sourceType": "txt"}, want: "txt"},
		{name: "original name docx", content: map[string]any{"originalName": "source.docx"}, want: "docx"},
		{name: "storage path txt", storagePath: "oss://openwook/questions.txt", want: "txt"},
		{name: "unknown when neither hints match", storagePath: "oss://openwook/questions.bin", want: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := extractSourceTypeFromArtifact(tt.storagePath, tt.content); got != tt.want {
				t.Fatalf("extractSourceTypeFromArtifact(%q, %#v) = %q, want %q", tt.storagePath, tt.content, got, tt.want)
			}
		})
	}
}

func TestNormalizeImportSourceTypeMapsTextAndChecksEntitlement(t *testing.T) {
	freeUser := auth.User{ID: 7, Role: "user", Membership: "free"}
	plusUser := auth.User{ID: 8, Role: "user", Membership: "plus"}

	if got, err := normalizeImportSourceType(freeUser, "text"); err != nil || got != "txt" {
		t.Fatalf("normalizeImportSourceType(text) = (%q, %v), want (%q, nil)", got, err, "txt")
	}

	if got, err := normalizeImportSourceType(plusUser, "docx"); err != nil || got != "docx" {
		t.Fatalf("normalizeImportSourceType(docx) = (%q, %v), want (%q, nil)", got, err, "docx")
	}

	if got, err := normalizeImportSourceType(plusUser, "pdf"); err != nil || got != "pdf" {
		t.Fatalf("normalizeImportSourceType(pdf) = (%q, %v), want (%q, nil)", got, err, "pdf")
	}

	if got, err := normalizeImportSourceType(plusUser, "xlsx"); err != nil || got != "xlsx" {
		t.Fatalf("normalizeImportSourceType(xlsx) = (%q, %v), want (%q, nil)", got, err, "xlsx")
	}

	_, err := normalizeImportSourceType(freeUser, "xls")
	assertAPIError(t, err, http.StatusBadRequest, "UNSUPPORTED_SOURCE_TYPE")

	_, err = normalizeImportSourceType(freeUser, "pdf")
	assertAPIError(t, err, http.StatusForbidden, "PLUS_REQUIRED")

	_, err = normalizeImportSourceType(freeUser, "docx")
	assertAPIError(t, err, http.StatusForbidden, "PLUS_REQUIRED")
}

func TestQueueTransitionSpecMatchesImportStatusActions(t *testing.T) {
	tests := []struct {
		action string
		want   importQueueTransition
	}{
		{
			action: "retry",
			want: importQueueTransition{
				status:        "queued",
				stage:         "queued",
				stepCode:      "retry",
				stepLabel:     "重新排队",
				eventStatus:   "queued",
				available:     true,
				resetAttempts: true,
			},
		},
		{
			action: "cancel",
			want: importQueueTransition{
				status:      "cancelled",
				stage:       "cancelled",
				stepCode:    "cancel",
				stepLabel:   "取消任务",
				eventStatus: "cancelled",
				message:     new("任务已取消。"),
				completed:   true,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.action, func(t *testing.T) {
			got, err := queueTransitionForAction(tt.action)
			if err != nil {
				t.Fatalf("queueTransitionForAction(%q) returned error: %v", tt.action, err)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("queueTransitionForAction(%q) = %#v, want %#v", tt.action, got, tt.want)
			}
		})
	}
}

func TestParseQueueTransitionStoresPersistQuestions(t *testing.T) {
	for _, persist := range []bool{false, true} {
		got := queueTransitionForParse(persist)
		if !got.available || !got.resetAttempts || got.persistQuestions == nil || *got.persistQuestions != persist {
			t.Fatalf("queueTransitionForParse(%t) = %#v", persist, got)
		}
	}
}

func TestImportJobActionValidationRejectsUnsafeTransitions(t *testing.T) {
	for _, tt := range []struct {
		name   string
		job    ImportJob
		action string
		code   string
	}{
		{name: "cancel completed", job: ImportJob{Status: "completed"}, action: "cancel", code: "IMPORT_ALREADY_COMPLETED"},
		{name: "retry queued", job: ImportJob{Status: "queued"}, action: "retry", code: "IMPORT_RETRY_NOT_ALLOWED"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			err := ensureImportJobQueueActionAllowed(tt.job, tt.action)
			if err == nil {
				t.Fatal("error = nil")
			}
			_, code, _, _ := api.ValidationErrorEnvelope(err)
			if code != tt.code {
				t.Fatalf("error code = %q, want %q", code, tt.code)
			}
		})
	}
	if err := ensureImportJobQueueActionAllowed(ImportJob{Status: "processing"}, "cancel"); err != nil {
		t.Fatalf("processing cancel returned error: %v", err)
	}
}

func TestBuildImportSourceArtifactContentStripsUTF8BOMForTXT(t *testing.T) {
	stored := storedImportSource{
		RelativePath: "imports/7/11/source.txt",
		ObjectURL:    "oss://openwook/imports/7/11/source.txt",
		OriginalName: "source.txt",
		MimeType:     "text/plain",
		SizeBytes:    26,
	}

	got := buildImportSourceArtifactContent(stored, "txt", []byte("\ufeff1. Uploaded question\n答案: A"))
	text, ok := got["text"].(string)
	if !ok {
		t.Fatalf("artifact content text = %#v, want string", got["text"])
	}
	if text != "1. Uploaded question\n答案: A" {
		t.Fatalf("artifact content text = %q, want BOM-stripped text", text)
	}
	if got["objectKey"] != stored.RelativePath {
		t.Fatalf("artifact content objectKey = %#v, want %q", got["objectKey"], stored.RelativePath)
	}
	if got["sourceType"] != "txt" {
		t.Fatalf("artifact content sourceType = %#v, want txt", got["sourceType"])
	}
}

func TestBuildImportSourceArtifactContentStoresDOCXBase64(t *testing.T) {
	payload := []byte("PK\x03\x04docx")
	got := buildImportSourceArtifactContent(storedImportSource{
		RelativePath: "imports/7/11/source.docx",
		ObjectURL:    "oss://openwook/imports/7/11/source.docx",
		OriginalName: "source.docx",
		MimeType:     docxMimeType,
		SizeBytes:    int64(len(payload)),
	}, "docx", payload)

	if got["fileBase64"] != base64.StdEncoding.EncodeToString(payload) {
		t.Fatalf("artifact fileBase64 = %#v, want encoded DOCX bytes", got["fileBase64"])
	}
	if _, exists := got["text"]; exists {
		t.Fatalf("DOCX artifact unexpectedly contains text: %#v", got)
	}
}

func TestDecodeBoundedImportBase64RejectsInvalidAndOversizedContent(t *testing.T) {
	if _, err := decodeBoundedImportBase64("not-base64", 10); err == nil {
		t.Fatal("invalid base64 error = nil")
	}
	if _, err := decodeBoundedImportBase64(base64.StdEncoding.EncodeToString([]byte("12345")), 4); err == nil {
		t.Fatal("oversized decoded payload error = nil")
	}
}

func TestValidateImportArtifactContentRequiresConsumableDOCXBytes(t *testing.T) {
	err := validateImportArtifactContent("docx", map[string]any{"mimeType": docxMimeType})
	assertAPIError(t, err, http.StatusBadRequest, "FILE_REQUIRED")

	err = validateImportArtifactContent("docx", map[string]any{
		"fileBase64": base64.StdEncoding.EncodeToString([]byte("PK\x03\x04docx")),
		"mimeType":   docxMimeType,
	})
	if err != nil {
		t.Fatalf("valid DOCX artifact error = %v", err)
	}
}

func TestValidateImportArtifactContentRejectsUnusableTXT(t *testing.T) {
	for _, content := range []map[string]any{
		{"text": " \n\t "},
		{"text": "\ufeff"},
		{"fileBase64": base64.StdEncoding.EncodeToString([]byte{0xff, 0xfe})},
	} {
		if err := validateImportArtifactContent("txt", content); err == nil {
			t.Fatalf("validateImportArtifactContent(txt, %#v) error = nil", content)
		}
	}
}

func assertAPIError(t *testing.T, err error, wantStatus int, wantCode string) {
	t.Helper()
	if err == nil {
		t.Fatalf("error = nil, want status=%d code=%q", wantStatus, wantCode)
	}
	var apiErr *api.Error
	if !errors.As(err, &apiErr) {
		t.Fatalf("error = %T, want *api.Error", err)
	}
	if apiErr.Status != wantStatus || apiErr.Code != wantCode {
		t.Fatalf("api error = (%d, %q), want (%d, %q)", apiErr.Status, apiErr.Code, wantStatus, wantCode)
	}
}
