-- PractiQ product schema for a fresh PostgreSQL 16 database; validated by make schema-check.
-- Shared PostgreSQL extensions and timestamp maintenance.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

-- Users contain only product profile and entitlement state; WeChat is the sole login identity.
CREATE TABLE users (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  display_name varchar(64), avatar_url text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  trial_ends_at timestamptz NOT NULL DEFAULT (now() + interval '3 days'),
  paid_pro_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE wechat_identities (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  openid text NOT NULL UNIQUE CHECK (btrim(openid) <> ''), unionid text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_wechat_identities_unionid ON wechat_identities(unionid) WHERE unionid IS NOT NULL;
-- Append-only record of privileged administrator actions.
CREATE TABLE admin_audits (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id bigint REFERENCES users(id) ON DELETE RESTRICT,
  target_user_id bigint REFERENCES users(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('bootstrap','grant_admin','revoke_admin','deactivate_user','activate_user','ban_bank','unban_bank','refund','knowledge_point')),
  details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_admin_audits_target_created ON admin_audits(target_user_id, created_at DESC);

-- Revocable sessions and rotating opaque refresh tokens. A partial unique index
-- below limits each user to one non-revoked session.
CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(), absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz, revoke_reason text,
  CHECK (absolute_expires_at > created_at)
);
CREATE UNIQUE INDEX uq_auth_sessions_one_active_user ON auth_sessions(user_id) WHERE revoked_at IS NULL;
CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE, parent_token_id uuid REFERENCES refresh_tokens(id), replaced_by_token_id uuid REFERENCES refresh_tokens(id),
  issued_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, used_at timestamptz, revoked_at timestamptz,
  CHECK (expires_at > issued_at)
);
CREATE INDEX idx_refresh_tokens_active_session ON refresh_tokens(session_id) WHERE revoked_at IS NULL;

-- Stable write-response cache keyed by user, route, and client idempotency key.
CREATE TABLE request_idempotency (
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE, route text NOT NULL, idempotency_key text NOT NULL,
  request_hash bytea NOT NULL, response_status integer, response_body jsonb, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, route, idempotency_key), CHECK (expires_at > created_at)
);
CREATE INDEX idx_request_idempotency_expiry ON request_idempotency(expires_at);

-- WeChat orders use fixed product prices and preserve merchant/WeChat identifiers
-- for reconciliation. Only pending orders participate in creation idempotency.
CREATE TABLE payment_orders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('pro','credits')), merchant_order_no text NOT NULL UNIQUE,
  wechat_transaction_id text UNIQUE, app_id text NOT NULL, mch_id text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0), currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  credits_amount numeric(14,2), status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','expired','closed','refunded')),
  expires_at timestamptz NOT NULL, fulfilled_at timestamptz, last_reconciled_at timestamptz,
  idempotency_key text NOT NULL, request_hash bytea NOT NULL, response_cache jsonb, response_cache_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,user_id),
  CHECK ((kind='pro' AND amount_cents=2990 AND credits_amount IS NULL) OR (kind='credits' AND amount_cents=1000 AND credits_amount=100.00)),
  CHECK (expires_at = created_at + interval '30 minutes'),
  CHECK (response_cache_expires_at IS NULL OR response_cache_expires_at <= expires_at),
  CHECK ((status IN ('paid','refunded')) = (fulfilled_at IS NOT NULL)),
  CHECK ((status IN ('paid','refunded')) = (wechat_transaction_id IS NOT NULL))
);
CREATE UNIQUE INDEX uq_payment_orders_live_idempotency ON payment_orders(user_id, kind, idempotency_key) WHERE status='pending';
CREATE UNIQUE INDEX uq_payment_orders_one_pending_kind ON payment_orders(user_id, kind) WHERE status='pending';
CREATE INDEX idx_payment_orders_reconcile ON payment_orders(status, last_reconciled_at) WHERE status IN ('pending','expired');
CREATE TABLE wechat_notification_replays (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, notification_id text NOT NULL UNIQUE, nonce text NOT NULL UNIQUE, received_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE payment_refunds (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, order_id bigint NOT NULL REFERENCES payment_orders(id) ON DELETE RESTRICT,
  initiated_by bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  merchant_refund_no text NOT NULL UNIQUE, wechat_refund_id text UNIQUE,
  amount_cents integer NOT NULL CHECK (amount_cents > 0), status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed','closed')),
  processed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(order_id), CHECK ((status='succeeded') = (processed_at IS NOT NULL))
);

-- Credits use fixed-point decimals. credit_ledger is append-only and its insert
-- trigger is the only mechanism that changes the materialized account balance.
CREATE TABLE credit_accounts (user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT, balance numeric(14,2) NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE credit_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('purchase','bonus','reserve','settle','release','failure_refund','payment_refund')),
  amount numeric(14,2) NOT NULL CHECK (amount <> 0), idempotency_key text NOT NULL UNIQUE,
  order_id bigint REFERENCES payment_orders(id) ON DELETE RESTRICT, ai_task_id bigint,
  metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_credit_ledger_user_created ON credit_ledger(user_id, created_at DESC);

-- Product classification, bank ownership, favorites, tags, and three-level subsets.
CREATE TABLE subjects (id varchar(32) PRIMARY KEY CHECK (btrim(id)<>''), display_name varchar(64) NOT NULL CHECK (btrim(display_name)<>''));
INSERT INTO subjects VALUES ('general','General'),('english','English'),('math','Math'),('physics','Physics'),('chemistry','Chemistry');
CREATE TABLE question_types (id varchar(64) PRIMARY KEY CHECK (btrim(id)<>''), subject_id varchar(32) NOT NULL REFERENCES subjects(id), display_name varchar(128) NOT NULL, answer_mode text CHECK (answer_mode IN ('choice','true_false','fill_blank','short_answer')), UNIQUE(subject_id,id));
INSERT INTO question_types VALUES ('generic','general','Generic',NULL);

CREATE TABLE question_banks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, owner_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  subject_id varchar(32) NOT NULL REFERENCES subjects(id), name varchar(100) NOT NULL CHECK (btrim(name)<>''), description text,
  status text NOT NULL DEFAULT 'private' CHECK (status IN ('private','public','banned')),
  cloned_from_bank_id bigint REFERENCES question_banks(id) ON DELETE SET NULL, cloned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((cloned_from_bank_id IS NULL) = (cloned_at IS NULL))
);
CREATE UNIQUE INDEX uq_question_banks_id_owner ON question_banks(id,owner_user_id);
CREATE UNIQUE INDEX uq_question_banks_id_owner_subject ON question_banks(id,owner_user_id,subject_id);
CREATE INDEX idx_question_banks_owner_created ON question_banks(owner_user_id,created_at DESC);
CREATE INDEX idx_question_banks_public_search ON question_banks USING gin (to_tsvector('simple', name || ' ' || coalesce(description,''))) WHERE status='public';
CREATE TABLE user_bank_favorites (user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE, bank_id bigint NOT NULL REFERENCES question_banks(id) ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,bank_id));
CREATE INDEX idx_user_bank_favorites_bank ON user_bank_favorites(bank_id);
CREATE TABLE bank_tags (bank_id bigint NOT NULL REFERENCES question_banks(id) ON DELETE CASCADE, tag varchar(64) NOT NULL CHECK (btrim(tag)<>''), PRIMARY KEY(bank_id,tag));
CREATE INDEX idx_bank_tags_tag ON bank_tags(tag);
CREATE TABLE bank_subsets (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, bank_id bigint NOT NULL REFERENCES question_banks(id) ON DELETE CASCADE,
  parent_id bigint, name varchar(100) NOT NULL CHECK (btrim(name)<>''), sort_order integer NOT NULL DEFAULT 1 CHECK(sort_order>0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,bank_id), UNIQUE NULLS NOT DISTINCT (bank_id,parent_id,sort_order), UNIQUE NULLS NOT DISTINCT (bank_id,parent_id,name),
  FOREIGN KEY(parent_id,bank_id) REFERENCES bank_subsets(id,bank_id) DEFERRABLE INITIALLY DEFERRED
);

