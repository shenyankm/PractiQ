from datetime import timedelta
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, File, Request, UploadFile
from psycopg.types.json import Jsonb
from pydantic import Field, model_validator

from .content import BankIn, Tags, add_bank, details, set_tags
from .core import DB, Error, Input, Name, Page, Positive, bank, ok, one, question
from .media import source_bytes, write_file
from .practice import VISIBLE_ANSWERS

router = APIRouter(prefix="/api/v1")


def event(db, job, stage, status, payload=None):
    db.execute(
        "insert into question_import_job_events(job_id,stage,status,payload) values(%s,%s,%s,%s)",
        (job, stage, status, Jsonb(payload or {})),
    )


def job(db, jid, lock=False):
    j = one(db, "select * from question_import_jobs where id=%s" + (" for update" if lock else ""), (jid,))
    bank(db, j["bank_id"])
    return j


def public_job(j):
    return {k: v for k, v in j.items() if k not in {"source_storage_path", "source_checksum"}}


def public_task(t):
    return {k: v for k, v in t.items() if k not in {"request_payload", "worker_id", "worker_lease_until"}}


def ai_enabled(request):
    if not request.app.state.settings.ai_token:
        raise Error(503, "AI_UNAVAILABLE", "Configure the internal AI service before submitting a task")


class ImportIn(Input):
    bankId: Positive | None = None
    name: Name | None = None
    description: Annotated[str, Field(max_length=500)] = ""
    tags: Annotated[list[Annotated[str, Field(min_length=1, max_length=64)]], Field(max_length=30)] = Field(default_factory=list)
    fileName: Annotated[str, Field(min_length=1, max_length=255)]
    sourceType: Literal["text", "csv", "pdf", "docx", "xlsx", "image"]


    @model_validator(mode="after")
    def target(self):
        if (self.bankId is None) == (self.name is None):
            raise ValueError("Provide either a new bank name or an existing bankId")
        if self.name is not None and not self.name.strip():
            raise ValueError("Name must not be blank")
        if self.bankId is not None and (self.description or self.tags):
            raise ValueError("Metadata belongs to a new bank")
        return self


class BankMetadataIn(Input):
    name: Annotated[str, Field(min_length=1, max_length=100, pattern=r"\S")]


class BankMetadataResult(Tags):
    description: Annotated[str, Field(min_length=1, max_length=500)]


@router.post("/bank-metadata-tasks", status_code=201)
def metadata_task(body: BankMetadataIn, request: Request, db: DB):
    ai_enabled(request)
    return ok(public_task(one(db,
        "insert into ai_tasks(kind,request_payload) values('bank_metadata',%s) returning *",
        (Jsonb({"name": body.name.strip()}),))))


@router.post("/import-jobs", status_code=201)
def create_import(body: ImportIn, db: DB):
    if body.bankId is None:
        created = add_bank(BankIn(name=body.name.strip(), description=body.description), db)["data"]
        bank_id = created["id"]
        set_tags(bank_id, Tags(tags=body.tags), db)
    else:
        bank(db, body.bankId)
        bank_id = body.bankId
    return ok(
        public_job(
            one(
                db,
                "insert into question_import_jobs(bank_id,file_name,source_type) values(%s,%s,%s) returning *",
                (bank_id, Path(body.fileName).name, body.sourceType),
            )
        )
    )


@router.get("/import-jobs")
def imports(
    db: DB,
    page: Page,
    status: Literal["queued", "processing", "completed", "failed", "cancelled"] | None = None,
):
    rows = db.execute(
        "select j.* from question_import_jobs j join question_banks b on b.id=j.bank_id where b.deleted_at is null and (%s::text is null or j.status=%s) order by j.id desc limit %s offset %s",
        (status, status, page.limit + 1, page.offset),
    ).fetchall()
    return page.result([public_job(j) for j in rows])


@router.get("/import-jobs/{jid}")
def get_import(jid: Positive, db: DB):
    j = job(db, jid)
    result = public_job(j)
    if j["ai_task_id"]:
        result["task"] = public_task(one(db, "select * from ai_tasks where id=%s", (j["ai_task_id"],)))
    return ok(result)


