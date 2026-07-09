package db

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"openwook/internal/auth"
)

const (
	legacyAliPayOrdersTable = "alipay_payment_orders"
	seedAdminUsername       = "admin"
	seedAdminEmail          = "admin@openwook.local"
	seedAdminPassword       = "OpenWook123"
	seedBankName            = "OpenWook 示例题库"
	seedBankDescription     = "用于本地验证题库、题目、练习闭环。"
	seedBankSubject         = "general"
)

var ensureRequiredColumns = map[string][]string{
	"users":                 {"avatar_url", "membership", "plus_expires_at", "plus_trial_ends_at", "role"},
	"ai_artifacts":          {"artifact_type", "import_job_id", "practice_session_id", "question_id", "status", "user_id"},
	"billing_subscriptions": {"membership", "paddle_customer_id", "paddle_subscription_id", "source", "status", "updated_at", "user_id"},
}

var seedRequiredColumns = map[string][]string{
	"users":           {"email", "membership", "password_hash", "role", "username"},
	"question_banks":  {"created_by", "description", "is_public", "name", "subject"},
	"user_bank_links": {"bank_id", "is_owner", "user_id"},
}

type scriptExecutor interface {
	ExecScript(context.Context, string) error
}

type queryRows interface {
	Next() bool
	Scan(...any) error
	Err() error
	Close()
}

type rowScanner interface {
	Scan(...any) error
}

type queryExecer interface {
	Query(context.Context, string, ...any) (queryRows, error)
	Exec(context.Context, string, ...any) error
}

type txRunner interface {
	QueryRow(context.Context, string, ...any) rowScanner
	Exec(context.Context, string, ...any) error
}

type seedDB interface {
	Query(context.Context, string, ...any) (queryRows, error)
	WithTx(context.Context, func(txRunner) error) error
}

func Execute(ctx context.Context, target string, root string, stdout io.Writer) error {
	if stdout == nil {
		stdout = io.Discard
	}

	pool, err := OpenPool(ctx)
	if err != nil {
		return err
	}
	defer pool.Close()

	runtime := poolRuntime{pool: pool}

	switch target {
	case "db apply":
		count, err := runApply(ctx, root, runtime)
		if err != nil {
			return err
		}
		_, err = fmt.Fprintf(stdout, "Applied %d SQL files.\n", count)
		return err
	case "db ensure":
		if err := runEnsure(ctx, runtime); err != nil {
			return err
		}
		_, err = fmt.Fprintln(stdout, "OpenWook runtime bootstrap prerequisites are ready.")
		return err
	case "db seed":
		if err := runSeed(ctx, runtime, auth.HashPassword); err != nil {
			return err
		}
		_, err = fmt.Fprintln(stdout, "OpenWook seed complete. User: admin / OpenWook123")
		return err
	default:
		return fmt.Errorf("unsupported target %q", target)
	}
}

func runApply(ctx context.Context, root string, exec scriptExecutor) (int, error) {
	files, err := CollectSQLFiles(root)
	if err != nil {
		return 0, err
	}
	for _, path := range files {
		script, err := os.ReadFile(path)
		if err != nil {
			return 0, err
		}
		if err := exec.ExecScript(ctx, string(script)); err != nil {
			return 0, fmt.Errorf("apply %s: %w", path, err)
		}
	}
	return len(files), nil
}

func runEnsure(ctx context.Context, db queryExecer) error {
	if err := checkSchemaPrerequisites(ctx, db, ensureRequiredColumns, "Database bootstrap prerequisites are missing. Apply db/*/*.sql before running db ensure"); err != nil {
		return err
	}
	return db.Exec(ctx, "DROP TABLE IF EXISTS "+legacyAliPayOrdersTable)
}

func runSeed(ctx context.Context, db seedDB, hashPassword func(string) (string, error)) error {
	if err := checkSchemaPrerequisites(ctx, db, seedRequiredColumns, "Database seed prerequisites are missing. Apply db/*/*.sql before running db seed"); err != nil {
		return err
	}

	passwordHash, err := hashPassword(seedAdminPassword)
	if err != nil {
		return err
	}

	return db.WithTx(ctx, func(tx txRunner) error {
		var userID int64
		err := tx.QueryRow(ctx, `
			INSERT INTO users (username, email, password_hash, role, membership)
			VALUES ($1, $2, $3, $4, $5)
			ON CONFLICT ((LOWER(username))) DO UPDATE
			SET email = EXCLUDED.email,
			    role = EXCLUDED.role,
			    membership = EXCLUDED.membership
			RETURNING id
		`, seedAdminUsername, seedAdminEmail, passwordHash, "admin", "plus").Scan(&userID)
		if err != nil {
			return err
		}

		bankID, err := ensureSeedBank(ctx, tx, userID)
		if err != nil {
			return err
		}

		return tx.Exec(ctx, `
			INSERT INTO user_bank_links (user_id, bank_id, is_owner)
			VALUES ($1, $2, true)
			ON CONFLICT (user_id, bank_id) DO UPDATE SET is_owner = true
		`, userID, bankID)
	})
}

