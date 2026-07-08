package services

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"openwook/internal/api"
	"openwook/internal/auth"
)

func TestListAdminUsersAppliesFiltersAndLimit(t *testing.T) {
	now := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	db := &recordingServiceDB{
		queryResults: []serviceQueryResult{{rows: &fakeServiceRows{values: [][]any{{
			int64(7), "alice", strPtr("alice@example.com"), strPtr("https://cdn/avatar.png"), true,
			"admin", "enterprise", ptrTime(now.Add(24 * time.Hour)), ptrTime(now.Add(48 * time.Hour)), now, now,
			int64(4), int64(2), int64(9),
		}}}}},
	}

	got, err := ListAdminUsers(context.Background(), db, auth.User{ID: 1, Role: "admin"}, map[string][]string{
		"q":      {" ali "},
		"status": {"active"},
		"role":   {"admin"},
	})
	if err != nil {
		t.Fatalf("ListAdminUsers returned error: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("len(got) = %d, want 1", len(got))
	}
	if got[0].BankCount != 4 || got[0].ImportJobCount != 2 || got[0].PracticeSessionCount != 9 {
		t.Fatalf("counts = %#v, want bank/import/practice = 4/2/9", got[0])
	}
	if len(db.queryCalls) != 1 {
		t.Fatalf("query calls = %d, want 1", len(db.queryCalls))
	}
	assertServiceSQLContainsAll(t, db.queryCalls[0].sql,
		"FROM users u",
		"COUNT(*)::int AS bank_count",
		"COUNT(*)::int AS import_job_count",
		"COUNT(*)::int AS practice_session_count",
		"ORDER BY u.created_at DESC, u.id DESC",
		"LIMIT 100",
	)
	if got := db.queryCalls[0].args; len(got) != 4 {
		t.Fatalf("query args len = %d, want 4", len(got))
	}
}

func TestSetUserStatusRejectsSelfDisable(t *testing.T) {
	_, err := SetUserStatus(context.Background(), &recordingServiceDB{}, auth.User{ID: 9, Role: "admin"}, 9, false)
	if err == nil {
		t.Fatal("SetUserStatus returned nil error, want conflict")
	}
	status, code, message, _ := api.ValidationErrorEnvelope(err)
	if status != 409 || code != "INVALID_STATE" || !strings.Contains(message, "cannot disable") {
		t.Fatalf("error = (%d, %s, %s), want 409 INVALID_STATE self-disable", status, code, message)
	}
}

func TestUpdateUserAccessRejectsSelfDemotion(t *testing.T) {
	_, err := UpdateUserAccess(context.Background(), &recordingServiceDB{}, auth.User{ID: 9, Role: "admin"}, 9, UserAccessUpdate{Role: strPtr("user")})
	if err == nil {
		t.Fatal("UpdateUserAccess returned nil error, want conflict")
	}
	status, code, message, _ := api.ValidationErrorEnvelope(err)
	if status != 409 || code != "INVALID_STATE" || !strings.Contains(message, "admin role") {
		t.Fatalf("error = (%d, %s, %s), want 409 INVALID_STATE self-demotion", status, code, message)
	}
}

func TestUpdateCurrentUserUsesPasswordHashAndAvatarSemantics(t *testing.T) {
	now := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	db := &recordingServiceDB{
		queryResults: []serviceQueryResult{{rows: &fakeServiceRows{values: [][]any{{
			int64(9), "alice", strPtr("alice@example.com"), nil, true,
			"user", "free", ptrTime(now.Add(24 * time.Hour)), nil, now, now,
		}}}}},
	}
	username := "alice-2"
	passwordHash := "$2y$10$updatedHash"
	_, err := UpdateCurrentUser(context.Background(), db, auth.User{ID: 9}, UserUpdateInput{
		Username:     &username,
		PasswordHash: &passwordHash,
		AvatarURLSet: true,
	})
	if err != nil {
		t.Fatalf("UpdateCurrentUser returned error: %v", err)
	}
	if len(db.queryCalls) != 1 {
		t.Fatalf("query calls = %d, want 1", len(db.queryCalls))
	}
	assertServiceSQLContainsAll(t, db.queryCalls[0].sql,
		"password_hash = COALESCE($3, password_hash)",
		"WHEN $4::boolean THEN $5",
		"ELSE avatar_url",
	)
}

func TestSearchQuestionsUsesVisibilityAndTermRanking(t *testing.T) {
	now := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	db := &recordingServiceDB{
		queryResults: []serviceQueryResult{{rows: &fakeServiceRows{values: [][]any{{
			int64(12), "standalone", "math", "single_choice", "choice", strPtr("single"), "1 + 1 = ?", strPtr("basic arithmetic"), "active", "manual", nil, nil, nil, now, now,
		}}}}},
	}
	got, err := Search(context.Background(), db, auth.User{ID: 4}, "questions", map[string][]string{
		"bankId": {"22"},
		"q":      {"1 + 1"},
		"type":   {"single_choice"},
		"status": {"active"},
	})
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	questions, ok := got.([]SearchQuestion)
	if !ok {
		t.Fatalf("Search returned %T, want []SearchQuestion", got)
	}
	if len(questions) != 1 || questions[0].ID != 12 {
		t.Fatalf("questions = %#v, want one question id 12", questions)
	}
	assertServiceSQLContainsAll(t, db.queryCalls[0].sql,
		"WITH visible_question_ids AS MATERIALIZED",
		"JOIN question_banks b ON b.id = bql.bank_id",
		"plainto_tsquery('simple', $5::text)",
		"ts_rank_cd",
		"LIMIT 50",
	)
}

func TestLinkOptionMediaRejectsMissingOption(t *testing.T) {
	db := &recordingServiceDB{queryResults: []serviceQueryResult{{rows: &fakeServiceRows{values: nil}}}}
	_, err := LinkOptionMedia(context.Background(), db, auth.User{ID: 5}, 99, MediaLinkInput{MediaID: 8, MediaKind: "image"})
	if err == nil {
		t.Fatal("LinkOptionMedia returned nil error, want not found")
	}
	status, code, message, _ := api.ValidationErrorEnvelope(err)
	if status != 404 || code != "NOT_FOUND" || message != "Option not found" {
		t.Fatalf("error = (%d, %s, %s), want 404 NOT_FOUND Option not found", status, code, message)
	}
}

func TestBuildSimplePDFEscapesControlCharacters(t *testing.T) {
	pdf := buildSimplePDF([]string{"Open(Wook)\\Export", "第二行"}, time.Date(2026, 7, 8, 12, 34, 56, 0, time.UTC))
	text := string(pdf)
	assertServiceSQLContainsAll(t, text,
		"%PDF-1.4",
		"Open\\(Wook\\)\\\\Export",
		"?",
		"%%EOF",
	)
}

type recordingServiceDB struct {
	queryCalls   []serviceQueryCall
	execCalls    []serviceQueryCall
	queryResults []serviceQueryResult
	execErr      error
}

type serviceQueryCall struct {
	sql  string
	args []any
}

type serviceQueryResult struct {
	rows *fakeServiceRows
	err  error
}

func (r *recordingServiceDB) Query(_ context.Context, sql string, args ...any) (pgx.Rows, error) {
	r.queryCalls = append(r.queryCalls, serviceQueryCall{sql: sql, args: append([]any(nil), args...)})
	result := r.queryResults[0]
	r.queryResults = r.queryResults[1:]
	if result.rows == nil {
		result.rows = &fakeServiceRows{}
	}
	return result.rows, result.err
}

func (r *recordingServiceDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	r.execCalls = append(r.execCalls, serviceQueryCall{sql: sql, args: append([]any(nil), args...)})
	return pgconn.CommandTag{}, r.execErr
}

type fakeServiceRows struct {
	values [][]any
	index  int
	err    error
	closed bool
}

func (r *fakeServiceRows) Close() {
	r.closed = true
}

func (r *fakeServiceRows) Err() error {
	return r.err
}

func (r *fakeServiceRows) CommandTag() pgconn.CommandTag {
	return pgconn.CommandTag{}
}

func (r *fakeServiceRows) FieldDescriptions() []pgconn.FieldDescription {
	return nil
}

func (r *fakeServiceRows) Next() bool {
	return r.index < len(r.values)
}

func (r *fakeServiceRows) Scan(dest ...any) error {
	row := r.values[r.index]
	r.index++
	for i := range dest {
		switch ptr := dest[i].(type) {
		case *int64:
			*ptr = row[i].(int64)
		case **int64:
			if row[i] == nil {
				*ptr = nil
			} else {
				value := row[i].(int64)
				*ptr = &value
			}
		case *int:
			*ptr = int(row[i].(int64))
		case *string:
			*ptr = row[i].(string)
		case **string:
			if row[i] == nil {
				*ptr = nil
			} else if value, ok := row[i].(*string); ok {
				*ptr = value
			} else {
				value := row[i].(string)
				*ptr = &value
			}
		case *bool:
			*ptr = row[i].(bool)
		case *time.Time:
			*ptr = row[i].(time.Time)
		case **time.Time:
			if row[i] == nil {
				*ptr = nil
			} else if value, ok := row[i].(*time.Time); ok {
				*ptr = value
			} else {
				value := row[i].(time.Time)
				*ptr = &value
			}
		default:
			return pgx.ErrNoRows
		}
	}
	return nil
}

func (r *fakeServiceRows) Values() ([]any, error) {
	if len(r.values) == 0 {
		return nil, nil
	}
	return r.values[0], nil
}

func (r *fakeServiceRows) RawValues() [][]byte {
	return nil
}

func (r *fakeServiceRows) Conn() *pgx.Conn {
	return nil
}

func assertServiceSQLContainsAll(t *testing.T, sql string, want ...string) {
	t.Helper()
	collapsed := collapseServiceWhitespace(sql)
	for _, needle := range want {
		if !strings.Contains(collapsed, collapseServiceWhitespace(needle)) {
			t.Fatalf("SQL %q does not contain %q", collapsed, needle)
		}
	}
}

func collapseServiceWhitespace(value string) string {
	return strings.Join(strings.Fields(value), " ")
}

func strPtr(value string) *string {
	return &value
}

func ptrTime(value time.Time) *time.Time {
	return &value
}
