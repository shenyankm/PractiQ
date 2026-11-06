"""Schema-six identity tables; historical account/payment tables remain archives."""
IDENTITY_DDL = """
CREATE TABLE auth_users (
 id text PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL DEFAULT '',
 password_hash text NOT NULL, role text NOT NULL CHECK(role IN ('user','admin')),
 enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
 preferences jsonb NOT NULL DEFAULT '{}', limits jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE auth_sessions (
 digest text PRIMARY KEY, user_id text NOT NULL REFERENCES auth_users(id),
 created_at timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
CREATE TABLE auth_tokens (
 digest text PRIMARY KEY, id text NOT NULL UNIQUE, user_id text NOT NULL REFERENCES auth_users(id),
 kind text NOT NULL CHECK(kind IN ('reset','grading')), name text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE TABLE auth_uploads (
 user_id text NOT NULL REFERENCES auth_users(id), object_key text NOT NULL,
 sha256 text NOT NULL, size_bytes bigint NOT NULL, PRIMARY KEY(user_id,object_key)
);
CREATE TABLE auth_settings (id integer PRIMARY KEY CHECK(id=1), value jsonb NOT NULL);
INSERT INTO auth_settings VALUES(1,'{"registrationEnabled":true,"freePages":50,"modelCalls":1000,"tencentCalls":50,"activeTasks":2}');
CREATE TABLE auth_limits (key text NOT NULL, bucket bigint NOT NULL, count integer NOT NULL, PRIMARY KEY(key,bucket));
CREATE TABLE auth_calls (
 call_key text PRIMARY KEY, user_id text NOT NULL REFERENCES auth_users(id), scope text NOT NULL,
 kind text NOT NULL, day date NOT NULL, record jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_calls_user_day ON auth_calls(user_id,day,kind);
CREATE TABLE auth_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor text NOT NULL, action text NOT NULL,
 target text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), detail jsonb NOT NULL DEFAULT '{}'
);
ALTER TABLE document_tasks ADD COLUMN owner_id text REFERENCES auth_users(id);
CREATE INDEX document_task_owner_order ON document_tasks(owner_id,created_at DESC,thread_id DESC);
ALTER TABLE grades ADD COLUMN owner_id text REFERENCES auth_users(id);
"""
IDENTITY_TABLES = {'auth_users', 'auth_sessions', 'auth_tokens', 'auth_uploads', 'auth_settings', 'auth_limits', 'auth_calls', 'auth_audit', 'auth_audit_id_seq'}
