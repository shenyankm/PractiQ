from typing import Annotated, Literal

from fastapi import APIRouter, Query, Response
from psycopg.types.json import Jsonb
from pydantic import Field

from .content import details
from .core import DB, Error, Input, Page, Positive, bank, invalid, ok, one

router = APIRouter(prefix="/api/v1")


def grade(mode, expected, actual):
    if mode == "choice":
        return set(expected["correct"]) == set(actual["selected"])
    if mode == "true_false":
        return expected["answer"] == actual["value"]
    if mode == "fill_blank":

        def normalize(text):
            return " ".join(text.casefold().split())

        return [normalize(v) for v in expected["answers"]] == [normalize(v) for v in actual["value"]]
    return None


def session(db, sid, lock=False):
    s = one(
        db,
        "select s.* from practice_sessions s join question_banks b on b.id=s.bank_id where s.id=%s and b.deleted_at is null"
        + (" for update of s" if lock else ""),
        (sid,),
    )
    counts = one(
        db,
        "select count(*) question_count,(select count(*) from practice_answers where session_id=%s) answered_count from practice_session_questions where session_id=%s",
        (sid, sid),
    )
    scores = one(
        db,
        "select count(*) filter(where is_correct) correct_count,count(*) filter(where is_correct=false) wrong_count,coalesce(sum(score),0) score from practice_answers where session_id=%s",
        (sid,),
    )
    if hidden(s):
        scores = {key: None for key in scores}
    return {**s, **counts, **scores, "session_type": s["mode"]}


def hidden(s):
    return s["mode"] == "exam" and s["status"] != "completed"


def answer(db, s, qid):
    a = db.execute(
        "select a.*,k.answer_payload as answer_key_payload,k.explanation_payload from practice_answers a join question_answer_keys k on k.id=a.answer_key_id where session_id=%s and a.question_id=%s",
        (s["id"], qid),
    ).fetchone()
    if a and hidden(s):
        for field in (
            "answer_key_id",
            "is_correct",
            "score",
            "max_score",
            "answer_key_payload",
            "explanation_payload",
        ):
            a[field] = None
    return a


class Start(Input):
    bankId: Positive
    mode: Literal["all", "wrong", "by_type", "exam"] = "all"
    questionCount: Annotated[int, Field(ge=1, le=500)] = 30
    questionTypeId: str = ""
    allQuestions: bool = False


@router.post("/practice-sessions", status_code=201)
def start(body: Start, db: DB):
    bank(db, body.bankId)
    if body.mode == "by_type" and not body.questionTypeId:
        invalid("Choose a question type")
    rows = db.execute(
        """select q.id,k.id key_id from questions q join question_answer_keys k on k.question_id=q.id and k.is_primary
        where q.bank_id=%s and q.status='active' and q.deleted_at is null
        and (q.group_id is null or exists(select 1 from question_groups g where g.id=q.group_id and g.status='active'))
        and (%s<>'by_type' or q.question_type_id=%s)
        and (%s<>'wrong' or exists(select 1 from practice_answers a join practice_sessions s on s.id=a.session_id
             where a.question_id=q.id and a.is_correct=false and (s.mode<>'exam' or s.status='completed')))
        order by case when %s='exam' then random() else 0 end,q.sort_order,q.id limit %s""",
        (
            body.bankId,
            body.mode,
            body.questionTypeId,
            body.mode,
            body.mode,
            500 if body.allQuestions else body.questionCount,
        ),
    ).fetchall()
    if not rows:
        raise Error(409, "INVALID_STATE", "No active questions match this practice")
    s = one(
        db,
        "insert into practice_sessions(bank_id,mode) values(%s,%s) returning id",
        (body.bankId, "type" if body.mode == "by_type" else body.mode),
    )
    for i, q in enumerate(rows):
        db.execute(
            "insert into practice_session_questions(session_id,bank_id,question_id,position,answer_key_id) values(%s,%s,%s,%s,%s)",
            (s["id"], body.bankId, q["id"], i + 1, q["key_id"]),
        )
    return ok(session(db, s["id"]))


