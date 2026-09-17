import os
import uuid
from pathlib import Path

import psycopg


def test_migration_retains_answers_and_recovers_only_real_source():
    root=Path(__file__).parents[2]
    schema='migration_'+uuid.uuid4().hex
    with psycopg.connect(os.environ['TEST_DATABASE_URL'],autocommit=True) as db:
        db.execute(f'CREATE SCHEMA "{schema}"')
        try:
            db.execute(f'SET search_path TO "{schema}"')
            db.execute((Path(__file__).parent/'fixtures/schema_before_completeness.sql').read_text())
            db.execute("insert into question_banks(subject_id,name) values('general','旧题库')")
            db.execute("insert into questions(bank_id,subject_id,question_type_id,answer_mode,stem,analysis,status) values(1,'general','true_false','true_false','旧题一','原有解析','active'),(1,'general','true_false','true_false','旧题二',null,'active')")
            db.execute("insert into question_answer_keys(question_id,version,answer_payload) values(1,1,'{\"answer\":false}'),(2,1,'{\"answer\":true}')")
            db.execute("insert into ai_tasks(kind,status,result) values('import','succeeded','{\"questions\":[{\"sourceText\":\"可追溯的原文\"}]}')")
            db.execute("insert into question_import_jobs(bank_id,ai_task_id,file_name,source_type) values(1,1,'old.txt','text')")
            db.execute('insert into question_import_job_outputs values(1,0,1)')
            db.execute("insert into practice_sessions(bank_id,mode) values(1,'all')")
            db.execute('insert into practice_session_questions(session_id,bank_id,question_id,position,answer_key_id) values(1,1,1,1,1)')
            db.execute((root/'db/migrations/003_question_completeness.sql').read_text())
            rows=db.execute('select status,source_text,missing_fields from questions order by id').fetchall()
            assert rows==[('active','可追溯的原文',[]),('draft',None,['analysis','sourceText'])]
            assert db.execute('select answer_key_id from practice_session_questions').fetchone()==(1,)
            assert db.execute('select count(*) from question_answer_keys').fetchone()==(2,)
            db.execute("update questions set missing_fields='{}',status='active' where id=2")
            assert db.execute('select status,missing_fields from questions where id=2').fetchone()==('draft',['analysis','sourceText'])
        finally:
            db.execute(f'DROP SCHEMA "{schema}" CASCADE')