-- Question content is singly owned. Link validation prevents cross-owner or
-- cross-subject sharing; cloning creates independent owned rows instead.
CREATE TABLE question_groups (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, owner_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  subject_id varchar(32) NOT NULL REFERENCES subjects(id), title text NOT NULL CHECK(btrim(title)<>''), instructions text,
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','archived')), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,owner_user_id), UNIQUE(id,owner_user_id,subject_id)
);
CREATE TABLE questions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, owner_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  subject_id varchar(32) NOT NULL REFERENCES subjects(id), question_type_id varchar(64) NOT NULL, FOREIGN KEY(subject_id,question_type_id) REFERENCES question_types(subject_id,id),
  answer_mode text NOT NULL CHECK(answer_mode IN ('choice','true_false','fill_blank','short_answer')), choice_variant text CHECK(choice_variant IN ('single','multiple')),
  stem text NOT NULL CHECK(btrim(stem)<>''), analysis text, status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','archived')),
  source_job_id bigint, cloned_from_question_id bigint REFERENCES questions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,owner_user_id), UNIQUE(id,owner_user_id,subject_id),
  CHECK ((answer_mode='choice') = (choice_variant IS NOT NULL))
);
CREATE INDEX idx_questions_stem_fts ON questions USING gin(to_tsvector('simple',stem));
CREATE INDEX idx_questions_stem_trgm ON questions USING gin(stem gin_trgm_ops);
CREATE TABLE bank_question_links (
  bank_id bigint NOT NULL REFERENCES question_banks(id) ON DELETE CASCADE, question_id bigint NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  subset_id bigint, sort_order integer NOT NULL DEFAULT 1 CHECK(sort_order>0), status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','archived')),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(bank_id,question_id), UNIQUE(bank_id,sort_order),
  FOREIGN KEY(subset_id,bank_id) REFERENCES bank_subsets(id,bank_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX idx_bank_question_links_visible ON bank_question_links(bank_id,sort_order) WHERE status='active';
CREATE TABLE bank_group_links (
  bank_id bigint NOT NULL REFERENCES question_banks(id) ON DELETE CASCADE, group_id bigint NOT NULL REFERENCES question_groups(id) ON DELETE CASCADE,
  subset_id bigint, sort_order integer NOT NULL DEFAULT 1 CHECK(sort_order>0), status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','archived')),
  PRIMARY KEY(bank_id,group_id), UNIQUE(bank_id,sort_order), FOREIGN KEY(subset_id,bank_id) REFERENCES bank_subsets(id,bank_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE group_question_links (group_id bigint NOT NULL REFERENCES question_groups(id) ON DELETE CASCADE, question_id bigint NOT NULL REFERENCES questions(id) ON DELETE CASCADE, sort_order integer NOT NULL DEFAULT 1 CHECK(sort_order>0), PRIMARY KEY(group_id,question_id), UNIQUE(group_id,sort_order));
CREATE INDEX idx_bank_question_links_question ON bank_question_links(question_id);
CREATE INDEX idx_bank_group_links_group ON bank_group_links(group_id);
CREATE INDEX idx_group_question_links_question ON group_question_links(question_id);
CREATE TABLE question_options (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, question_id bigint NOT NULL REFERENCES questions(id) ON DELETE CASCADE, option_label varchar(16) NOT NULL CHECK(btrim(option_label)<>''), sort_order smallint NOT NULL CHECK(sort_order>0), content text NOT NULL CHECK(btrim(content)<>''), UNIQUE(question_id,option_label), UNIQUE(question_id,sort_order));
CREATE TABLE question_answer_keys (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, question_id bigint NOT NULL REFERENCES questions(id) ON DELETE CASCADE, answer_mode text NOT NULL CHECK(answer_mode IN ('choice','true_false','fill_blank','short_answer')), version integer NOT NULL DEFAULT 1 CHECK(version>0), is_primary boolean NOT NULL DEFAULT true, answer_payload jsonb NOT NULL DEFAULT '{}', explanation_payload jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(question_id,version), UNIQUE(id,question_id));
CREATE UNIQUE INDEX uq_question_answer_keys_one_primary ON question_answer_keys(question_id) WHERE is_primary;
CREATE TABLE knowledge_points (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, subject_id varchar(32) NOT NULL REFERENCES subjects(id), parent_id bigint, code varchar(128) NOT NULL CHECK(btrim(code)<>''), display_name varchar(256) NOT NULL CHECK(btrim(display_name)<>''), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(subject_id,code), UNIQUE(id,subject_id), FOREIGN KEY(parent_id,subject_id) REFERENCES knowledge_points(id,subject_id) DEFERRABLE INITIALLY DEFERRED);
CREATE INDEX idx_knowledge_points_search ON knowledge_points USING gin(to_tsvector('simple',display_name));
CREATE TABLE question_knowledge_points (question_id bigint NOT NULL REFERENCES questions(id) ON DELETE CASCADE, knowledge_point_id bigint NOT NULL REFERENCES knowledge_points(id) ON DELETE RESTRICT, PRIMARY KEY(question_id,knowledge_point_id));
CREATE INDEX idx_question_knowledge_points_knowledge ON question_knowledge_points(knowledge_point_id);

-- Media rows store validated metadata only; Java validates and deletes file bytes.
CREATE TABLE media_assets (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, created_by bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT, storage_path text NOT NULL UNIQUE, original_name varchar(255), media_type text NOT NULL CHECK(media_type IN ('image','audio')), mime_type text NOT NULL CHECK(mime_type IN ('image/png','image/jpeg','image/gif','image/webp','audio/mpeg','audio/mp4','audio/aac','audio/wav')), size_bytes integer NOT NULL CHECK(size_bytes>0 AND size_bytes<=10485760), checksum_sha256 char(64) NOT NULL CHECK(checksum_sha256 ~ '^[0-9a-f]{64}$'), width integer CHECK(width>0), height integer CHECK(height>0), duration_ms integer CHECK(duration_ms>=0), metadata jsonb NOT NULL DEFAULT '{}', deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), CHECK((media_type='image') = (mime_type LIKE 'image/%')));
CREATE TABLE question_media_links (question_id bigint NOT NULL REFERENCES questions(id) ON DELETE CASCADE, media_id bigint NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT, sort_order smallint NOT NULL CHECK(sort_order>0), PRIMARY KEY(question_id,media_id), UNIQUE(question_id,sort_order));
CREATE TABLE question_option_media_links (option_id bigint NOT NULL REFERENCES question_options(id) ON DELETE CASCADE, media_id bigint NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT, sort_order smallint NOT NULL CHECK(sort_order>0), PRIMARY KEY(option_id,media_id), UNIQUE(option_id,sort_order));
CREATE TABLE question_group_media_links (group_id bigint NOT NULL REFERENCES question_groups(id) ON DELETE CASCADE, media_id bigint NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT, sort_order smallint NOT NULL CHECK(sort_order>0), PRIMARY KEY(group_id,media_id), UNIQUE(group_id,sort_order));
CREATE TABLE question_content_blocks (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, question_id bigint REFERENCES questions(id) ON DELETE CASCADE, group_id bigint REFERENCES question_groups(id) ON DELETE CASCADE, option_id bigint REFERENCES question_options(id) ON DELETE CASCADE, part_type text NOT NULL CHECK(part_type IN ('text','formula','image','table','markdown','html','chart','qr_code')), sequence integer NOT NULL CHECK(sequence>0), payload jsonb NOT NULL DEFAULT '{}', CHECK(num_nonnulls(question_id,group_id,option_id)=1));
CREATE INDEX idx_question_media_links_media ON question_media_links(media_id);
CREATE INDEX idx_question_option_media_links_media ON question_option_media_links(media_id);
CREATE INDEX idx_question_group_media_links_media ON question_group_media_links(media_id);
CREATE INDEX idx_question_content_blocks_question ON question_content_blocks(question_id) WHERE question_id IS NOT NULL;
CREATE INDEX idx_question_content_blocks_group ON question_content_blocks(group_id) WHERE group_id IS NOT NULL;
CREATE INDEX idx_question_content_blocks_option ON question_content_blocks(option_id) WHERE option_id IS NOT NULL;

-- All billable AI operations share this task table so the partial unique index
-- enforces one queued/running task per user across imports, answers, and reports.
CREATE TABLE ai_tasks (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT, kind text NOT NULL CHECK(kind IN ('import','answer_generation','learning_report')), status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','cancelled','timed_out')), deadline_at timestamptz NOT NULL, price_snapshot jsonb NOT NULL, estimated_credits numeric(14,2) NOT NULL CHECK(estimated_credits>=0), reserved_credits numeric(14,2) NOT NULL DEFAULT 0 CHECK(reserved_credits>=0), settled_credits numeric(14,2) NOT NULL DEFAULT 0 CHECK(settled_credits>=0), refunded_credits numeric(14,2) NOT NULL DEFAULT 0 CHECK(refunded_credits>=0), result jsonb, error jsonb, created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,user_id), CHECK(deadline_at>created_at AND deadline_at<=created_at+interval '180 seconds'), CHECK((status='queued') = (started_at IS NULL AND finished_at IS NULL)), CHECK((status='running') = (started_at IS NOT NULL AND finished_at IS NULL)), CHECK((status IN ('succeeded','failed','cancelled','timed_out')) = (finished_at IS NOT NULL)));
CREATE UNIQUE INDEX uq_ai_tasks_one_active_user ON ai_tasks(user_id) WHERE status IN ('queued','running');
CREATE TABLE ai_task_calls (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, task_id bigint NOT NULL REFERENCES ai_tasks(id) ON DELETE CASCADE, model_id text NOT NULL CHECK(btrim(model_id)<>''), input_tokens integer NOT NULL CHECK(input_tokens>=0), output_tokens integer NOT NULL CHECK(output_tokens>=0), input_price_per_1k numeric(14,6) NOT NULL CHECK(input_price_per_1k>=0), output_price_per_1k numeric(14,6) NOT NULL CHECK(output_price_per_1k>=0), call_kind text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_ai_task_calls_task ON ai_task_calls(task_id);
ALTER TABLE credit_ledger ADD CONSTRAINT fk_credit_ledger_order_user FOREIGN KEY(order_id,user_id) REFERENCES payment_orders(id,user_id) ON DELETE RESTRICT;
ALTER TABLE credit_ledger ADD CONSTRAINT fk_credit_ledger_task_user FOREIGN KEY(ai_task_id,user_id) REFERENCES ai_tasks(id,user_id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX uq_credit_ledger_order_derived ON credit_ledger(order_id,kind) WHERE order_id IS NOT NULL AND kind IN ('purchase','bonus','payment_refund');
CREATE INDEX idx_credit_ledger_task ON credit_ledger(ai_task_id) WHERE ai_task_id IS NOT NULL;

-- Import rows retain source lifecycle metadata but never embed original document bytes.
CREATE TABLE question_import_jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, ai_task_id bigint NOT NULL UNIQUE,
  created_by bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT, bank_id bigint NOT NULL,
  source_type text NOT NULL CHECK(source_type IN ('text','docx','pdf','xlsx')),
  source_file_name varchar(255), source_storage_path text,
  source_size_bytes integer CHECK(source_size_bytes>0 AND source_size_bytes<=26214400),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','completed','failed','cancelled','timed_out')),
  retry_count integer NOT NULL DEFAULT 0 CHECK(retry_count>=0), retry_expires_at timestamptz,
  source_deleted_at timestamptz, completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((source_storage_path IS NULL) = (source_size_bytes IS NULL)),
  CHECK((status IN ('queued','processing')) = (completed_at IS NULL)),
  CHECK((status='failed') = (retry_expires_at IS NOT NULL)),
  CHECK(status<>'failed' OR (retry_expires_at>completed_at AND retry_expires_at<=completed_at+interval '7 days')),
  CHECK(source_deleted_at IS NULL OR status NOT IN ('queued','processing')),
  CHECK(status<>'cancelled' OR source_deleted_at IS NOT NULL)
);
ALTER TABLE question_import_jobs ADD CONSTRAINT fk_import_task_creator FOREIGN KEY(ai_task_id,created_by) REFERENCES ai_tasks(id,user_id) ON DELETE RESTRICT;
ALTER TABLE question_import_jobs ADD CONSTRAINT fk_import_bank_creator FOREIGN KEY(bank_id,created_by) REFERENCES question_banks(id,owner_user_id) ON DELETE RESTRICT;
CREATE INDEX idx_question_import_jobs_bank ON question_import_jobs(bank_id);
CREATE INDEX idx_question_import_jobs_retry ON question_import_jobs(retry_expires_at) WHERE status='failed' AND source_deleted_at IS NULL;
ALTER TABLE questions ADD CONSTRAINT fk_questions_source_job FOREIGN KEY(source_job_id) REFERENCES question_import_jobs(id) ON DELETE SET NULL;
CREATE TABLE question_import_job_events (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, job_id bigint NOT NULL REFERENCES question_import_jobs(id) ON DELETE CASCADE, stage text NOT NULL, status text NOT NULL CHECK(status IN ('queued','processing','completed','failed','cancelled','warning','info')), payload jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_question_import_job_events_job ON question_import_job_events(job_id,id);
CREATE TABLE question_import_job_outputs (job_id bigint NOT NULL REFERENCES question_import_jobs(id) ON DELETE CASCADE, question_id bigint NOT NULL REFERENCES questions(id) ON DELETE CASCADE, confidence numeric(4,3) CHECK(confidence BETWEEN 0 AND 1), review_required boolean NOT NULL DEFAULT false, PRIMARY KEY(job_id,question_id));
CREATE INDEX idx_question_import_job_outputs_question ON question_import_job_outputs(question_id);

-- Session questions are immutable snapshots. Answers and derived statistics remain
-- scoped by user, bank, and question so a bank reset cannot affect another bank.
CREATE TABLE practice_sessions (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE, bank_id bigint NOT NULL REFERENCES question_banks(id) ON DELETE RESTRICT, mode text NOT NULL CHECK(mode IN ('all','wrong','type','exam')), status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','abandoned')), started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,user_id,bank_id), CHECK((status='active')=(completed_at IS NULL)));
CREATE INDEX idx_practice_sessions_user_bank ON practice_sessions(user_id,bank_id,started_at DESC);
CREATE TABLE practice_session_questions (session_id bigint NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE, question_id bigint NOT NULL REFERENCES questions(id) ON DELETE RESTRICT, position integer NOT NULL CHECK(position>0), PRIMARY KEY(session_id,question_id), UNIQUE(session_id,position));
CREATE INDEX idx_practice_session_questions_question ON practice_session_questions(question_id);
CREATE TABLE practice_answers (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, session_id bigint NOT NULL, user_id bigint NOT NULL, bank_id bigint NOT NULL, question_id bigint NOT NULL, answer_payload jsonb NOT NULL CHECK(jsonb_typeof(answer_payload)='object'), is_correct boolean, score numeric(10,2) CHECK(score>=0), max_score numeric(10,2) CHECK(max_score>=0 AND (score IS NULL OR score<=max_score)), answered_at timestamptz NOT NULL DEFAULT now(), UNIQUE(session_id,question_id), FOREIGN KEY(session_id,user_id,bank_id) REFERENCES practice_sessions(id,user_id,bank_id) ON DELETE CASCADE, FOREIGN KEY(session_id,question_id) REFERENCES practice_session_questions(session_id,question_id) ON DELETE RESTRICT, UNIQUE(id,user_id,bank_id,question_id));
CREATE TABLE user_question_stats (user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE, bank_id bigint NOT NULL REFERENCES question_banks(id) ON DELETE CASCADE, question_id bigint NOT NULL REFERENCES questions(id) ON DELETE CASCADE, attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0), correct_count integer NOT NULL DEFAULT 0 CHECK(correct_count>=0 AND correct_count<=attempt_count), wrong_count integer NOT NULL DEFAULT 0 CHECK(wrong_count>=0 AND wrong_count<=attempt_count), last_answer_id bigint, last_answered_at timestamptz, PRIMARY KEY(user_id,bank_id,question_id), FOREIGN KEY(last_answer_id,user_id,bank_id,question_id) REFERENCES practice_answers(id,user_id,bank_id,question_id));

-- Future study-group persistence. Invitations store only one-use token hashes.
CREATE TABLE study_groups (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, owner_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT, name varchar(100) NOT NULL CHECK(btrim(name)<>''), description text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE study_group_members (group_id bigint NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE, user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE, status text NOT NULL DEFAULT 'accepted' CHECK(status IN ('accepted','removed','left')), joined_at timestamptz NOT NULL DEFAULT now(), left_at timestamptz, PRIMARY KEY(group_id,user_id));
CREATE TABLE study_group_invitations (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, group_id bigint NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE, created_by bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT, token_hash bytea NOT NULL UNIQUE, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','revoked','expired')), accepted_by bigint REFERENCES users(id) ON DELETE RESTRICT, expires_at timestamptz NOT NULL DEFAULT(now()+interval '7 days'), used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), CHECK(expires_at>created_at), CHECK((status='accepted' AND accepted_by IS NOT NULL AND used_at IS NOT NULL) OR (status<>'accepted' AND accepted_by IS NULL AND used_at IS NULL)));
CREATE TABLE study_group_banks (group_id bigint NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE, bank_id bigint NOT NULL REFERENCES question_banks(id) ON DELETE CASCADE, linked_by bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT, PRIMARY KEY(group_id,bank_id));
CREATE INDEX idx_study_group_banks_bank ON study_group_banks(bank_id);

-- Internal LangGraph checkpoint layout; these rows carry no product resource data.
CREATE TABLE checkpoint_migrations (v integer PRIMARY KEY);
CREATE TABLE checkpoints (thread_id text NOT NULL, checkpoint_ns text NOT NULL DEFAULT '', checkpoint_id text NOT NULL, parent_checkpoint_id text, type text, checkpoint jsonb NOT NULL, metadata jsonb NOT NULL DEFAULT '{}', PRIMARY KEY(thread_id,checkpoint_ns,checkpoint_id));
CREATE TABLE checkpoint_blobs (thread_id text NOT NULL, checkpoint_ns text NOT NULL DEFAULT '', channel text NOT NULL, version text NOT NULL, type text NOT NULL, blob bytea, PRIMARY KEY(thread_id,checkpoint_ns,channel,version));
CREATE TABLE checkpoint_writes (thread_id text NOT NULL, checkpoint_ns text NOT NULL DEFAULT '', checkpoint_id text NOT NULL, task_id text NOT NULL, task_path text NOT NULL DEFAULT '', idx integer NOT NULL, channel text NOT NULL, type text, blob bytea NOT NULL, PRIMARY KEY(thread_id,checkpoint_ns,checkpoint_id,task_id,idx));
INSERT INTO checkpoint_migrations(v) SELECT generate_series(0,9);

-- Business constraint functions. Tree validators take transaction advisory locks
-- before recursive checks so concurrent reparenting cannot create cycles.
CREATE FUNCTION validate_bank_state() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (TG_OP='INSERT' AND NEW.status<>'private') OR (TG_OP='UPDATE' AND (NEW.owner_user_id<>OLD.owner_user_id OR NEW.subject_id<>OLD.subject_id OR (NEW.status<>OLD.status AND NOT ((OLD.status='private' AND NEW.status='public') OR (OLD.status='public' AND NEW.status='banned') OR (OLD.status='banned' AND NEW.status='public'))))) THEN RAISE EXCEPTION 'invalid bank change' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE FUNCTION validate_subset_tree() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE parent_depth integer := 0; subtree_depth integer; BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('bank-subset:' || NEW.bank_id::text, 0));
 IF TG_OP='UPDATE' AND NEW.bank_id<>OLD.bank_id THEN RAISE EXCEPTION 'subset bank is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.parent_id IS NOT NULL THEN
  WITH RECURSIVE tree(id,parent_id,depth) AS (SELECT id,parent_id,1 FROM bank_subsets WHERE id=NEW.parent_id UNION ALL SELECT s.id,s.parent_id,t.depth+1 FROM bank_subsets s JOIN tree t ON s.id=t.parent_id) SELECT max(tree.depth) INTO parent_depth FROM tree;
  IF NEW.parent_id=NEW.id OR EXISTS(WITH RECURSIVE ancestors(id,parent_id) AS (SELECT id,parent_id FROM bank_subsets WHERE id=NEW.parent_id UNION ALL SELECT s.id,s.parent_id FROM bank_subsets s JOIN ancestors a ON s.id=a.parent_id) SELECT 1 FROM ancestors WHERE id=NEW.id) THEN RAISE EXCEPTION 'invalid subset tree' USING ERRCODE='23514'; END IF;
 END IF;
 WITH RECURSIVE descendants(id,depth) AS (SELECT NEW.id,1 UNION ALL SELECT s.id,d.depth+1 FROM bank_subsets s JOIN descendants d ON s.parent_id=d.id) SELECT max(depth) INTO subtree_depth FROM descendants;
 IF parent_depth+subtree_depth>3 THEN RAISE EXCEPTION 'invalid subset tree' USING ERRCODE='23514'; END IF;
 RETURN NEW; END $$;
CREATE FUNCTION validate_knowledge_tree() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('knowledge-point:' || NEW.subject_id, 0));
 IF TG_OP='UPDATE' AND NEW.subject_id<>OLD.subject_id THEN RAISE EXCEPTION 'knowledge point subject is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.parent_id IS NOT NULL AND EXISTS(WITH RECURSIVE tree(id,parent_id) AS (SELECT id,parent_id FROM knowledge_points WHERE id=NEW.parent_id UNION ALL SELECT k.id,k.parent_id FROM knowledge_points k JOIN tree t ON k.id=t.parent_id) SELECT 1 FROM tree WHERE id=NEW.id) THEN RAISE EXCEPTION 'knowledge point cycle' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE FUNCTION validate_bank_question_owner() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM question_banks b JOIN questions q ON q.id=NEW.question_id WHERE b.id=NEW.bank_id AND (b.owner_user_id<>q.owner_user_id OR b.subject_id<>q.subject_id)) THEN RAISE EXCEPTION 'question owner and subject must match bank' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE FUNCTION validate_bank_group_owner() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM question_banks b JOIN question_groups g ON g.id=NEW.group_id WHERE b.id=NEW.bank_id AND (b.owner_user_id<>g.owner_user_id OR b.subject_id<>g.subject_id)) THEN RAISE EXCEPTION 'group owner and subject must match bank' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE FUNCTION validate_group_question_owner() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM question_groups g JOIN questions q ON q.id=NEW.question_id WHERE g.id=NEW.group_id AND (g.owner_user_id<>q.owner_user_id OR g.subject_id<>q.subject_id)) THEN RAISE EXCEPTION 'question owner and subject must match group' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE FUNCTION assert_question_publishable(qid bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE mode text; variant text; payload jsonb;
BEGIN
 SELECT q.answer_mode,q.choice_variant,k.answer_payload INTO mode,variant,payload
 FROM questions q LEFT JOIN question_answer_keys k
   ON k.question_id=q.id AND k.is_primary AND k.answer_mode=q.answer_mode
 WHERE q.id=qid AND q.status='active';
 IF NOT FOUND THEN RETURN; END IF;
 IF payload IS NULL OR jsonb_typeof(payload)<>'object' OR payload='{}'::jsonb THEN
  RAISE EXCEPTION 'active question has incomplete answer' USING ERRCODE='23514';
 END IF;
 IF mode='choice' THEN
  IF (SELECT count(*) FROM question_options WHERE question_id=qid)<2
     OR jsonb_typeof(payload->'correct') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'correct')=0
     OR (variant='single' AND jsonb_array_length(payload->'correct')<>1)
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'correct') v
               WHERE jsonb_typeof(v)<>'string' OR NOT EXISTS(
                 SELECT 1 FROM question_options o WHERE o.question_id=qid AND o.option_label=v #>> '{}')) THEN
   RAISE EXCEPTION 'active question has incomplete answer' USING ERRCODE='23514';
  END IF;
 ELSIF mode='true_false' AND jsonb_typeof(payload->'answer') IS DISTINCT FROM 'boolean' THEN
  RAISE EXCEPTION 'active question has incomplete answer' USING ERRCODE='23514';
 ELSIF mode='fill_blank' AND (jsonb_typeof(payload->'answers') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'answers')=0
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'answers') v WHERE jsonb_typeof(v)<>'string' OR btrim(v #>> '{}')='')) THEN
  RAISE EXCEPTION 'active question has incomplete answer' USING ERRCODE='23514';
 ELSIF mode='short_answer' AND (jsonb_typeof(payload->'answer') IS DISTINCT FROM 'string' OR btrim(payload->>'answer')='') THEN
  RAISE EXCEPTION 'active question has incomplete answer' USING ERRCODE='23514';
 END IF;
END $$;
CREATE FUNCTION validate_active_question() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (TG_OP='INSERT' AND NEW.status<>'draft') OR (TG_OP='UPDATE' AND (NEW.owner_user_id<>OLD.owner_user_id OR NEW.subject_id<>OLD.subject_id OR NOT ((OLD.status='draft' AND NEW.status IN ('draft','active')) OR (OLD.status='active' AND NEW.status IN ('active','archived')) OR (OLD.status='archived' AND NEW.status='archived')))) THEN RAISE EXCEPTION 'invalid question change' USING ERRCODE='23514'; END IF;
 PERFORM assert_question_publishable(NEW.id); RETURN NEW; END $$;
CREATE FUNCTION validate_group_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (TG_OP='INSERT' AND NEW.status<>'draft') OR (TG_OP='UPDATE' AND (NEW.owner_user_id<>OLD.owner_user_id OR NEW.subject_id<>OLD.subject_id OR NOT ((OLD.status='draft' AND NEW.status IN ('draft','active')) OR (OLD.status='active' AND NEW.status IN ('active','archived')) OR (OLD.status='archived' AND NEW.status='archived')))) THEN RAISE EXCEPTION 'invalid group change' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE FUNCTION validate_question_knowledge_subject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM questions q JOIN knowledge_points k ON k.id=NEW.knowledge_point_id WHERE q.id=NEW.question_id AND q.subject_id<>k.subject_id) THEN RAISE EXCEPTION 'knowledge point subject must match question' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE FUNCTION validate_payment_order_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.user_id<>OLD.user_id OR NEW.kind<>OLD.kind OR NEW.merchant_order_no<>OLD.merchant_order_no OR NEW.app_id<>OLD.app_id OR NEW.mch_id<>OLD.mch_id OR NEW.amount_cents<>OLD.amount_cents OR NEW.currency<>OLD.currency OR NEW.credits_amount IS DISTINCT FROM OLD.credits_amount OR NEW.expires_at<>OLD.expires_at OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.request_hash<>OLD.request_hash OR (OLD.wechat_transaction_id IS NOT NULL AND NEW.wechat_transaction_id IS DISTINCT FROM OLD.wechat_transaction_id) OR NOT ((OLD.status='pending' AND NEW.status IN ('pending','paid','expired','closed')) OR (OLD.status='paid' AND NEW.status IN ('paid','refunded')) OR (OLD.status='expired' AND NEW.status IN ('expired','paid')) OR (OLD.status IN ('closed','refunded') AND NEW.status=OLD.status)) OR (NEW.status='refunded' AND NOT EXISTS(SELECT 1 FROM payment_refunds r WHERE r.order_id=NEW.id AND r.status='succeeded')) THEN RAISE EXCEPTION 'invalid payment order change' USING ERRCODE='23514'; END IF;
 END IF; RETURN NEW; END $$;
CREATE FUNCTION validate_refund() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM payment_orders o WHERE o.id=NEW.order_id AND o.status='paid' AND o.amount_cents=NEW.amount_cents) THEN RAISE EXCEPTION 'refund requires paid order exact amount' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (NEW.order_id<>OLD.order_id OR NEW.initiated_by<>OLD.initiated_by OR NEW.merchant_refund_no<>OLD.merchant_refund_no OR NEW.amount_cents<>OLD.amount_cents OR (OLD.wechat_refund_id IS NOT NULL AND NEW.wechat_refund_id IS DISTINCT FROM OLD.wechat_refund_id) OR (OLD.processed_at IS NOT NULL AND NEW.processed_at IS DISTINCT FROM OLD.processed_at) OR NOT (OLD.status='pending' OR NEW.status=OLD.status)) THEN RAISE EXCEPTION 'invalid refund change' USING ERRCODE='23514'; END IF;
 RETURN NEW; END $$;
CREATE FUNCTION validate_credit_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.kind IN ('purchase','bonus','release','failure_refund') AND NEW.amount<=0)
    OR (NEW.kind IN ('reserve','settle','payment_refund') AND NEW.amount>=0)
    OR (NEW.kind IN ('purchase','bonus','payment_refund') AND NEW.order_id IS NULL)
    OR (NEW.kind IN ('reserve','settle','release','failure_refund') AND NEW.ai_task_id IS NULL)
    OR (NEW.kind='purchase' AND NOT EXISTS(SELECT 1 FROM payment_orders WHERE id=NEW.order_id AND kind='credits' AND status='paid' AND NEW.amount=credits_amount))
    OR (NEW.kind='bonus' AND NOT EXISTS(SELECT 1 FROM payment_orders WHERE id=NEW.order_id AND kind='pro' AND status='paid' AND NEW.amount=200))
    OR (NEW.kind='payment_refund' AND NOT EXISTS(SELECT 1 FROM payment_orders WHERE id=NEW.order_id AND status='refunded' AND NEW.amount=CASE kind WHEN 'pro' THEN -200 ELSE -credits_amount END))
 THEN RAISE EXCEPTION 'invalid credit ledger direction or reference' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE FUNCTION validate_import_task() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM ai_tasks WHERE id=NEW.ai_task_id AND kind='import') THEN RAISE EXCEPTION 'import job requires import AI task' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE FUNCTION validate_ai_task_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (OLD.status IN ('succeeded','failed','cancelled','timed_out') AND NOT (
      OLD.status='failed' AND NEW.status='queued' AND OLD.kind='import'
      AND NEW.result IS NULL AND NEW.error IS NULL
      AND EXISTS(SELECT 1 FROM question_import_jobs j WHERE j.ai_task_id=OLD.id AND j.status='failed'
                 AND j.source_deleted_at IS NULL AND j.source_storage_path IS NOT NULL AND j.retry_expires_at>now())))
    OR NEW.user_id<>OLD.user_id OR NEW.kind<>OLD.kind OR NEW.deadline_at<>OLD.deadline_at
    OR NEW.price_snapshot IS DISTINCT FROM OLD.price_snapshot OR NEW.estimated_credits<>OLD.estimated_credits
    OR NEW.created_at<>OLD.created_at
    OR (OLD.status='queued' AND NEW.status NOT IN ('queued','running','failed','cancelled','timed_out'))
    OR (OLD.status='running' AND NEW.status NOT IN ('running','succeeded','failed','cancelled','timed_out'))
    OR (OLD.status='running' AND NEW.started_at IS DISTINCT FROM OLD.started_at)
 THEN RAISE EXCEPTION 'invalid AI task change' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE FUNCTION validate_import_job_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.ai_task_id<>OLD.ai_task_id OR NEW.created_by<>OLD.created_by OR NEW.bank_id<>OLD.bank_id
    OR NEW.source_type<>OLD.source_type OR NEW.source_file_name IS DISTINCT FROM OLD.source_file_name
    OR NEW.source_storage_path IS DISTINCT FROM OLD.source_storage_path OR NEW.source_size_bytes IS DISTINCT FROM OLD.source_size_bytes
    OR (OLD.status='queued' AND NEW.status NOT IN ('queued','processing','cancelled'))
    OR (OLD.status='processing' AND NEW.status NOT IN ('processing','completed','failed','cancelled','timed_out'))
    OR (OLD.status='failed' AND NEW.status NOT IN ('failed','queued'))
    OR (OLD.status IN ('completed','cancelled','timed_out') AND NEW.status<>OLD.status)
    OR (OLD.status='failed' AND NEW.status='queued' AND (OLD.source_deleted_at IS NOT NULL OR OLD.source_storage_path IS NULL OR OLD.retry_expires_at<=now() OR NEW.retry_count<>OLD.retry_count+1 OR NOT EXISTS(SELECT 1 FROM ai_tasks WHERE id=OLD.ai_task_id AND status='queued')))
    OR (NEW.retry_count<>OLD.retry_count AND NOT (OLD.status='failed' AND NEW.status='queued' AND NEW.retry_count=OLD.retry_count+1))
    OR (OLD.status='failed' AND NEW.retry_expires_at IS DISTINCT FROM OLD.retry_expires_at AND NOT (NEW.status='queued' AND NEW.retry_expires_at IS NULL))
    OR (OLD.status IN ('completed','failed','cancelled','timed_out') AND NEW.completed_at IS DISTINCT FROM OLD.completed_at AND NOT (OLD.status='failed' AND NEW.status='queued' AND NEW.completed_at IS NULL))
    OR (NEW.source_deleted_at IS NOT NULL AND NEW.status IN ('queued','processing'))
 THEN RAISE EXCEPTION 'invalid import job change' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE FUNCTION validate_import_retry_alignment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.kind='import' AND NEW.status='queued' AND EXISTS(
   SELECT 1 FROM question_import_jobs WHERE ai_task_id=NEW.id AND status<>'queued'
 ) THEN RAISE EXCEPTION 'AI task and import job retry must be queued together' USING ERRCODE='23514'; END IF;
 RETURN NEW; END $$;
CREATE FUNCTION validate_payment_order_entitlement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.status<>'pending' OR (NEW.kind='pro' AND EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND paid_pro_at IS NOT NULL)) OR (NEW.kind='credits' AND NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND paid_pro_at IS NOT NULL)) THEN RAISE EXCEPTION 'invalid payment entitlement' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE FUNCTION validate_payment_fulfillment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o payment_orders%ROWTYPE;
BEGIN
 SELECT * INTO o FROM payment_orders WHERE id=NEW.id;
 IF o.status IN ('paid','refunded') THEN
  IF o.kind='pro' AND (NOT EXISTS(SELECT 1 FROM credit_ledger WHERE order_id=o.id AND kind='bonus' AND amount=200)
     OR (o.status='paid' AND NOT EXISTS(SELECT 1 FROM users WHERE id=o.user_id AND paid_pro_at IS NOT NULL))) THEN
   RAISE EXCEPTION 'paid Pro order requires entitlement and bonus' USING ERRCODE='23514';
  ELSIF o.kind='credits' AND NOT EXISTS(SELECT 1 FROM credit_ledger WHERE order_id=o.id AND kind='purchase' AND amount=o.credits_amount) THEN
   RAISE EXCEPTION 'paid credits order requires purchase ledger' USING ERRCODE='23514';
  END IF;
 END IF;
 IF o.status='refunded' AND (NOT EXISTS(SELECT 1 FROM payment_refunds WHERE order_id=o.id AND status='succeeded')
    OR NOT EXISTS(SELECT 1 FROM credit_ledger WHERE order_id=o.id AND kind='payment_refund' AND amount=CASE o.kind WHEN 'pro' THEN -200 ELSE -o.credits_amount END)
    OR (o.kind='pro' AND EXISTS(SELECT 1 FROM users WHERE id=o.user_id AND paid_pro_at IS NOT NULL))) THEN
  RAISE EXCEPTION 'refunded order requires entitlement and credit reversal' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION validate_refund_fulfillment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM payment_refunds r JOIN payment_orders o ON o.id=r.order_id
           WHERE r.id=NEW.id AND r.status='succeeded' AND o.status<>'refunded') THEN
  RAISE EXCEPTION 'succeeded refund requires refunded order' USING ERRCODE='23514';
 END IF; RETURN NEW; END $$;
