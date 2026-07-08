package services

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestListSubjectsReturnsVisibleFieldsOrderedByDisplayName(t *testing.T) {
	t.Parallel()

	db := &recordingReferenceQueryer{
		rows: &fakeReferenceRows{values: [][]any{
			{"math", "Algebra"},
			{"science", "Biology"},
		}},
	}

	got, err := ListSubjects(context.Background(), db)
	if err != nil {
		t.Fatalf("ListSubjects returned error: %v", err)
	}

	want := []Subject{
		{SubjectID: "math", DisplayName: "Algebra"},
		{SubjectID: "science", DisplayName: "Biology"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("subjects = %#v, want %#v", got, want)
	}
	if len(db.calls) != 1 {
		t.Fatalf("query calls = %d, want 1", len(db.calls))
	}

	call := db.calls[0]
	referenceAssertSQLContainsAll(t, call.sql,
		"SELECT subject_id, display_name",
		"FROM subjects",
		"ORDER BY display_name",
	)
	if len(call.args) != 0 {
		t.Fatalf("query args = %#v, want none", call.args)
	}
}

func TestListQuestionTypesAppliesSubjectAndScopeFilters(t *testing.T) {
	t.Parallel()

	db := &recordingReferenceQueryer{
		rows: &fakeReferenceRows{values: [][]any{
			{"single-choice", "math", "Single Choice", "question", "choice"},
		}},
	}

	got, err := ListQuestionTypes(context.Background(), db, "math", "question")
	if err != nil {
		t.Fatalf("ListQuestionTypes returned error: %v", err)
	}

	want := []QuestionType{{
		TypeID:            "single-choice",
		SubjectID:         "math",
		DisplayName:       "Single Choice",
		Scope:             "question",
		DefaultAnswerMode: new("choice"),
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("question types = %#v, want %#v", got, want)
	}
	if len(db.calls) != 1 {
		t.Fatalf("query calls = %d, want 1", len(db.calls))
	}

	call := db.calls[0]
	referenceAssertSQLContainsAll(t, call.sql,
		"SELECT type_id, subject_id, display_name, scope, default_answer_mode",
		"FROM question_types",
		"subject_id",
		"scope",
		"ORDER BY subject_id, display_name",
	)
	wantArgs := []any{"math", "question"}
	if !reflect.DeepEqual(call.args, wantArgs) {
		t.Fatalf("query args = %#v, want %#v", call.args, wantArgs)
	}
}

func TestListKnowledgePointsUsesRootListSemanticsWhenParentIDMissing(t *testing.T) {
	t.Parallel()

	db := &recordingReferenceQueryer{
		rows: &fakeReferenceRows{},
	}

	got, err := ListKnowledgePoints(context.Background(), db, "math", nil)
	if err != nil {
		t.Fatalf("ListKnowledgePoints returned error: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("knowledge points = %#v, want empty slice", got)
	}
	if len(db.calls) != 1 {
		t.Fatalf("query calls = %d, want 1", len(db.calls))
	}

	call := db.calls[0]
	referenceAssertSQLContainsAll(t, call.sql,
		"SELECT id, subject_id, code, display_name, parent_id, metadata_json, created_at, updated_at",
		"FROM knowledge_points",
		"parent_id IS NULL",
		"OR parent_id =",
		"ORDER BY display_name",
	)
	wantArgs := []any{"math", nil}
	if !reflect.DeepEqual(call.args, wantArgs) {
		t.Fatalf("query args = %#v, want %#v", call.args, wantArgs)
	}
}

func TestListKnowledgePointsReturnsVisibleFieldsWhenParentIDProvided(t *testing.T) {
	t.Parallel()

	parentID := int64(9)
	db := &recordingReferenceQueryer{
		rows: &fakeReferenceRows{values: [][]any{
			{int64(17), "math", "ALG-01", "Linear Equations", int64(9), `{"difficulty":"easy"}`, "2026-07-08T12:00:00Z", "2026-07-08T12:30:00Z"},
		}},
	}

	got, err := ListKnowledgePoints(context.Background(), db, "math", &parentID)
	if err != nil {
		t.Fatalf("ListKnowledgePoints returned error: %v", err)
	}

	want := []KnowledgePoint{{
		ID:           17,
		SubjectID:    "math",
		Code:         "ALG-01",
		DisplayName:  "Linear Equations",
		ParentID:     new(int64(9)),
		MetadataJSON: `{"difficulty":"easy"}`,
		CreatedAt:    "2026-07-08T12:00:00Z",
		UpdatedAt:    "2026-07-08T12:30:00Z",
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("knowledge points = %#v, want %#v", got, want)
	}
	if len(db.calls) != 1 {
		t.Fatalf("query calls = %d, want 1", len(db.calls))
	}
	wantArgs := []any{"math", parentID}
	if !reflect.DeepEqual(db.calls[0].args, wantArgs) {
		t.Fatalf("query args = %#v, want %#v", db.calls[0].args, wantArgs)
	}
}

type recordingReferenceQueryer struct {
	rows  pgx.Rows
	err   error
	calls []referenceQueryCall
}

type referenceQueryCall struct {
	sql  string
	args []any
}

func (r *recordingReferenceQueryer) Query(_ context.Context, sql string, args ...any) (pgx.Rows, error) {
	r.calls = append(r.calls, referenceQueryCall{sql: sql, args: append([]any(nil), args...)})
	if r.err != nil {
		return nil, r.err
	}
	if r.rows == nil {
		return &fakeReferenceRows{}, nil
	}
	return r.rows, nil
}

type fakeReferenceRows struct {
	values [][]any
	index  int
	err    error
	closed bool
}

func (r *fakeReferenceRows) Close() {
	r.closed = true
}

func (r *fakeReferenceRows) Err() error {
	return r.err
}

func (r *fakeReferenceRows) CommandTag() pgconn.CommandTag {
	return pgconn.CommandTag{}
}

func (r *fakeReferenceRows) FieldDescriptions() []pgconn.FieldDescription {
	return nil
}

func (r *fakeReferenceRows) Next() bool {
	if r.index >= len(r.values) {
		r.closed = true
		return false
	}
	return true
}

func (r *fakeReferenceRows) Scan(dest ...any) error {
	if r.index >= len(r.values) {
		return errors.New("scan called with no remaining rows")
	}
	row := r.values[r.index]
	r.index++
	for i, value := range row {
		switch target := dest[i].(type) {
		case *int64:
			*target = value.(int64)
		case *string:
			if value == nil {
				*target = ""
				continue
			}
			*target = value.(string)
		case **string:
			if value == nil {
				*target = nil
				continue
			}
			resolved := value.(string)
			*target = &resolved
		case **int64:
			if value == nil {
				*target = nil
				continue
			}
			resolved := value.(int64)
			*target = &resolved
		default:
			return errors.New("unsupported scan target")
		}
	}
	return nil
}

func (r *fakeReferenceRows) Values() ([]any, error) {
	if r.index == 0 || r.index > len(r.values) {
		return nil, errors.New("values called without current row")
	}
	return append([]any(nil), r.values[r.index-1]...), nil
}

func (r *fakeReferenceRows) RawValues() [][]byte {
	return nil
}

func (r *fakeReferenceRows) Conn() *pgx.Conn {
	return nil
}

func referenceAssertSQLContainsAll(t *testing.T, sql string, want ...string) {
	t.Helper()

	normalized := referenceCollapseWhitespace(sql)
	for _, fragment := range want {
		if !strings.Contains(normalized, referenceCollapseWhitespace(fragment)) {
			t.Fatalf("sql = %q, want fragment %q", normalized, fragment)
		}
	}
}

func referenceCollapseWhitespace(value string) string {
	return strings.Join(strings.Fields(value), " ")
}
