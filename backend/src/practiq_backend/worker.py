"""Durable PostgreSQL worker. Run separately: python -m practiq_backend.worker."""

import base64
import hashlib
import logging
import signal
import threading
import uuid
from datetime import UTC, datetime

import httpx
from psycopg.types.json import Jsonb

from .content import QuestionIn, create_question
from .core import Error, Settings, bank, one, pool_for
from .media import safe_path
from .tasks import BankMetadataResult, event

log = logging.getLogger(__name__)


def fail(db, tid, status, error):
    db.execute(
        "update ai_tasks set status=%s,error=%s,finished_at=now(),updated_at=now(),worker_id=null,worker_lease_until=null where id=%s",
        (status, Jsonb(error), tid),
    )
    j = db.execute(
        "update question_import_jobs set status='failed',completed_at=now(),retry_expires_at=now()+interval '24 hours' where ai_task_id=%s returning id",
        (tid,),
    ).fetchone()
    if j:
        event(db, j["id"], "parse", "failed", error)


def claim(pool, worker):
    with pool.connection() as db:
        for t in db.execute(
            "select id from ai_tasks where status in ('queued','running') and deadline_at<=now() for update skip locked"
        ).fetchall():
            fail(db, t["id"], "timed_out", {"code": "AI_TIMEOUT", "message": "Task deadline exceeded"})
        t = db.execute(
            "select * from ai_tasks where deadline_at>now() and (status='queued' or (status='running' and worker_lease_until<now())) order by created_at,id for update skip locked limit 1"
        ).fetchone()
        if t is None:
            return None
        # Each reclaimed execution gets a distinct fencing generation.
        return one(
            db,
            "update ai_tasks set status='running',attempt=attempt+case when status='running' then 1 else 0 end,worker_id=%s,worker_lease_until=now()+interval '30 seconds',started_at=coalesce(started_at,now()),updated_at=now() where id=%s returning *",
            (worker, t["id"]),
        )


def heartbeat(pool, task, stop):
    while not stop.wait(8):
        try:
            with pool.connection() as db:
                changed = db.execute(
                    "update ai_tasks set worker_lease_until=now()+interval '30 seconds' where id=%s and worker_id=%s and attempt=%s and status='running' and deadline_at>now()",
                    (task["id"], task["worker_id"], task["attempt"]),
                ).rowcount
                if not changed:
                    return
        except Exception:
            log.exception("Worker heartbeat failed")
            return


def request_for(pool, settings, task):
    if task["kind"] != "import":
        return (
            {"answer_generation": "generate-answer", "learning_report": "learning-report", "bank_metadata": "bank-metadata"}[task["kind"]],
            task["request_payload"],
        )
    with pool.connection() as db:
        j = one(db, "select * from question_import_jobs where ai_task_id=%s", (task["id"],))
        bank(db, j["bank_id"])
    path = safe_path(settings.media_dir, j["source_storage_path"])
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != j["source_checksum"]:
        raise Error(409, "SOURCE_CHANGED", "Import source checksum mismatch")
    payload = {"sourceType": j["source_type"], "fileName": j["file_name"]}
    if j["source_type"] == "text":
        payload["text"] = data.decode("utf-8-sig")
    else:
        payload["fileBase64"] = base64.b64encode(data).decode()
        payload["mimeType"] = {
            "pdf": "application/pdf",
            "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "csv": "text/csv",
        }.get(j["source_type"], "application/octet-stream")
    return "parse-document", payload