@router.get("/practice-sessions")
def sessions(db: DB, page: Page, status: Literal["active", "completed", "abandoned"] | None = None):
    ids = db.execute(
        "select s.id from practice_sessions s join question_banks b on b.id=s.bank_id where b.deleted_at is null and (%s::text is null or s.status=%s) order by s.id desc limit %s offset %s",
        (status, status, page.limit + 1, page.offset),
    ).fetchall()
    return page.result([session(db, i["id"]) for i in ids])


@router.get("/practice-sessions/{sid}")
def get_session(sid: Positive, db: DB):
    return ok(session(db, sid))


def practice_question(db, s, qid):
    q = details(db, qid)
    a = answer(db, s, qid)
    if a and not hidden(s):
        q["result"] = a
    return q


@router.get("/practice-sessions/{sid}/questions")
def session_questions(sid: Positive, db: DB):
    s = session(db, sid)
    return ok(
        [
            practice_question(db, s, r["question_id"])
            for r in db.execute(
                "select question_id from practice_session_questions where session_id=%s order by position",
                (sid,),
            )
        ]
    )


@router.get("/practice-sessions/{sid}/question-page")
def question_page(sid: Positive, db: DB, index: Annotated[int | None, Query(ge=0)] = None):
    s = session(db, sid)
    rows = db.execute(
        "select sq.question_id,a.id answer_id,a.is_correct from practice_session_questions sq left join practice_answers a on a.session_id=sq.session_id and a.question_id=sq.question_id where sq.session_id=%s order by sq.position",
        (sid,),
    ).fetchall()
    selected = (
        index if index is not None else next((i for i, q in enumerate(rows) if q["answer_id"] is None), 0)
    )
    if selected >= len(rows):
        invalid("Question index is out of range")
    qid = rows[selected]["question_id"]
    return ok(
        {
            "session": s,
            "question": practice_question(db, s, qid),
            "questionIndex": selected,
            "total": len(rows),
            "answeredCount": s["answered_count"],
            "result": answer(db, s, qid),
            "previousIndex": selected - 1 if selected else None,
            "nextIndex": selected + 1 if selected + 1 < len(rows) else None,
            "progress": [
                {
                    "index": i,
                    "questionId": q["question_id"],
                    "isAnswered": q["answer_id"] is not None,
                    "isCorrect": None if hidden(s) else q["is_correct"],
                }
                for i, q in enumerate(rows)
            ],
        }
    )


class Answer(Input):
    questionId: Positive
    answerPayload: dict
    durationMs: Annotated[int, Field(ge=0)] = 0


@router.post("/practice-sessions/{sid}/answers", status_code=201)
def submit(sid: Positive, body: Answer, db: DB):
    s = session(db, sid, True)
    old = answer(db, s, body.questionId)
    if old:
        return ok(old)
    if s["status"] != "active":
        raise Error(409, "INVALID_STATE", "Practice is no longer active")
    q = one(
        db,
        "select q.*,k.id key_id,k.answer_payload expected from practice_session_questions sq join questions q on q.id=sq.question_id join question_answer_keys k on k.id=sq.answer_key_id where sq.session_id=%s and sq.question_id=%s",
        (sid, body.questionId),
    )
    payload = body.answerPayload
    mode = q["answer_mode"]
    if mode == "choice":
        selected = payload.get("selected")
        labels = {
            o["option_label"]
            for o in db.execute(
                "select option_label from question_options where question_id=%s", (body.questionId,)
            )
        }
        if (
            not isinstance(selected, list)
            or not selected
            or any(not isinstance(v, str) for v in selected)
            or not set(selected) <= labels
            or len(set(selected)) != len(selected)
            or (q["choice_variant"] == "single" and len(selected) != 1)
        ):
            invalid("Choose valid options")
    elif mode == "true_false":
        if not isinstance(payload.get("value"), bool):
            invalid("Choose true or false")
    elif mode == "fill_blank":
        v = payload.get("value")
        if not isinstance(v, list) or not v or any(not isinstance(x, str) or not x.strip() for x in v):
            invalid("Fill the blanks")
    elif not isinstance(payload.get("value"), str) or not payload["value"].strip():
        invalid("Enter an answer")
    result = grade(mode, q["expected"], payload)
    db.execute(
        "insert into practice_answers(session_id,question_id,answer_key_id,answer_payload,is_correct,score,duration_ms) values(%s,%s,%s,%s,%s,%s,%s)",
        (
            sid,
            body.questionId,
            q["key_id"],
            Jsonb(payload),
            result,
            None if result is None else int(result),
            body.durationMs,
        ),
    )
    db.execute("update practice_sessions set updated_at=now() where id=%s", (sid,))
    return ok(answer(db, s, body.questionId))


