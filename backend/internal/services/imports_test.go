package services

import (
	"errors"
	"net/http"
	"reflect"
	"testing"

	"openwook/internal/api"
	"openwook/internal/auth"
)

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

	_, err := normalizeImportSourceType(freeUser, "pdf")
	assertAPIError(t, err, http.StatusBadRequest, "UNSUPPORTED_SOURCE_TYPE")

	_, err = normalizeImportSourceType(freeUser, "docx")
	assertAPIError(t, err, http.StatusForbidden, "PLUS_REQUIRED")
}

func TestQueueTransitionSpecMatchesImportStatusActions(t *testing.T) {
	tests := []struct {
		action string
		want   importQueueTransition
	}{
		{
			action: "start",
			want: importQueueTransition{
				status:         "queued",
				stage:          "queued",
				stepCode:       "start",
				stepLabel:      "加入导入队列",
				eventStatus:    "queued",
				retryIncrement: 0,
			},
		},
		{
			action: "retry",
			want: importQueueTransition{
				status:         "queued",
				stage:          "queued",
				stepCode:       "retry",
				stepLabel:      "重新排队",
				eventStatus:    "queued",
				retryIncrement: 1,
			},
		},
		{
			action: "cancel",
			want: importQueueTransition{
				status:         "failed",
				stage:          "failed",
				stepCode:       "cancel",
				stepLabel:      "取消任务",
				eventStatus:    "failed",
				message:        new("任务已取消。"),
				retryIncrement: 0,
				completed:      true,
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