CREATE FUNCTION validate_study_group_owner() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.owner_user_id AND paid_pro_at IS NOT NULL AND status='active') THEN RAISE EXCEPTION 'paid Pro owner required' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE FUNCTION validate_study_group_bank() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM study_groups g JOIN question_banks b ON b.id=NEW.bank_id WHERE g.id=NEW.group_id AND g.owner_user_id=b.owner_user_id AND NEW.linked_by=g.owner_user_id) THEN RAISE EXCEPTION 'group owner may link only owned banks' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE FUNCTION validate_question_dependents() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE qid bigint; BEGIN
 qid := CASE WHEN TG_OP='DELETE' THEN OLD.question_id ELSE NEW.question_id END;
 IF TG_OP='UPDATE' AND OLD.question_id<>NEW.question_id THEN PERFORM assert_question_publishable(OLD.question_id); END IF;
 PERFORM assert_question_publishable(qid);
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END $$;
-- Audit and financial facts are append-only; practice answers permit scoped reset
-- deletion but reject mutation after submission.
CREATE FUNCTION reject_immutable_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is immutable', TG_TABLE_NAME USING ERRCODE='55000'; END $$;
CREATE FUNCTION apply_practice_stats() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO user_question_stats(user_id,bank_id,question_id,attempt_count,correct_count,wrong_count,last_answer_id,last_answered_at) VALUES(NEW.user_id,NEW.bank_id,NEW.question_id,1,CASE WHEN NEW.is_correct THEN 1 ELSE 0 END,CASE WHEN NEW.is_correct=false THEN 1 ELSE 0 END,NEW.id,NEW.answered_at) ON CONFLICT(user_id,bank_id,question_id) DO UPDATE SET attempt_count=user_question_stats.attempt_count+1,correct_count=user_question_stats.correct_count+CASE WHEN NEW.is_correct THEN 1 ELSE 0 END,wrong_count=user_question_stats.wrong_count+CASE WHEN NEW.is_correct=false THEN 1 ELSE 0 END,last_answer_id=CASE WHEN EXCLUDED.last_answered_at > user_question_stats.last_answered_at OR (EXCLUDED.last_answered_at = user_question_stats.last_answered_at AND EXCLUDED.last_answer_id > user_question_stats.last_answer_id) THEN EXCLUDED.last_answer_id ELSE user_question_stats.last_answer_id END,last_answered_at=GREATEST(user_question_stats.last_answered_at,EXCLUDED.last_answered_at); RETURN NEW; END $$;
CREATE FUNCTION apply_credit_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO credit_accounts(user_id,balance) VALUES(NEW.user_id,NEW.amount) ON CONFLICT(user_id) DO UPDATE SET balance=credit_accounts.balance+EXCLUDED.balance,updated_at=now(); RETURN NEW; END $$;
CREATE FUNCTION revoke_inactive_user_sessions() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.status='active' AND NEW.status='inactive' THEN UPDATE auth_sessions SET revoked_at=now(),revoke_reason='user_inactive' WHERE user_id=NEW.id AND revoked_at IS NULL; UPDATE refresh_tokens SET revoked_at=now() WHERE session_id IN(SELECT id FROM auth_sessions WHERE user_id=NEW.id) AND revoked_at IS NULL; END IF; RETURN NEW; END $$;
CREATE FUNCTION preserve_active_admin() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.role='admin' AND OLD.status='active' AND (NEW.role<>'admin' OR NEW.status<>'active') THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('active-admin',0));
  IF NOT EXISTS(SELECT 1 FROM users WHERE id<>OLD.id AND role='admin' AND status='active') THEN RAISE EXCEPTION 'cannot remove last active admin' USING ERRCODE='23514'; END IF;
 END IF; RETURN NEW; END $$;

