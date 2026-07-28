package db

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"practiq/internal/auth"
)

const (
	seedAdminUsername   = "admin"
	seedAdminEmail      = "admin@practiq.local"
	defaultSeedPassword = "PractiQ123"
	seedBankName        = "PractiQ 示例题库"
	seedBankDescription = "用于本地验证题库、题目、练习闭环。"
	seedBankSubject     = "general"
)

func seedAdminPassword() string {
	if password := strings.TrimSpace(os.Getenv("SEED_ADMIN_PASSWORD")); password != "" {
		return password
	}
	return defaultSeedPassword
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

	switch target {
	case "db apply":
		count, err := runApply(ctx, root, pool)
		if err != nil {
			return err
		}
		_, err = fmt.Fprintf(stdout, "Applied %d SQL files.\n", count)
		return err
	case "db seed":
		if err := runSeed(ctx, pool); err != nil {
			return err
		}
		_, err = fmt.Fprintf(stdout, "PractiQ seed complete. User: %s (password from SEED_ADMIN_PASSWORD or the local default).\n", seedAdminUsername)
		return err
	default:
		return fmt.Errorf("unsupported target %q", target)
	}
}

func runApply(ctx context.Context, root string, pool *pgxpool.Pool) (int, error) {
	files, err := CollectSQLFiles(root)
	if err != nil {
		return 0, err
	}
	for _, path := range files {
		script, err := os.ReadFile(path)
		if err != nil {
			return 0, err
		}
		if _, err := pool.Exec(ctx, string(script)); err != nil {
			return 0, fmt.Errorf("apply %s: %w", path, err)
		}
	}
	return len(files), nil
}

func runSeed(ctx context.Context, pool *pgxpool.Pool) error {
	passwordHash, err := auth.HashPassword(seedAdminPassword())
	if err != nil {
		return err
	}

	return pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
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

		_, err = tx.Exec(ctx, `
			INSERT INTO user_bank_links (user_id, bank_id, is_owner)
			VALUES ($1, $2, true)
			ON CONFLICT (user_id, bank_id) DO UPDATE SET is_owner = true
		`, userID, bankID)
		return err
	})
}

func ensureSeedBank(ctx context.Context, tx pgx.Tx, userID int64) (int64, error) {
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