def persist_import(db, task, result):
    j = one(db, "select * from question_import_jobs where ai_task_id=%s for update", (task["id"],))
    b = bank(db, j["bank_id"])
    questions = result.get("questions")
    groups = result.get("groups", [])
    if (
        not isinstance(questions, list)
        or not 1 <= len(questions) <= 1000
        or not isinstance(groups, list)
        or len(groups) > 1000
    ):
        raise ValueError("Invalid parser result")
    ids = []
    for i, q in enumerate(questions):
        old = db.execute(
            "select question_id from question_import_job_outputs where job_id=%s and item_index=%s",
            (j["id"], i),
        ).fetchone()
        if old:
            ids.append(old["question_id"])
            continue
        mode = q.get("answerMode")
        # Resolve only known types; preserve unknown classification as a missing field.
        found = db.execute(
            "select id from question_types where subject_id=%s and id=%s and (%s::text is null or answer_mode=%s)",
            (b["subject_id"], q.get("questionTypeId"), mode, mode),
        ).fetchone()
        payload = q.get("answerPayload")
        options = [
            {"label": o.get("label"), "content": o.get("content"), "isCorrect": False if o.get("isCorrect") is None else o["isCorrect"]}
            for o in ([] if q.get("options") is None else q["options"])
        ]
        variant = q.get("choiceVariant")
        body = QuestionIn(
            questionTypeId=found["id"] if found and q.get("questionTypeId") else None,
            answerMode=mode,
            stem=q.get("stem"),
            analysis=q.get("analysis"),
            sourceText=q.get("sourceText"),
            choiceVariant=variant,
            matchingVariant=q.get("matchingVariant"),
            items=[{"side": i.get("side"), "content": i.get("content")} for i in ([] if q.get("items") is None else q["items"])],
            status="draft",
            options=options,
            answerPayload=payload,
        )
        created = create_question(db, j["bank_id"], body, dependencies=[f for f in ("media", "material") if f in q.get("missingFields", [])])
        ids.append(created["id"])
        blocks = q.get("contentBlocks", [])
        if not isinstance(blocks, list) or len(blocks) > 1000:
            raise ValueError("Invalid content blocks")
        for sequence, block in enumerate(blocks, 1):
            db.execute(
                "insert into question_content_blocks(question_id,part_type,sequence,payload) values(%s,%s,%s,%s)",
                (created["id"], block["partType"], sequence, Jsonb(block)),
            )
        db.execute("insert into question_import_job_outputs values(%s,%s,%s)", (j["id"], i, created["id"]))
    for group in groups:
        indexes = group["questionIndexes"]
        if not isinstance(indexes, list) or any(
            type(i) is not int or i < 0 or i >= len(ids) for i in indexes
        ):
            raise ValueError("Invalid group question indexes")
        g = one(
            db,
            "insert into question_groups(bank_id,title,instructions) values(%s,%s,%s) returning id",
            (j["bank_id"], group["title"], group.get("instructions")),
        )
        for index in indexes:
            db.execute("update questions set group_id=%s where id=%s", (g["id"], ids[index]))
    db.execute(
        "update question_import_jobs set status='completed',completed_at=now() where id=%s", (j["id"],)
    )
    event(db, j["id"], "persist", "completed", {"questionCount": len(ids)})


