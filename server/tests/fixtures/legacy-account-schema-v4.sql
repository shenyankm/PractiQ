-- Historical account schema from c9454b794103d9f8e4f4ed211880c7acc083b6c1; migration tests only.

CREATE TABLE import_accounts (
 account_id text PRIMARY KEY, phone text UNIQUE NOT NULL, balance bigint NOT NULL DEFAULT 0
);
CREATE TABLE import_products (
 product_id text PRIMARY KEY, name text NOT NULL, points bigint NOT NULL CHECK(points>0),
 purchase_url text NOT NULL, enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE import_ledger (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 account_id text NOT NULL REFERENCES import_accounts(account_id), amount bigint NOT NULL,
 kind text NOT NULL, reference text NOT NULL, note text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(account_id,kind,reference)
);
CREATE TABLE import_uploads (
 account_id text NOT NULL REFERENCES import_accounts(account_id), object_key text NOT NULL,
 sha256 text NOT NULL, media_type text NOT NULL, size_bytes bigint NOT NULL,
 verified boolean NOT NULL DEFAULT false,
 PRIMARY KEY(account_id,object_key)
);
CREATE TABLE import_calls (
 call_key text PRIMARY KEY, account_id text NOT NULL REFERENCES import_accounts(account_id),
 thread_id text NOT NULL, result_key text, rates jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','unknown','settled','rejected')),
 dispatched boolean NOT NULL DEFAULT false, usage jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX import_account_call ON import_calls(account_id) WHERE status IN ('pending','unknown');
CREATE INDEX import_call_task ON import_calls(thread_id);
ALTER TABLE document_tasks ADD COLUMN account_id text REFERENCES import_accounts(account_id);
ALTER TABLE document_tasks ADD COLUMN billing_rates jsonb;
CREATE INDEX document_account_order ON document_tasks(account_id,created_at DESC,thread_id DESC);
CREATE TABLE import_account_tokens (
 digest text PRIMARY KEY, account_id text NOT NULL REFERENCES import_accounts(account_id),
 revoked boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
