package db

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestRunApplyExecutesSQLFilesInNumericPrefixOrder(t *testing.T) {
	root := t.TempDir()
	for relative, sql := range map[string]string{
		"db/users/10_users.sql":    "select 'users';\n",
		"db/core/00_functions.sql": "select 'functions';\n",
		"db/banks/05_banks.sql":    "select 'banks';\n",
	} {
		fullPath := filepath.Join(root, relative)
		if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
			t.Fatalf("MkdirAll(%q) returned error: %v", filepath.Dir(fullPath), err)
		}
		if err := os.WriteFile(fullPath, []byte(sql), 0o600); err != nil {
			t.Fatalf("WriteFile(%q) returned error: %v", fullPath, err)
		}
	}

	exec := &fakeScriptExecutor{}
	if _, err := runApply(context.Background(), root, exec); err != nil {
		t.Fatalf("runApply returned error: %v", err)
	}

	want := []string{"select 'functions';\n", "select 'banks';\n", "select 'users';\n"}
	if !reflect.DeepEqual(exec.scripts, want) {
		t.Fatalf("executed scripts = %v, want %v", exec.scripts, want)
	}
}

func TestRunEnsureDropsLegacyAliPayTableAfterCheckingPrerequisites(t *testing.T) {
	db := &fakeQueryExecer{
		queryResults: []queryResult{
			{rows: &fakeRows{values: [][]any{{"users", "users"}, {"ai_artifacts", "ai_artifacts"}, {"billing_subscriptions", "billing_subscriptions"}}}},
			{rows: &fakeRows{values: [][]any{{"users", "avatar_url"}, {"users", "membership"}, {"users", "plus_expires_at"}, {"users", "plus_trial_ends_at"}, {"users", "role"}, {"ai_artifacts", "artifact_type"}, {"ai_artifacts", "import_job_id"}, {"ai_artifacts", "practice_session_id"}, {"ai_artifacts", "question_id"}, {"ai_artifacts", "status"}, {"ai_artifacts", "user_id"}, {"billing_subscriptions", "membership"}, {"billing_subscriptions", "paddle_customer_id"}, {"billing_subscriptions", "paddle_subscription_id"}, {"billing_subscriptions", "source"}, {"billing_subscriptions", "status"}, {"billing_subscriptions", "updated_at"}, {"billing_subscriptions", "user_id"}}}},
		},
	}

	if err := runEnsure(context.Background(), db); err != nil {
		t.Fatalf("runEnsure returned error: %v", err)
	}

	if !reflect.DeepEqual(db.execSQL, []string{"DROP TABLE IF EXISTS alipay_payment_orders"}) {
		t.Fatalf("exec SQL = %v, want legacy ali pay drop", db.execSQL)
	}
}

func TestRunEnsureFailsWhenBootstrapPrerequisitesAreMissing(t *testing.T) {
	db := &fakeQueryExecer{
		queryResults: []queryResult{
			{rows: &fakeRows{values: [][]any{{"users", "users"}, {"ai_artifacts", nil}, {"billing_subscriptions", "billing_subscriptions"}}}},
			{rows: &fakeRows{values: [][]any{{"users", "avatar_url"}}}},
		},
	}

	err := runEnsure(context.Background(), db)
	if err == nil {
		t.Fatal("runEnsure returned nil error, want missing prerequisite error")
	}
	message := err.Error()
	if !strings.Contains(message, "Database bootstrap prerequisites are missing") {
		t.Fatalf("error = %q, want bootstrap prerequisite prefix", message)
	}
	if !strings.Contains(message, "missing tables: ai_artifacts") {
		t.Fatalf("error = %q, want missing table detail", message)
	}
	if !strings.Contains(message, "users.membership") {
		t.Fatalf("error = %q, want missing users.membership detail", message)
	}
}

func TestRunSeedHashesDefaultPasswordAndLinksSampleBank(t *testing.T) {
	db := &fakeSeedDB{
		queries: []queryResult{
			{rows: &fakeRows{values: [][]any{{"users", "users"}, {"question_banks", "question_banks"}, {"user_bank_links", "user_bank_links"}}}},
			{rows: &fakeRows{values: [][]any{{"users", "email"}, {"users", "membership"}, {"users", "password_hash"}, {"users", "role"}, {"users", "username"}, {"question_banks", "created_by"}, {"question_banks", "description"}, {"question_banks", "is_public"}, {"question_banks", "name"}, {"question_banks", "subject"}, {"user_bank_links", "bank_id"}, {"user_bank_links", "is_owner"}, {"user_bank_links", "user_id"}}}},
		},
		tx: &fakeTx{
			rows: []fakeRow{{values: []any{int64(7)}}, {err: pgx.ErrNoRows}, {values: []any{int64(11)}}},
		},
	}

	err := runSeed(context.Background(), db, func(password string) (string, error) {
		if password != "OpenWook123" {
			return "", errors.New("unexpected password")
		}
		return "hashed-password", nil
	})
	if err != nil {
		t.Fatalf("runSeed returned error: %v", err)
	}

	if got := db.tx.queryCalls[0].args[2]; got != "hashed-password" {
		t.Fatalf("user upsert password hash = %v, want %q", got, "hashed-password")
	}
	if len(db.tx.execCalls) != 1 {
		t.Fatalf("exec calls = %d, want 1 owner link upsert", len(db.tx.execCalls))
	}
	if got := db.tx.execCalls[0].args; !reflect.DeepEqual(got, []any{int64(7), int64(11)}) {
		t.Fatalf("owner link args = %v, want %v", got, []any{int64(7), int64(11)})
	}
}