func ensureSeedBank(ctx context.Context, tx txRunner, userID int64) (int64, error) {
	var bankID int64
	err := tx.QueryRow(ctx, `
		SELECT id
		FROM question_banks
		WHERE created_by = $1
		  AND name = $2
		LIMIT 1
	`, userID, seedBankName).Scan(&bankID)
	if err == nil {
		return bankID, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return 0, err
	}

	err = tx.QueryRow(ctx, `
		INSERT INTO question_banks (name, description, subject, created_by, is_public)
		VALUES ($1, $2, $3, $4, true)
		RETURNING id
	`, seedBankName, seedBankDescription, seedBankSubject, userID).Scan(&bankID)
	return bankID, err
}

func checkSchemaPrerequisites(ctx context.Context, db interface {
	Query(context.Context, string, ...any) (queryRows, error)
}, requiredColumns map[string][]string, prefix string) error {
	requiredTables := sortedTableNames(requiredColumns)
	relations, err := db.Query(ctx, `
		SELECT relation_name AS name, COALESCE(to_regclass('public.' || relation_name)::text, '') AS present
		FROM unnest($1::text[]) AS required_relations(relation_name)
	`, requiredTables)
	if err != nil {
		return err
	}
	defer relations.Close()

	presentTables := make(map[string]bool, len(requiredTables))
	for relations.Next() {
		var name string
		var present string
		if err := relations.Scan(&name, &present); err != nil {
			return err
		}
		presentTables[name] = present != ""
	}
	if err := relations.Err(); err != nil {
		return err
	}

	columns, err := db.Query(ctx, `
		SELECT table_name, column_name
		FROM information_schema.columns
		WHERE table_schema = 'public'
		  AND table_name = ANY($1::text[])
	`, requiredTables)
	if err != nil {
		return err
	}
	defer columns.Close()

	columnsByTable := make(map[string]map[string]bool, len(requiredTables))
	for columns.Next() {
		var tableName string
		var columnName string
		if err := columns.Scan(&tableName, &columnName); err != nil {
			return err
		}
		tableColumns := columnsByTable[tableName]
		if tableColumns == nil {
			tableColumns = map[string]bool{}
			columnsByTable[tableName] = tableColumns
		}
		tableColumns[columnName] = true
	}
	if err := columns.Err(); err != nil {
		return err
	}

	missingTables := make([]string, 0)
	missingColumns := make([]string, 0)
	for _, tableName := range requiredTables {
		if !presentTables[tableName] {
			missingTables = append(missingTables, tableName)
		}
		for _, columnName := range requiredColumns[tableName] {
			if !columnsByTable[tableName][columnName] {
				missingColumns = append(missingColumns, tableName+"."+columnName)
			}
		}
	}
	if len(missingTables) == 0 && len(missingColumns) == 0 {
		return nil
	}

	details := make([]string, 0, 2)
	if len(missingTables) > 0 {
		details = append(details, "missing tables: "+strings.Join(missingTables, ", "))
	}
	if len(missingColumns) > 0 {
		details = append(details, "missing columns: "+strings.Join(missingColumns, ", "))
	}
	return fmt.Errorf("%s (%s).", prefix, strings.Join(details, "; "))
}

func sortedTableNames(requiredColumns map[string][]string) []string {
	names := make([]string, 0, len(requiredColumns))
	for tableName := range requiredColumns {
		names = append(names, tableName)
	}
	sort.Strings(names)
	return names
}

type poolRuntime struct {
	pool *pgxpool.Pool
}

func (r poolRuntime) ExecScript(ctx context.Context, script string) error {
	conn, err := r.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()

	results := conn.Conn().PgConn().Exec(ctx, script)
	_, err = results.ReadAll()
	return err
}

func (r poolRuntime) Query(ctx context.Context, sql string, args ...any) (queryRows, error) {
	return r.pool.Query(ctx, sql, args...)
}

func (r poolRuntime) Exec(ctx context.Context, sql string, args ...any) error {
	_, err := r.pool.Exec(ctx, sql, args...)
	return err
}

func (r poolRuntime) WithTx(ctx context.Context, fn func(txRunner) error) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()

	if err := fn(poolTx{tx: tx}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	committed = true
	return nil
}

type poolTx struct {
	tx pgx.Tx
}

func (t poolTx) QueryRow(ctx context.Context, sql string, args ...any) rowScanner {
	return t.tx.QueryRow(ctx, sql, args...)
}

func (t poolTx) Exec(ctx context.Context, sql string, args ...any) error {
	_, err := t.tx.Exec(ctx, sql, args...)
	return err
}