-- Trigger wiring for timestamps, state transitions, ownership, accounting, and audits.
CREATE TRIGGER preserve_last_admin BEFORE UPDATE OF role,status ON users FOR EACH ROW EXECUTE FUNCTION preserve_active_admin();
CREATE TRIGGER users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER identities_updated BEFORE UPDATE ON wechat_identities FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER banks_updated BEFORE UPDATE ON question_banks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER bank_status BEFORE INSERT OR UPDATE ON question_banks FOR EACH ROW EXECUTE FUNCTION validate_bank_state();
CREATE TRIGGER subsets_updated BEFORE UPDATE ON bank_subsets FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER subsets_valid BEFORE INSERT OR UPDATE ON bank_subsets FOR EACH ROW EXECUTE FUNCTION validate_subset_tree();
CREATE TRIGGER groups_updated BEFORE UPDATE ON question_groups FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER groups_valid BEFORE INSERT OR UPDATE ON question_groups FOR EACH ROW EXECUTE FUNCTION validate_group_change();
CREATE TRIGGER questions_updated BEFORE UPDATE ON questions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE CONSTRAINT TRIGGER questions_active AFTER INSERT OR UPDATE OF status,answer_mode,choice_variant,owner_user_id,subject_id ON questions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_active_question();
CREATE TRIGGER bql_owner BEFORE INSERT OR UPDATE ON bank_question_links FOR EACH ROW EXECUTE FUNCTION validate_bank_question_owner();
CREATE TRIGGER bgl_owner BEFORE INSERT OR UPDATE ON bank_group_links FOR EACH ROW EXECUTE FUNCTION validate_bank_group_owner();
CREATE TRIGGER gql_owner BEFORE INSERT OR UPDATE ON group_question_links FOR EACH ROW EXECUTE FUNCTION validate_group_question_owner();
CREATE TRIGGER keys_updated BEFORE UPDATE ON question_answer_keys FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE CONSTRAINT TRIGGER keys_active AFTER INSERT OR UPDATE OR DELETE ON question_answer_keys DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_question_dependents();
CREATE CONSTRAINT TRIGGER options_active AFTER INSERT OR UPDATE OR DELETE ON question_options DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_question_dependents();
CREATE TRIGGER kp_updated BEFORE UPDATE ON knowledge_points FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER kp_valid BEFORE INSERT OR UPDATE ON knowledge_points FOR EACH ROW EXECUTE FUNCTION validate_knowledge_tree();
CREATE TRIGGER qkp_subject BEFORE INSERT OR UPDATE ON question_knowledge_points FOR EACH ROW EXECUTE FUNCTION validate_question_knowledge_subject();
CREATE TRIGGER payment_order_entitlement BEFORE INSERT ON payment_orders FOR EACH ROW EXECUTE FUNCTION validate_payment_order_entitlement();
CREATE TRIGGER payment_order_valid BEFORE UPDATE ON payment_orders FOR EACH ROW EXECUTE FUNCTION validate_payment_order_change();
CREATE CONSTRAINT TRIGGER payment_fulfillment AFTER INSERT OR UPDATE OF status ON payment_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_payment_fulfillment();
CREATE TRIGGER refund_valid BEFORE INSERT OR UPDATE ON payment_refunds FOR EACH ROW EXECUTE FUNCTION validate_refund();
CREATE CONSTRAINT TRIGGER refund_fulfillment AFTER INSERT OR UPDATE OF status ON payment_refunds DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_refund_fulfillment();
CREATE TRIGGER refund_immutable BEFORE DELETE ON payment_refunds FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER ai_tasks_valid BEFORE UPDATE ON ai_tasks FOR EACH ROW EXECUTE FUNCTION validate_ai_task_change();
CREATE TRIGGER task_updated BEFORE UPDATE ON ai_tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE CONSTRAINT TRIGGER import_retry_alignment AFTER UPDATE OF status ON ai_tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_import_retry_alignment();
CREATE TRIGGER ai_task_calls_immutable BEFORE UPDATE OR DELETE ON ai_task_calls FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER imports_updated BEFORE UPDATE ON question_import_jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER imports_valid BEFORE UPDATE ON question_import_jobs FOR EACH ROW EXECUTE FUNCTION validate_import_job_change();
CREATE TRIGGER imports_task BEFORE INSERT OR UPDATE OF ai_task_id ON question_import_jobs FOR EACH ROW EXECUTE FUNCTION validate_import_task();
CREATE TRIGGER import_events_immutable BEFORE UPDATE OR DELETE ON question_import_job_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER sessions_updated BEFORE UPDATE ON practice_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER answer_stats AFTER INSERT ON practice_answers FOR EACH ROW EXECUTE FUNCTION apply_practice_stats();
CREATE TRIGGER answers_immutable BEFORE UPDATE ON practice_answers FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER ledger_valid BEFORE INSERT ON credit_ledger FOR EACH ROW EXECUTE FUNCTION validate_credit_ledger();
CREATE TRIGGER ledger_apply AFTER INSERT ON credit_ledger FOR EACH ROW EXECUTE FUNCTION apply_credit_ledger();
CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON credit_ledger FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
-- Append-only refund notification/reconciliation history.
CREATE TABLE payment_refund_events (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, refund_id bigint NOT NULL REFERENCES payment_refunds(id) ON DELETE RESTRICT, status text NOT NULL CHECK(status IN ('pending','succeeded','failed','closed')), details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE TRIGGER refund_events_immutable BEFORE UPDATE OR DELETE ON payment_refund_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER groups_owner BEFORE INSERT OR UPDATE OF owner_user_id ON study_groups FOR EACH ROW EXECUTE FUNCTION validate_study_group_owner();
CREATE TRIGGER group_banks_owner BEFORE INSERT OR UPDATE ON study_group_banks FOR EACH ROW EXECUTE FUNCTION validate_study_group_bank();
CREATE TRIGGER admin_audits_immutable BEFORE UPDATE OR DELETE ON admin_audits FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER user_inactive_revoke AFTER UPDATE OF status ON users FOR EACH ROW EXECUTE FUNCTION revoke_inactive_user_sessions();