@router.post("/import-jobs/{jid}/file", status_code=201)
async def upload_import(jid: Positive, request: Request, db: DB, file: Annotated[UploadFile, File()]):
    j = job(db, jid, True)
    if j["status"] != "queued" or j["ai_task_id"]:
        raise Error(409, "INVALID_STATE", "This job no longer accepts uploads")
    data = await file.read(25 * 1024 * 1024 + 1)
    source_bytes(j["source_type"], j["file_name"], data)
    digest = write_file(request.app.state.settings.media_dir / "imports" / str(jid), data)
    if j["source_checksum"] and digest != j["source_checksum"]:
        raise Error(409, "SOURCE_CHANGED", "Create a new job for a different source file")
    db.execute(
        "update question_import_jobs set source_storage_path=%s,source_checksum=%s where id=%s",
        (f"imports/{jid}/" + digest, digest, jid),
    )
    event(db, jid, "upload", "queued")
    return ok(public_job(job(db, jid)))


@router.post("/import-jobs/{jid}/{action}")
def import_action(jid: Positive, action: Literal["parse", "retry", "cancel"], request: Request, db: DB):
    # Task before job is the global lock order used by worker completion too.
    initial = job(db, jid)
    if initial["ai_task_id"]:
        one(db, "select id from ai_tasks where id=%s for update", (initial["ai_task_id"],))
    j = job(db, jid, True)
    if action == "cancel":
        if j["status"] not in {"queued", "processing"}:
            raise Error(409, "INVALID_STATE", "Job cannot be cancelled")
        if j["ai_task_id"]:
            db.execute(
                "update ai_tasks set status='cancelled',finished_at=now(),updated_at=now(),worker_id=null,worker_lease_until=null where id=%s and status in ('queued','running')",
                (j["ai_task_id"],),
            )
        db.execute(
            "update question_import_jobs set status='cancelled',completed_at=now() where id=%s", (jid,)
        )
    else:
        ai_enabled(request)
        if not j["source_storage_path"] or j["source_deleted_at"]:
            raise Error(409, "SOURCE_FILE_REQUIRED", "Upload a source file first")
        if action == "parse":
            if j["status"] != "queued" or j["ai_task_id"]:
                raise Error(409, "INVALID_STATE", "Job has already been submitted")
            t = one(db, "insert into ai_tasks(kind) values('import') returning id")
            db.execute(
                "update question_import_jobs set status='processing',ai_task_id=%s where id=%s",
                (t["id"], jid),
            )
        else:
            eligible = db.execute(
                "select 1 from question_import_jobs where id=%s and status='failed' and retry_expires_at>now()",
                (jid,),
            ).fetchone()
            if not eligible:
                raise Error(
                    409,
                    "IMPORT_RETRY_NOT_ALLOWED",
                    "Only failed jobs with a retained source in the retry window can be retried",
                )
            db.execute(
                "update ai_tasks set status='queued',attempt=attempt+1,result=null,error=null,started_at=null,finished_at=null,worker_id=null,worker_lease_until=null,deadline_at=now()+interval '180 seconds',updated_at=now() where id=%s",
                (j["ai_task_id"],),
            )
            db.execute(
                "update question_import_jobs set status='processing',retry_count=retry_count+1,retry_expires_at=null,completed_at=null where id=%s",
                (jid,),
            )
    event(db, jid, action, "cancelled" if action == "cancel" else "processing")
    return ok(public_job(job(db, jid)))


@router.get("/import-jobs/{jid}/events")
def events(jid: Positive, db: DB, page: Page):
    job(db, jid)
    return page.result(
        db.execute(
            "select * from question_import_job_events where job_id=%s order by id desc limit %s offset %s",
            (jid, page.limit + 1, page.offset),
        ).fetchall()
    )


@router.get("/import-jobs/{jid}/outputs")
def outputs(jid: Positive, db: DB, page: Page):
    job(db, jid)
    return page.result(
        db.execute(
            "select o.*,q.stem from question_import_job_outputs o join questions q on q.id=o.question_id where job_id=%s order by item_index limit %s offset %s",
            (jid, page.limit + 1, page.offset),
        ).fetchall()
    )


