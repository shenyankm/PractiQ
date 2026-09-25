BEGIN IMMEDIATE;
CREATE TABLE banks(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE imports(id TEXT PRIMARY KEY,bank_id TEXT NOT NULL REFERENCES banks(id) ON DELETE CASCADE,digest TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(bank_id,digest));
CREATE TABLE assets(hash TEXT PRIMARY KEY,media TEXT NOT NULL,size INTEGER NOT NULL,path TEXT NOT NULL);
CREATE TABLE questions(
 id TEXT PRIMARY KEY, bank_id TEXT NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
 import_id TEXT REFERENCES imports(id) ON DELETE SET NULL,
 parent_id TEXT REFERENCES questions(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 position INTEGER NOT NULL,stem TEXT,mode TEXT,question_type TEXT,analysis TEXT,source_text TEXT,
 question_kind TEXT,instructions TEXT,
 source_score REAL,scoring_rubric TEXT,score_source_text TEXT,
 content_blocks TEXT NOT NULL CHECK(json_valid(content_blocks)),
 confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),needs_review INTEGER NOT NULL CHECK(needs_review IN(0,1)),
 missing_fields TEXT NOT NULL CHECK(json_valid(missing_fields)),favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN(0,1)));
CREATE INDEX questions_bank ON questions(bank_id,position);
CREATE INDEX questions_parent ON questions(parent_id,position);
CREATE TABLE option_sets(id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE);
CREATE TABLE question_options(owner_id TEXT NOT NULL REFERENCES option_sets(id) ON DELETE CASCADE,position INTEGER NOT NULL,label TEXT,content TEXT,PRIMARY KEY(owner_id,position),UNIQUE(owner_id,label));
CREATE TABLE choice_questions(question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,variant TEXT CHECK(variant IN('single','multiple')),option_set_id TEXT NOT NULL REFERENCES option_sets(id) DEFERRABLE INITIALLY DEFERRED,correct TEXT NOT NULL CHECK(json_valid(correct) AND json_type(correct) IN('array','null')));
CREATE TABLE true_false_questions(question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,value TEXT NOT NULL CHECK(json_valid(value) AND json_type(value) IN('true','false','null')));
CREATE TABLE fill_blank_questions(question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,blank_count INTEGER CHECK(blank_count BETWEEN 1 AND 100),answers TEXT NOT NULL CHECK(json_valid(answers) AND json_type(answers) IN('array','null')));
CREATE TABLE short_answer_questions(question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,answer TEXT NOT NULL CHECK(json_valid(answer) AND json_type(answer) IN('text','null')),source_language TEXT,target_language TEXT,writing_genre TEXT,min_words INTEGER,max_words INTEGER);
CREATE TABLE ordering_questions(question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,answer_order TEXT NOT NULL CHECK(json_valid(answer_order) AND json_type(answer_order) IN('array','null')));
CREATE TABLE matching_questions(question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,variant TEXT CHECK(variant IN('one_to_one','many_to_one')),matches TEXT NOT NULL CHECK(json_valid(matches) AND json_type(matches) IN('array','null')));
CREATE TABLE question_items(question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,position INTEGER NOT NULL,item_id INTEGER,side TEXT CHECK(side IN('left','right')),content TEXT,label TEXT,PRIMARY KEY(question_id,position));
CREATE TABLE reading_questions(question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,passage TEXT NOT NULL CHECK(json_valid(passage)));
CREATE TABLE word_bank_questions(question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,passage TEXT NOT NULL CHECK(json_valid(passage)),allow_reuse INTEGER NOT NULL CHECK(allow_reuse IN(0,1)),option_set_id TEXT NOT NULL REFERENCES option_sets(id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE cloze_questions(question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,passage TEXT NOT NULL CHECK(json_valid(passage)));
CREATE TABLE gap_fill_questions(question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,passage TEXT NOT NULL CHECK(json_valid(passage)));
CREATE TABLE listening_questions(question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,passage TEXT NOT NULL CHECK(json_valid(passage)),audio_ref TEXT NOT NULL CHECK(json_valid(audio_ref)),start_seconds REAL NOT NULL,end_seconds REAL,transcript TEXT NOT NULL CHECK(json_valid(transcript)),play_count INTEGER NOT NULL CHECK(play_count BETWEEN 1 AND 100));
CREATE TABLE sections(id TEXT PRIMARY KEY,bank_id TEXT NOT NULL REFERENCES banks(id) ON DELETE CASCADE,title TEXT NOT NULL,instructions TEXT);
CREATE TABLE section_questions(section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,PRIMARY KEY(section_id,question_id));
CREATE TABLE visuals(id TEXT PRIMARY KEY,bank_id TEXT NOT NULL REFERENCES banks(id) ON DELETE CASCADE,content TEXT NOT NULL CHECK(json_valid(content)),document_level INTEGER NOT NULL CHECK(document_level IN(0,1)));
CREATE TABLE question_visuals(visual_id TEXT NOT NULL REFERENCES visuals(id) ON DELETE CASCADE,question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,PRIMARY KEY(visual_id,question_id));
CREATE TABLE question_sources(question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,stage TEXT NOT NULL CHECK(stage IN('document_parse','vision_parse')),unit_index INTEGER NOT NULL CHECK(unit_index>=0),PRIMARY KEY(question_id,stage,unit_index));
CREATE TABLE import_warnings(import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,position INTEGER NOT NULL,message TEXT NOT NULL,PRIMARY KEY(import_id,position));
CREATE TABLE sessions(id TEXT PRIMARY KEY,bank_id TEXT,bank_title TEXT NOT NULL,created_at INTEGER NOT NULL,finished_at INTEGER,position INTEGER NOT NULL,mode TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'practice' CHECK(kind IN('practice','self_test','mock_exam')),deadline_at INTEGER,submitted_at INTEGER);
CREATE TABLE session_documents(session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,content TEXT NOT NULL CHECK(json_valid(content)));
CREATE TABLE listening_playback(session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,question_id TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0 CHECK(used>=0),position REAL NOT NULL DEFAULT 0 CHECK(position>=0),active INTEGER NOT NULL DEFAULT 0 CHECK(active IN(0,1)),updated_at INTEGER NOT NULL DEFAULT 0,active_elapsed_ms INTEGER NOT NULL DEFAULT 0 CHECK(active_elapsed_ms>=0),PRIMARY KEY(session_id,question_id));
CREATE TABLE attempts(session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,question_id TEXT,snapshot_question_id TEXT NOT NULL,answer TEXT NOT NULL DEFAULT 'null' CHECK(json_valid(answer)),auto_result INTEGER,result INTEGER,grade_kind TEXT NOT NULL DEFAULT 'ungraded',submitted_at INTEGER,skipped INTEGER NOT NULL DEFAULT 0,elapsed_ms INTEGER NOT NULL DEFAULT 0,max_cents INTEGER CHECK(max_cents > 0),earned_cents INTEGER CHECK(earned_cents>=0 AND earned_cents<=max_cents),flagged INTEGER NOT NULL DEFAULT 0 CHECK(flagged IN(0,1)),grading TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(grading)),PRIMARY KEY(session_id,ordinal));
CREATE INDEX attempts_question ON attempts(question_id,submitted_at DESC);
CREATE TABLE grade_requests(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),ordinal INTEGER NOT NULL,input TEXT NOT NULL CHECK(json_valid(input)),response TEXT CHECK(response IS NULL OR json_valid(response)),created_at INTEGER NOT NULL);
CREATE TABLE settings(id INTEGER PRIMARY KEY CHECK(id=1),base_url TEXT,model_id TEXT,oss_url TEXT,locale TEXT CHECK(locale IS NULL OR locale IN('zh-CN','en')));
INSERT INTO settings VALUES(1,NULL,NULL,NULL,NULL);
CREATE TABLE ai_imports(thread_id TEXT NOT NULL,digest TEXT NOT NULL,checkpoint_id TEXT NOT NULL,import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,PRIMARY KEY(thread_id,digest));
PRAGMA user_version=10;
COMMIT;