func TestRunSeedFailsWhenSeedPrerequisitesAreMissing(t *testing.T) {
	db := &fakeSeedDB{
		queries: []queryResult{
			{rows: &fakeRows{values: [][]any{{"users", "users"}, {"question_banks", nil}, {"user_bank_links", "user_bank_links"}}}},
			{rows: &fakeRows{values: [][]any{{"users", "email"}}}},
		},
		tx: &fakeTx{},
	}

	err := runSeed(context.Background(), db, func(password string) (string, error) {
		return "ignored", nil
	})
	if err == nil {
		t.Fatal("runSeed returned nil error, want missing prerequisite error")
	}
	if !strings.Contains(err.Error(), "Database seed prerequisites are missing") {
		t.Fatalf("error = %q, want seed prerequisite prefix", err.Error())
	}
	if db.withTxCalls != 0 {
		t.Fatalf("withTxCalls = %d, want 0 when prerequisites fail", db.withTxCalls)
	}
}

type fakeScriptExecutor struct {
	scripts []string
}

func (f *fakeScriptExecutor) ExecScript(_ context.Context, script string) error {
	f.scripts = append(f.scripts, script)
	return nil
}

type queryResult struct {
	rows queryRows
	err  error
}

type fakeQueryExecer struct {
	queryResults []queryResult
	execSQL      []string
}

func (f *fakeQueryExecer) Query(_ context.Context, _ string, _ ...any) (queryRows, error) {
	if len(f.queryResults) == 0 {
		return nil, io.EOF
	}
	result := f.queryResults[0]
	f.queryResults = f.queryResults[1:]
	return result.rows, result.err
}

func (f *fakeQueryExecer) Exec(_ context.Context, sql string, _ ...any) error {
	f.execSQL = append(f.execSQL, sql)
	return nil
}

type fakeSeedDB struct {
	queries     []queryResult
	tx          *fakeTx
	withTxCalls int
}

func (f *fakeSeedDB) Query(_ context.Context, _ string, _ ...any) (queryRows, error) {
	if len(f.queries) == 0 {
		return nil, io.EOF
	}
	result := f.queries[0]
	f.queries = f.queries[1:]
	return result.rows, result.err
}

func (f *fakeSeedDB) WithTx(_ context.Context, fn func(txRunner) error) error {
	f.withTxCalls++
	return fn(f.tx)
}

type fakeTx struct {
	rows       []fakeRow
	queryCalls []queryCall
	execCalls  []queryCall
}

type queryCall struct {
	sql  string
	args []any
}

func (f *fakeTx) QueryRow(_ context.Context, sql string, args ...any) rowScanner {
	f.queryCalls = append(f.queryCalls, queryCall{sql: sql, args: append([]any(nil), args...)})
	row := f.rows[0]
	f.rows = f.rows[1:]
	return row
}

func (f *fakeTx) Exec(_ context.Context, sql string, args ...any) error {
	f.execCalls = append(f.execCalls, queryCall{sql: sql, args: append([]any(nil), args...)})
	return nil
}

type fakeRow struct {
	values []any
	err    error
}

func (f fakeRow) Scan(dest ...any) error {
	if f.err != nil {
		return f.err
	}
	for index, value := range f.values {
		switch target := dest[index].(type) {
		case *int64:
			*target = value.(int64)
		case *string:
			*target = value.(string)
		default:
			return errors.New("unsupported scan target")
		}
	}
	return nil
}

type fakeRows struct {
	values [][]any
	index  int
}

func (f *fakeRows) Next() bool {
	return f.index < len(f.values)
}

func (f *fakeRows) Scan(dest ...any) error {
	row := f.values[f.index]
	f.index++
	for i, value := range row {
		switch target := dest[i].(type) {
		case *string:
			if value == nil {
				*target = ""
				continue
			}
			*target = value.(string)
		default:
			return errors.New("unsupported scan target")
		}
	}
	return nil
}

func (f *fakeRows) Err() error {
	return nil
}

func (f *fakeRows) Close() {}