@router.get("/ai-tasks")
def tasks(db: DB, page: Page):
    rows = db.execute(
        "select * from ai_tasks order by id desc limit %s offset %s", (page.limit + 1, page.offset)
    ).fetchall()
    return page.result([public_task(t) for t in rows])


@router.get("/ai-tasks/{tid}")
def get_task(tid: Positive, db: DB):
    t = one(db, "select * from ai_tasks where id=%s", (tid,))
    if t["source_question_id"]:
        question(db, t["source_question_id"])
    if (
        t["kind"] == "learning_report"
        and not db.execute("select 1 from ai_report_sources where task_id=%s", (tid,)).fetchone()
    ):
        raise Error(410, "SOURCE_REMOVED", "Report source practice data was removed")
    result = public_task(t)
    result["usage"] = db.execute(
        "select attempt,usage from ai_task_calls where task_id=%s order by id", (tid,)
    ).fetchall()
    return ok(result)


@router.post("/ai-tasks/{tid}/cancel")
def cancel_task(tid: Positive, db: DB):
    t = one(db, "select * from ai_tasks where id=%s for update", (tid,))
    if t["status"] not in {"queued", "running"}:
        raise Error(409, "INVALID_STATE", "Task cannot be cancelled")
    db.execute(
        "update ai_tasks set status='cancelled',finished_at=now(),updated_at=now(),worker_id=null,worker_lease_until=null where id=%s",
        (tid,),
    )
    j = db.execute(
        "update question_import_jobs set status='cancelled',completed_at=now() where ai_task_id=%s returning id",
        (tid,),
    ).fetchone()
    if j:
        event(db, j["id"], "cancel", "cancelled")
    return get_task(tid, db)


@router.post("/questions/{qid}/ai-answer-tasks", status_code=201)
def answer_task(qid: Positive, request: Request, db: DB):
    ai_enabled(request)
    q = details(db, qid, True)
    payload = {
        "stem": q["stem"],
        "answerMode": q["answer_mode"],
        "analysis": q["analysis"],
        "options": [{"label": o["option_label"], "content": o["content"]} for o in q["options"]],
    }
    t = one(
        db,
        "insert into ai_tasks(kind,source_question_id,request_payload) values('answer_generation',%s,%s) returning *",
        (qid, Jsonb(payload)),
    )
    return ok(public_task(t))


@router.post("/analytics/report-tasks", status_code=201)
def report_task(request: Request, db: DB):
    ai_enabled(request)
    rows = db.execute(
        "select a.id,a.is_correct,a.answered_at,q.question_type_id " + VISIBLE_ANSWERS
    ).fetchall()
    if not rows:
        raise Error(409, "INSUFFICIENT_DATA", "Complete some practice before creating a report")
    mastery = {}
    trend = {}
    for r in rows:
        m = mastery.setdefault(
            r["question_type_id"], {"label": r["question_type_id"], "attempts": 0, "correct": 0}
        )
        m["attempts"] += 1
        m["correct"] += int(r["is_correct"] is True)
        d = trend.setdefault(str(r["answered_at"].date()), [0, 0])
        d[0] += 1
        d[1] += int(r["is_correct"] is True)
    correct = sum(r["is_correct"] is True for r in rows)
    start, end = min(r["answered_at"] for r in rows), max(r["answered_at"] for r in rows)
    payload = {
        "scope": "individual",
        "stats": {
            "attemptCount": len(rows),
            "correctCount": correct,
            "accuracy": correct / len(rows),
            "startedAt": start.isoformat(),
            "endedAt": (end + timedelta(microseconds=1)).isoformat(),
            "mastery": list(mastery.values()),
            "accuracyTrend": [{"label": k, "accuracy": v[1] / v[0]} for k, v in sorted(trend.items())],
            "weakKnowledgePoints": [m["label"] for m in mastery.values() if m["correct"] < m["attempts"]]
            or ["继续巩固已练习题型"],
        },
    }
    t = one(
        db,
        "insert into ai_tasks(kind,request_payload) values('learning_report',%s) returning *",
        (Jsonb(payload),),
    )
    for r in rows:
        db.execute("insert into ai_report_sources values(%s,%s)", (t["id"], r["id"]))
    return ok(public_task(t))
