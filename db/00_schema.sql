-- PractiQ personal schema. Apply only to a NEW, empty database.
BEGIN;
CREATE TABLE subjects (id varchar(32) PRIMARY KEY, display_name varchar(64) NOT NULL CHECK(btrim(display_name)<>''));
INSERT INTO subjects VALUES ('general','通用');
CREATE TABLE question_types (
 id varchar(64) PRIMARY KEY, subject_id varchar(32) NOT NULL REFERENCES subjects,
 display_name varchar(128) NOT NULL, answer_mode text NOT NULL CHECK(answer_mode IN ('choice','true_false','fill_blank','short_answer')),
 UNIQUE(subject_id,id,answer_mode)
);
INSERT INTO question_types VALUES ('choice','general','选择题','choice'),('true_false','general','判断题','true_false'),('fill_blank','general','填空题','fill_blank'),('short_answer','general','简答题','short_answer');
CREATE TABLE question_banks (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, subject_id varchar(32) NOT NULL REFERENCES subjects,
 name varchar(100) NOT NULL CHECK(btrim(name)<>''), description varchar(500),
 is_favorite boolean NOT NULL DEFAULT false, deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,subject_id)
);
CREATE TABLE bank_tags (bank_id bigint REFERENCES question_banks ON DELETE CASCADE, tag varchar(64) CHECK(btrim(tag)<>''), PRIMARY KEY(bank_id,tag));
CREATE TABLE bank_subsets (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, bank_id bigint NOT NULL REFERENCES question_banks,
 parent_id bigint, name varchar(100) NOT NULL CHECK(btrim(name)<>''), sort_order integer NOT NULL CHECK(sort_order>0),
 UNIQUE(id,bank_id), FOREIGN KEY(parent_id,bank_id) REFERENCES bank_subsets(id,bank_id), CHECK(parent_id IS DISTINCT FROM id)
);
CREATE TABLE question_groups (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, bank_id bigint NOT NULL REFERENCES question_banks,
 title varchar(1000) NOT NULL CHECK(btrim(title)<>''), instructions text,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','archived')),
 subset_id bigint, sort_order integer NOT NULL DEFAULT 1 CHECK(sort_order>0),
 UNIQUE(id,bank_id), FOREIGN KEY(subset_id,bank_id) REFERENCES bank_subsets(id,bank_id)
);
CREATE TABLE questions (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, bank_id bigint NOT NULL, subject_id varchar(32) NOT NULL,
 question_type_id varchar(64) NOT NULL, answer_mode text NOT NULL,
 choice_variant text CHECK(choice_variant IN ('single','multiple')), stem text NOT NULL CHECK(btrim(stem)<>''), analysis text,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','archived')), group_id bigint, subset_id bigint,
 sort_order integer NOT NULL DEFAULT 1 CHECK(sort_order>0), deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(bank_id,subject_id) REFERENCES question_banks(id,subject_id),
 FOREIGN KEY(subject_id,question_type_id,answer_mode) REFERENCES question_types(subject_id,id,answer_mode),
 FOREIGN KEY(group_id,bank_id) REFERENCES question_groups(id,bank_id),
 FOREIGN KEY(subset_id,bank_id) REFERENCES bank_subsets(id,bank_id),
 CHECK((answer_mode='choice')=(choice_variant IS NOT NULL)), UNIQUE(id,bank_id), UNIQUE(id,subject_id)
);
CREATE INDEX questions_bank ON questions(bank_id,sort_order,id) WHERE deleted_at IS NULL;
CREATE TABLE question_options (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, question_id bigint NOT NULL REFERENCES questions,
 option_label varchar(16) NOT NULL CHECK(btrim(option_label)<>''), content text NOT NULL CHECK(btrim(content)<>''),
 sort_order integer NOT NULL CHECK(sort_order>0), UNIQUE(question_id,option_label), UNIQUE(question_id,sort_order)
);
CREATE TABLE question_answer_keys (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, question_id bigint NOT NULL REFERENCES questions,
 version integer NOT NULL CHECK(version>0), is_primary boolean NOT NULL DEFAULT true,
 answer_payload jsonb NOT NULL, explanation_payload jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(question_id,version), UNIQUE(id,question_id)
);
CREATE UNIQUE INDEX one_primary_key ON question_answer_keys(question_id) WHERE is_primary;
CREATE TABLE knowledge_points (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, subject_id varchar(32) NOT NULL REFERENCES subjects,
 parent_id bigint, code varchar(128) NOT NULL CHECK(btrim(code)<>''), display_name varchar(256) NOT NULL CHECK(btrim(display_name)<>''),
 UNIQUE(subject_id,code), UNIQUE(id,subject_id), FOREIGN KEY(parent_id,subject_id) REFERENCES knowledge_points(id,subject_id), CHECK(parent_id IS DISTINCT FROM id)
);
CREATE TABLE question_knowledge_points (
 question_id bigint REFERENCES questions, knowledge_point_id bigint REFERENCES knowledge_points, subject_id varchar(32) NOT NULL,
 PRIMARY KEY(question_id,knowledge_point_id), FOREIGN KEY(question_id,subject_id) REFERENCES questions(id,subject_id),
 FOREIGN KEY(knowledge_point_id,subject_id) REFERENCES knowledge_points(id,subject_id)
);
CREATE TABLE media_assets (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, storage_path text NOT NULL UNIQUE, original_name varchar(255) NOT NULL,
 media_type text NOT NULL CHECK(media_type IN ('image','audio')), mime_type text NOT NULL,
 size_bytes integer NOT NULL CHECK(size_bytes>0 AND size_bytes<=10485760), checksum_sha256 char(64) NOT NULL,
 deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE media_links (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, media_id bigint NOT NULL REFERENCES media_assets,
 question_id bigint REFERENCES questions, group_id bigint REFERENCES question_groups, option_id bigint REFERENCES question_options,
 sort_order integer NOT NULL CHECK(sort_order>0), CHECK(num_nonnulls(question_id,group_id,option_id)=1),
 UNIQUE NULLS NOT DISTINCT(media_id,question_id,group_id,option_id)
);
CREATE TABLE question_content_blocks (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, question_id bigint REFERENCES questions, group_id bigint REFERENCES question_groups,
 part_type text NOT NULL CHECK(part_type IN ('text','formula','image','table','list','html','markdown','chart','diagram','qr_code')),
 sequence integer NOT NULL CHECK(sequence>0), payload jsonb NOT NULL, CHECK(num_nonnulls(question_id,group_id)=1)
);
CREATE TABLE practice_sessions (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, bank_id bigint NOT NULL REFERENCES question_banks,
 mode text NOT NULL CHECK(mode IN ('all','wrong','type','exam')), status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','abandoned')),
 started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,bank_id),
 CHECK((status='active')=(completed_at IS NULL))
);
CREATE TABLE practice_session_questions (
 session_id bigint NOT NULL REFERENCES practice_sessions ON DELETE CASCADE, bank_id bigint NOT NULL,
 question_id bigint NOT NULL, position integer NOT NULL CHECK(position>0), answer_key_id bigint NOT NULL,
 PRIMARY KEY(session_id,question_id), UNIQUE(session_id,position),
 FOREIGN KEY(session_id,bank_id) REFERENCES practice_sessions(id,bank_id) ON DELETE CASCADE,
 FOREIGN KEY(question_id,bank_id) REFERENCES questions(id,bank_id), FOREIGN KEY(answer_key_id,question_id) REFERENCES question_answer_keys(id,question_id)
);
CREATE TABLE practice_answers (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, session_id bigint NOT NULL, question_id bigint NOT NULL,
 answer_key_id bigint NOT NULL, answer_payload jsonb NOT NULL, is_correct boolean, score numeric, max_score numeric NOT NULL DEFAULT 1,
 duration_ms integer CHECK(duration_ms>=0), answered_at timestamptz NOT NULL DEFAULT now(), UNIQUE(session_id,question_id),
 FOREIGN KEY(session_id,question_id) REFERENCES practice_session_questions(session_id,question_id) ON DELETE CASCADE,
 FOREIGN KEY(answer_key_id,question_id) REFERENCES question_answer_keys(id,question_id), CHECK(score>=0 AND score<=max_score)
);
CREATE TABLE ai_tasks (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('import','answer_generation','learning_report','bank_metadata')),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','cancelled','timed_out')),
 source_question_id bigint REFERENCES questions, request_payload jsonb NOT NULL DEFAULT '{}', result jsonb, error jsonb,
 attempt integer NOT NULL DEFAULT 1 CHECK(attempt>0), worker_id uuid, worker_lease_until timestamptz,
 deadline_at timestamptz NOT NULL DEFAULT now()+interval '180 seconds', created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz
);
CREATE INDEX task_queue ON ai_tasks(status,created_at);
CREATE TABLE ai_task_calls (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, task_id bigint NOT NULL REFERENCES ai_tasks,
 attempt integer NOT NULL, call_id text NOT NULL, usage jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(task_id,attempt,call_id)
);
CREATE TABLE ai_report_sources (task_id bigint REFERENCES ai_tasks, answer_id bigint REFERENCES practice_answers ON DELETE CASCADE, PRIMARY KEY(task_id,answer_id));
CREATE TABLE question_import_jobs (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, bank_id bigint NOT NULL REFERENCES question_banks,
 ai_task_id bigint UNIQUE REFERENCES ai_tasks, file_name varchar(255) NOT NULL,
 source_type text NOT NULL CHECK(source_type IN ('text','csv','pdf','docx','xlsx','image')),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','completed','failed','cancelled')),
 source_storage_path text, source_checksum char(64), source_deleted_at timestamptz,
 retry_count integer NOT NULL DEFAULT 0, retry_expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE TABLE question_import_job_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, job_id bigint NOT NULL REFERENCES question_import_jobs,
 stage text NOT NULL, status text NOT NULL, payload jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE question_import_job_outputs (
 job_id bigint NOT NULL REFERENCES question_import_jobs, item_index integer NOT NULL, question_id bigint NOT NULL REFERENCES questions,
 PRIMARY KEY(job_id,item_index), UNIQUE(job_id,question_id)
);
CREATE TABLE request_idempotency (
 route text NOT NULL, idempotency_key varchar(128) NOT NULL, request_hash bytea NOT NULL,
 response_status integer, response_body bytea, response_type text,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours', PRIMARY KEY(route,idempotency_key)
);
CREATE FUNCTION prevent_tree_cycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cycle boolean;
BEGIN
 IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;
 EXECUTE format('WITH RECURSIVE ancestors AS (SELECT id,parent_id FROM %I WHERE id=$1 UNION SELECT p.id,p.parent_id FROM %I p JOIN ancestors a ON p.id=a.parent_id) SELECT EXISTS(SELECT 1 FROM ancestors WHERE id=$2)',TG_TABLE_NAME,TG_TABLE_NAME) INTO cycle USING NEW.parent_id,NEW.id;
 IF cycle THEN RAISE EXCEPTION 'Hierarchy cycle' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER subset_cycle BEFORE INSERT OR UPDATE ON bank_subsets FOR EACH ROW EXECUTE FUNCTION prevent_tree_cycle();
CREATE TRIGGER knowledge_cycle BEFORE INSERT OR UPDATE ON knowledge_points FOR EACH ROW EXECUTE FUNCTION prevent_tree_cycle();
CREATE FUNCTION immutable_answer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.answer_payload IS DISTINCT FROM OLD.answer_payload OR NEW.explanation_payload IS DISTINCT FROM OLD.explanation_payload OR NEW.question_id<>OLD.question_id OR NEW.version<>OLD.version THEN
 RAISE EXCEPTION 'Create a new answer version' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER answer_version BEFORE UPDATE ON question_answer_keys FOR EACH ROW EXECUTE FUNCTION immutable_answer();
COMMIT;
