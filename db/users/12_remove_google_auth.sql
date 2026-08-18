-- Purpose: Remove legacy Google identity mappings and revoke sessions that
-- belonged to passwordless Google-only accounts. Safe as a no-op on fresh schemas.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'users'
          AND column_name = 'google_sub'
    ) THEN
        IF to_regclass('public.auth_sessions') IS NOT NULL THEN
            EXECUTE $sql$
                UPDATE auth_sessions
                SET revoked_at = NOW(), revoke_reason = 'google_auth_removed'
                WHERE revoked_at IS NULL
                  AND user_id IN (
                      SELECT id
                      FROM users
                      WHERE google_sub IS NOT NULL
                        AND password_hash IS NULL
                  )
            $sql$;
        END IF;

        ALTER TABLE users DROP COLUMN google_sub;
    END IF;
END
$$;