def complete(pool, task, result, usage, error=None):
    # Record calls even when their result is late, cancelled or fails validation.
    with pool.connection() as db:
        for i, call in enumerate(usage):
            if not isinstance(call, dict):
                continue
            call_id = str(call.get("callId") or call.get("call_id") or i)
            db.execute(
                "insert into ai_task_calls(task_id,attempt,call_id,usage) values(%s,%s,%s,%s) on conflict do nothing",
                (task["id"], task["attempt"], call_id, Jsonb(call)),
            )
    with pool.connection() as db:
        current = one(db, "select * from ai_tasks where id=%s for update", (task["id"],))
        if (
            current["status"] != "running"
            or current["attempt"] != task["attempt"]
            or current["worker_id"] != task["worker_id"]
        ):
            return False
        now = datetime.now(UTC)
        if current["deadline_at"] <= now:
            fail(db, task["id"], "timed_out", {"code": "AI_TIMEOUT", "message": "Task deadline exceeded"})
            return False
        if current["worker_lease_until"] <= now:
            return False
        if error:
            fail(db, task["id"], "timed_out" if error.get("code") == "AI_TIMEOUT" else "failed", error)
            return False
        try:
            with db.transaction():
                if not isinstance(result, dict):
                    raise ValueError("AI response must contain an object")
                if task["kind"] == "bank_metadata":
                    result = BankMetadataResult.model_validate(result).model_dump()
                if task["kind"] == "import":
                    persist_import(db, task, result)
                elif task["kind"] == "answer_generation":
                    if not isinstance(result.get("answerPayload"), (dict, type(None))):
                        raise ValueError("AI answer must be an object or null")
                    missing = result.get("missingFields", [])
                    if not isinstance(missing, list) or any(not isinstance(field, str) for field in missing):
                        raise ValueError("missingFields must be a list of field names")
                    dependencies = [field for field in ("media", "material") if field in missing]
                    if dependencies:
                        db.execute("update questions set missing_dependencies=ARRAY(select distinct unnest(missing_dependencies || %s::text[])) where id=%s and stem is not distinct from %s and answer_mode is not distinct from %s", (dependencies, task["source_question_id"], task["request_payload"].get("stem"), task["request_payload"].get("answerMode")))
                elif task["kind"] == "learning_report" and not isinstance(result.get("summary"), str):
                    raise ValueError("AI response is missing a report summary")
                db.execute(
                    "update ai_tasks set status='succeeded',result=%s,finished_at=now(),updated_at=now(),worker_id=null,worker_lease_until=null where id=%s",
                    (Jsonb(result), task["id"]),
                )
        except Exception:
            log.exception("AI result validation/persistence failed for task %s", task["id"])
            fail(
                db,
                task["id"],
                "failed",
                {"code": "AI_RESULT_INVALID", "message": "AI result could not be validated or persisted"},
            )
            return False
    return True


def cleanup(pool, settings):
    with pool.connection() as db:
        jobs = db.execute(
            "select id,source_storage_path from question_import_jobs where source_storage_path is not null and source_deleted_at is null and (status in ('completed','cancelled') or (status='failed' and retry_expires_at<=now())) for update skip locked"
        ).fetchall()
        for j in jobs:
            # Each job owns its source path. Retrying a crash after unlink is safe.
            safe_path(settings.media_dir, j["source_storage_path"]).unlink(missing_ok=True)
            db.execute("update question_import_jobs set source_deleted_at=now() where id=%s", (j["id"],))


def run_once(pool, settings, client, worker=None):
    if not settings.ai_token:
        cleanup(pool, settings)
        return False
    task = claim(pool, worker or uuid.uuid4())
    if task is None:
        cleanup(pool, settings)
        return False
    stop = threading.Event()
    thread = threading.Thread(target=heartbeat, args=(pool, task, stop), daemon=True)
    thread.start()
    usage, result, error = [], None, None
    try:
        operation, payload = request_for(pool, settings, task)
        response = client.post(
            settings.ai_url + "/api/v1/ai/" + operation,
            json=payload,
            headers={"Authorization": "Bearer " + settings.ai_token},
        )
        body = response.json()
        usage = body.get("meta", {}).get("usage", [])
        if not isinstance(usage, list):
            usage = []
        if response.is_error or "error" in body:
            e = body.get("error", {})
            error = {
                "code": str(e.get("code", "AI_ERROR")),
                "message": str(e.get("message", "AI request failed")),
            }
        else:
            result = body.get("data")
    except httpx.TimeoutException:
        error = {"code": "AI_TIMEOUT", "message": "AI service request timed out"}
    except Exception:
        log.exception("AI worker call failed for task %s", task["id"])
        error = {"code": "AI_WORKER_ERROR", "message": "AI service or retained source is unavailable"}
    finally:
        stop.set()
        thread.join(timeout=10)
    complete(pool, task, result, usage, error)
    cleanup(pool, settings)
    return True


def main():
    logging.basicConfig(level=logging.INFO)
    settings = Settings.load()
    pool = pool_for(settings)
    pool.open(wait=True)
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    worker = uuid.uuid4()
    try:
        with httpx.Client(timeout=httpx.Timeout(150, connect=10)) as client:
            while not stop.is_set():
                try:
                    run_once(pool, settings, client, worker)
                except Exception:
                    log.exception("Worker iteration failed")
                stop.wait(1)
    finally:
        pool.close()


if __name__ == "__main__":
    main()