@router.post("/practice-sessions/{sid}/{action}")
def finish(sid: Positive, action: Literal["complete", "abandon"], db: DB):
    s = session(db, sid, True)
    target = "completed" if action == "complete" else "abandoned"
    if s["status"] != "active":
        raise Error(409, "INVALID_STATE", "Practice is no longer active")
    db.execute(
        "update practice_sessions set status=%s,completed_at=now(),updated_at=now() where id=%s",
        (target, sid),
    )
    return ok(session(db, sid))


@router.get("/practice-sessions/{sid}/results")
def results(sid: Positive, db: DB):
    s = session(db, sid)
    if s["status"] == "active":
        raise Error(409, "INVALID_STATE", "Complete the session before viewing results")
    return ok(
        [
            {**practice_question(db, s, r["question_id"]), "result": answer(db, s, r["question_id"])}
            for r in db.execute(
                "select question_id from practice_session_questions where session_id=%s order by position",
                (sid,),
            )
        ]
    )


@router.delete("/banks/{bank_id}/practice-data", status_code=204)
def reset(bank_id: Positive, db: DB):
    bank(db, bank_id)
    db.execute("delete from practice_sessions where bank_id=%s", (bank_id,))
    return Response(status_code=204)


VISIBLE_ANSWERS = """from practice_answers a join practice_sessions s on s.id=a.session_id
    join question_banks b on b.id=s.bank_id join questions q on q.id=a.question_id
    where b.deleted_at is null and q.deleted_at is null and (s.mode<>'exam' or s.status='completed')"""


def summary(db, bank_id=None):
    stats = one(
        db,
        "select count(*) attempts,count(*) filter(where a.is_correct) correct,count(*) filter(where a.is_correct=false) wrong "
        + VISIBLE_ANSWERS
        + " and (%s::bigint is null or s.bank_id=%s)",
        (bank_id, bank_id),
    )
    stats["accuracy"] = round(100 * stats["correct"] / stats["attempts"], 1) if stats["attempts"] else 0
    stats.update(
        one(
            db,
            "select count(*) banks,count(*) filter(where is_favorite) favorite_banks from question_banks where deleted_at is null",
        )
    )
    return stats


@router.get("/analytics/summary")
def get_summary(db: DB):
    return ok(summary(db))


@router.get("/analytics/snapshot")
def snapshot(db: DB):
    ids = db.execute(
        "select s.id from practice_sessions s join question_banks b on b.id=s.bank_id where b.deleted_at is null order by s.id desc limit 10"
    ).fetchall()
    weak = db.execute(
        "select q.id question_id,q.stem,s.bank_id,count(*) attempt_count,count(*) filter(where a.is_correct=false) wrong_count,avg(case when a.is_correct then 1.0 else 0 end) mastery_score "
        + VISIBLE_ANSWERS
        + " group by q.id,s.bank_id order by mastery_score,wrong_count desc limit 10"
    ).fetchall()
    trend = db.execute(
        "select a.answered_at::date as day,count(*) attempts,count(*) filter(where a.is_correct) correct "
        + VISIBLE_ANSWERS
        + " group by day order by day desc limit 30"
    ).fetchall()
    return ok(
        {
            "summary": summary(db),
            "recentSessions": [session(db, r["id"]) for r in ids],
            "weakQuestions": weak,
            "trend": trend,
        }
    )


@router.get("/analytics/banks/{bank_id}")
def bank_analytics(bank_id: Positive, db: DB):
    bank(db, bank_id)
    return ok(summary(db, bank_id))
