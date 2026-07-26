package services

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"openwook/internal/api"
	"openwook/internal/auth"
)

func TestSetUserStatusRejectsSelfDisable(t *testing.T) {
	_, err := SetUserStatus(context.Background(), nil, auth.User{ID: 9, Role: "admin"}, 9, false)
	if err == nil {
		t.Fatal("SetUserStatus returned nil error, want conflict")
	}
	status, code, message, _ := api.ValidationErrorEnvelope(err)
	if status != 409 || code != "INVALID_STATE" || !strings.Contains(message, "cannot disable") {
		t.Fatalf("error = (%d, %s, %s), want 409 INVALID_STATE self-disable", status, code, message)
	}
}

func TestUpdateUserAccessRejectsSelfDemotion(t *testing.T) {
	_, err := UpdateUserAccess(context.Background(), nil, auth.User{ID: 9, Role: "admin"}, 9, UserAccessUpdate{Role: new("user")})
	if err == nil {
		t.Fatal("UpdateUserAccess returned nil error, want conflict")
	}
	status, code, message, _ := api.ValidationErrorEnvelope(err)
	if status != 409 || code != "INVALID_STATE" || !strings.Contains(message, "admin role") {
		t.Fatalf("error = (%d, %s, %s), want 409 INVALID_STATE self-demotion", status, code, message)
	}
}

func TestLinkOptionMediaRejectsMissingOption(t *testing.T) {
	_, err := LinkOptionMedia(context.Background(), emptyQueryer{}, auth.User{ID: 5}, 99, MediaLinkInput{MediaID: 8, MediaKind: "image"})
	if err == nil {
		t.Fatal("LinkOptionMedia returned nil error, want not found")
	}
	status, code, message, _ := api.ValidationErrorEnvelope(err)
	if status != 404 || code != "NOT_FOUND" || message != "Option not found" {
		t.Fatalf("error = (%d, %s, %s), want 404 NOT_FOUND Option not found", status, code, message)
	}
}

func TestDeleteMediaAssetRequiresAdmin(t *testing.T) {
	db := &recordingExecer{}
	err := DeleteMediaAsset(context.Background(), db, auth.User{ID: 5, Role: "user"}, 99)
	status, code, _, _ := api.ValidationErrorEnvelope(err)
	if status != 403 || code != "ADMIN_REQUIRED" {
		t.Fatalf("DeleteMediaAsset error = (%d, %s), want 403 ADMIN_REQUIRED", status, code)
	}
	if db.called {
		t.Fatal("DeleteMediaAsset executed DELETE for non-admin user")
	}
}

func TestValidateCreateQuestionInputRequiresCoreFields(t *testing.T) {
	err := validateCreateQuestionInput(CreateQuestionInput{})
	status, code, _, details := api.ValidationErrorEnvelope(err)
	if status != 422 || code != "VALIDATION_ERROR" {
		t.Fatalf("validateCreateQuestionInput error = (%d, %s), want 422 VALIDATION_ERROR", status, code)
	}
	if len(details) != 3 {
		t.Fatalf("validation details = %#v, want questionTypeId, answerMode, and stem", details)
	}
}

func TestPersistImportedQuestionClaimSQLFencesPersistence(t *testing.T) {
	query := strings.ToUpper(strings.Join(strings.Fields(persistImportedQuestionClaimSQL), " "))
	for _, fragment := range []string{
		"UPDATE QUESTION_IMPORT_JOBS",
		"SET UPDATED_AT = NOW()",
		"STATUS = 'PROCESSING'",
		"STAGE = 'PERSISTING'",
		"CLAIM_VERSION = $2",
		"RETURNING ID",
	} {
		if !strings.Contains(query, fragment) {
			t.Fatalf("import persistence claim SQL missing %q: %s", fragment, query)
		}
	}
}

type recordingExecer struct {
	called bool
}

func (db *recordingExecer) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	db.called = true
	return pgconn.NewCommandTag("DELETE 1"), nil
}

type emptyQueryer struct{}

func (emptyQueryer) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return emptyRows{}, nil
}

type emptyRows struct{ pgx.Rows }

func (emptyRows) Close()     {}
func (emptyRows) Err() error { return nil }
func (emptyRows) Next() bool { return false }
