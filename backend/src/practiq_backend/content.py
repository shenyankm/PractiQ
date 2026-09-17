"""Personal content operations; SQL and Pydantic are the contracts."""

from typing import Annotated, Literal

from fastapi import APIRouter, Response
from psycopg.types.json import Jsonb
from pydantic import Field, field_validator, model_validator

from .completeness import missing_answer, normalize_missing_values, require_complete
from .core import DB, Error, Input, Name, Page, Positive, bank, invalid, ok, one, question

router = APIRouter(prefix="/api/v1")
Mode = Literal["choice", "true_false", "fill_blank", "short_answer", "ordering", "matching"]
Status = Literal["draft", "active", "archived"]


class BankIn(Input):
    name: Name
    subject: str = "general"
    description: Annotated[str, Field(max_length=500)] = ""


class BankPatch(Input):
    name: Name | None = None
    description: Annotated[str, Field(max_length=500)] | None = None


class DraftInput(Input):
    @field_validator("options", "items", mode="before", check_fields=False)
    @classmethod
    def absent_list(cls, value):
        return [] if value is None else value

    @field_validator("*", mode="before")
    @classmethod
    def empty_to_null(cls, value):
        return None if isinstance(value, str) and not value.strip() else value


class Option(DraftInput):
    label: Annotated[str, Field(min_length=1, max_length=16)] | None = None
    content: Annotated[str, Field(min_length=1, max_length=20000)] | None = None
    isCorrect: bool = False


class ItemIn(DraftInput):
    side: Literal["left", "right"] | None = None
    content: Annotated[str, Field(min_length=1, max_length=20000)] | None = None


class QuestionIn(DraftInput):
    questionTypeId: Annotated[str, Field(min_length=1, max_length=64)] | None = None
    answerMode: Mode | None = None
    stem: Annotated[str, Field(min_length=1, max_length=120000)] | None = None
    analysis: Annotated[str, Field(max_length=100000)] | None = None
    sourceText: Annotated[str, Field(max_length=120000)] | None = None
    choiceVariant: Literal["single", "multiple"] | None = None
    matchingVariant: Literal["one_to_one", "many_to_one"] | None = None
    status: Status = "draft"
    options: Annotated[list[Option], Field(max_length=100)] = Field(default_factory=list)
    items: Annotated[list[ItemIn], Field(max_length=100)] = Field(default_factory=list)
    answerPayload: dict | None = None
    groupId: Positive | None = None
    subsetId: Positive | None = None

    @model_validator(mode="after")
    def shape(self):
        labels = [o.label for o in self.options if o.label is not None]
        if len(set(labels)) != len(labels):
            raise ValueError("Option labels must be unique")
        if self.answerMode is not None:
            if self.answerMode != "choice" and (self.choiceVariant or self.options):
                raise ValueError("Only choice questions have options")
            if self.answerMode not in {"ordering", "matching"} and self.items:
                raise ValueError("Only ordering and matching questions take items")
            if self.answerMode != "matching" and self.matchingVariant:
                raise ValueError("Only matching questions have a matching variant")
            if self.answerMode == "ordering" and any(i.side is not None for i in self.items):
                raise ValueError("Ordering items must be sideless")
        return self


def int_list(values, message):
    if not isinstance(values, list) or not values:
        invalid(message)
    for v in values:
        if isinstance(v, bool) or not isinstance(v, int):
            invalid(message)
    return values


def normalize_key(mode, payload, options=()):
    if mode == "choice":
        values = payload.get("correct", payload.get("selected", payload.get("correctOption", [])))
        if isinstance(values, str):
            values = [values]
        if not values:
            values = [o.label for o in options if o.isCorrect]
        if not isinstance(values, list) or any(not isinstance(v, str) for v in values):
            invalid("Choice answer must be a list of option labels")
        return {"correct": list(dict.fromkeys(values))}
    if mode == "ordering":
        order = int_list(payload.get("order"), "Ordering answer must be a distinct integer list")
        if len(set(order)) != len(order):
            invalid("Ordering answer must be a distinct integer list")
        key = {"order": order}
    elif mode == "matching":
        matches = payload.get("matches")
        if (
            not isinstance(matches, list)
            or not matches
            or any(
                not isinstance(m, dict)
                or set(m) != {"left", "right"}
                or isinstance(m["left"], bool)
                or not isinstance(m["left"], int)
                or isinstance(m["right"], bool)
                or not isinstance(m["right"], int)
                for m in matches
            )
        ):
            invalid("Matching answer must pair left and right item identifiers")
        if len({m["left"] for m in matches}) != len(matches):
            invalid("Each left item can only be matched once")
        key = {"matches": [{"left": m["left"], "right": m["right"]} for m in matches]}
    else:
        raw = payload.get("value", payload.get("answers", payload.get("answer", payload.get("text"))))
        if mode == "true_false" and not isinstance(raw, bool):
            invalid("A boolean answer is required")
        if mode == "fill_blank":
            if isinstance(raw, str):
                raw = [raw]

            def blank_ok(v):
                alts = v if isinstance(v, list) else [v]
                return bool(alts) and all(isinstance(x, str) and x.strip() for x in alts)

            if not isinstance(raw, list) or not raw or not all(blank_ok(v) for v in raw):
                invalid("Blank answers must contain non-empty text")
            key = {"answers": raw}
        else:
            if mode == "short_answer" and (not isinstance(raw, str) or not raw.strip()):
                invalid("A reference answer is required")
            key = {"answer": raw}
    grading = payload.get("grading")
    if mode != "choice" and isinstance(grading, dict):
        key["grading"] = grading
    return key


def validate_key(db, q, payload):
    if q["answer_mode"] == "choice":
        labels = {
            r["option_label"]
            for r in db.execute("select option_label from question_options where question_id=%s", (q["id"],))
        }
        selected = payload.get("correct", [])
        if (
            not selected
            or not set(selected) <= labels
            or (q["choice_variant"] == "single" and len(selected) != 1)
        ):
            invalid("Answer must reference valid options and match the choice variant")
    elif q["answer_mode"] == "ordering":
        ids = [r["id"] for r in db.execute("select id from question_ordering_items where question_id=%s", (q["id"],))]
        order = payload.get("order")
        if not isinstance(order, list) or sorted(order) != sorted(ids):
            invalid("Ordering answer must reference every item exactly once")
    elif q["answer_mode"] == "matching":
        lefts = {
            r["id"]
            for r in db.execute(
                "select id from question_matching_items where question_id=%s and side='left'", (q["id"],)
            )
        }
        rights = {
            r["id"]
            for r in db.execute(
                "select id from question_matching_items where question_id=%s and side='right'", (q["id"],)
            )
        }
        matches = payload.get("matches")
        if (
            not isinstance(matches, list)
            or {m.get("left") for m in matches} != lefts
            or any(m.get("right") not in rights for m in matches)
        ):
            invalid("Matching answer must cover every left item once with valid right items")
        if q["matching_variant"] == "one_to_one" and len({m.get("right") for m in matches}) != len(matches):
            invalid("One-to-one matching requires distinct right items")


def details(db, qid, management=False):
    q = question(db, qid)
    q["options"] = db.execute(
        "select * from question_options where question_id=%s order by sort_order", (qid,)
    ).fetchall()
    if q["answer_mode"] == "ordering":
        q["items"] = db.execute(
            "select id,null as side,content,sort_order from question_ordering_items where question_id=%s order by sort_order",
            (qid,),
        ).fetchall()
    elif q["answer_mode"] == "matching":
        q["items"] = db.execute(
            "select id,side,content,sort_order from question_matching_items where question_id=%s order by side,sort_order",
            (qid,),
        ).fetchall()
    elif q["answer_mode"] == "fill_blank":
        key = db.execute(
            "select answer_payload from question_answer_keys where question_id=%s and is_primary", (qid,)
        ).fetchone()
        answers = key["answer_payload"].get("answers") if key else None
        q["blank_count"] = len(answers) if isinstance(answers, list) and answers else 1
    if q["answer_mode"] is None:
        q["items"] = [{"id": -(i+1), "sort_order": i+1, **item} for i, item in enumerate(q["draft_items"])]
    q.pop("draft_items", None)
    q["content_blocks"] = db.execute(
        "select * from question_content_blocks where question_id=%s order by sequence", (qid,)
    ).fetchall()
    q["media"] = db.execute(
        "select l.*,m.mime_type from media_links l join media_assets m on m.id=l.media_id where l.question_id=%s and m.deleted_at is null order by l.sort_order",
        (qid,),
    ).fetchall()
    q["knowledge_points"] = db.execute(
        "select k.* from knowledge_points k join question_knowledge_points qk on qk.knowledge_point_id=k.id where qk.question_id=%s order by k.id",
        (qid,),
    ).fetchall()
    if q["group_id"]:
        q["group"] = one(db, "select * from question_groups where id=%s", (q["group_id"],))
        q["group"]["content_blocks"] = db.execute(
            "select * from question_content_blocks where group_id=%s order by sequence", (q["group_id"],)
        ).fetchall()
        q["group"]["media"] = db.execute(
            "select l.*,m.mime_type from media_links l join media_assets m on m.id=l.media_id where l.group_id=%s and m.deleted_at is null",
            (q["group_id"],),
        ).fetchall()
    if management:
        q["answer_keys"] = db.execute(
            "select * from question_answer_keys where question_id=%s order by version", (qid,)
        ).fetchall()
    else:
        for field in ("analysis", "source_text", "draft_answer_payload"):
            q.pop(field, None)
    q["missingFields"] = q.pop("missing_fields")
    q.pop("missing_dependencies", None)
    if management:
        q["sourceText"] = q.pop("source_text")
        q["draftAnswerPayload"] = q.pop("draft_answer_payload")
        primary = next((key for key in q["answer_keys"] if key["is_primary"]), None)
        q["answerPayload"] = q["draftAnswerPayload"] if q["draftAnswerPayload"] is not None else primary["answer_payload"] if primary else None
    return q


def validate_question_type(db, subject, type_id, mode):
    if type_id is not None and not db.execute("select 1 from question_types where subject_id=%s and id=%s and (%s::text is null or answer_mode=%s)", (subject,type_id,mode,mode)).fetchone():
        invalid("Question type must exist and match the answer mode")


def restore_active(db, q):
    if q["status"] == "active":
        db.execute("update questions set status='active' where id=%s and cardinality(missing_fields)=0", (q["id"],))


def save_draft_answer(db, qid, payload, options=(), item_ids=None, items=()):
    q = question(db, qid)
    payload = normalize_missing_values(payload)
    # Never leave an old answer primary after the user clears or replaces it.
    db.execute("update question_answer_keys set is_primary=false where question_id=%s", (qid,))
    absent = missing_answer(q["answer_mode"], payload)
    mode = q["answer_mode"]
    draft_payload = payload
    if payload and mode in {"ordering", "matching"}:
        if item_ids is not None:
            allowed = {side: set(range(sum(i.side == side for i in items))) for side in ("left", "right")}
            allowed["order"] = set(range(len(items)))
        elif mode == "ordering":
            rows = db.execute("select id from question_ordering_items where question_id=%s order by sort_order", (qid,)).fetchall()
            allowed = {"order": {r["id"] for r in rows}}
        else:
            rows = db.execute("select id,side from question_matching_items where question_id=%s order by side,sort_order", (qid,)).fetchall()
            allowed = {side: {r["id"] for r in rows if r["side"] == side} for side in ("left", "right")}
        supplied = {"order": [v for v in payload.get("order") or [] if v is not None]} if mode == "ordering" else {
            side: [m[side] for m in payload.get("matches") or [] if m and m.get(side) is not None] for side in ("left", "right")}
        for side, values in supplied.items():
            unique = side != "right" or q["matching_variant"] == "one_to_one"
            if "items" not in q["missing_fields"] and not set(values) <= allowed[side] or unique and len(set(values)) != len(values):
                invalid("Answer references invalid or repeated items")
        # Draft item references use positions, including after an API update using stored IDs.
        if item_ids is None and rows:
            if mode == "ordering":
                ids = [r["id"] for r in rows]
                draft_payload = {**payload, "order": [ids.index(v) if v in ids else v for v in payload.get("order") or []]}
            else:
                sides = {side: [r["id"] for r in rows if r["side"] == side] for side in ("left", "right")}
                draft_payload = {**payload, "matches": [None if m is None else {side: sides[side].index(v) if v in sides[side] else v for side, v in m.items()} for m in payload.get("matches") or []]}
    if not absent:
        normalize_key(q["answer_mode"], payload, options)
    if absent or any(f in q["missing_fields"] for f in ("options", "items")):
        db.execute("update questions set draft_answer_payload=%s where id=%s", (Jsonb(draft_payload) if draft_payload else None, qid))
        return
    if q["answer_mode"] in {"ordering", "matching"} and item_ids is not None:
        key = key_from_indices(q["answer_mode"], payload, items, item_ids)
    else:
        key = normalize_key(q["answer_mode"], payload, options)
    mode = q["answer_mode"]
    if mode in {"ordering", "matching"}:
        table = "question_ordering_items" if mode == "ordering" else "question_matching_items"
        rows = db.execute(f"select * from {table} where question_id=%s", (qid,)).fetchall()
        allowed = {row["id"] for row in rows if mode == "ordering" or row["side"] == "left"}
        supplied = set(key["order"]) if mode == "ordering" else {m["left"] for m in key["matches"]}
        if not supplied <= allowed:
            invalid("Answer references unknown items")
        if mode == "matching":
            rights = {row["id"] for row in rows if row["side"] == "right"}
            selected = [m["right"] for m in key["matches"]]
            if not set(selected) <= rights or q["matching_variant"] == "one_to_one" and len(set(selected)) != len(selected):
                invalid("Answer references invalid right items")
        if supplied != allowed:
            db.execute("update questions set draft_answer_payload=%s where id=%s", (Jsonb(draft_payload), qid))
            return
    validate_key(db, q, key)
    db.execute("update questions set draft_answer_payload=null where id=%s", (qid,))
    db.execute(
        "insert into question_answer_keys(question_id,version,answer_payload) values(%s,(select coalesce(max(version),0)+1 from question_answer_keys where question_id=%s),%s)",
        (qid, qid, Jsonb(key)),
    )


def create_question(db, bank_id, body: QuestionIn, *, dependencies=()):
    b = bank(db, bank_id)
    validate_question_type(db, b["subject_id"], body.questionTypeId, body.answerMode)
    q = one(db,
        """insert into questions(bank_id,subject_id,question_type_id,answer_mode,choice_variant,matching_variant,stem,analysis,source_text,missing_dependencies,status,group_id,subset_id,sort_order)
        values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'draft',%s,%s,(select coalesce(max(sort_order),0)+1 from questions where bank_id=%s)) returning *""",
        (bank_id,b["subject_id"],body.questionTypeId,body.answerMode,body.choiceVariant,body.matchingVariant,body.stem,body.analysis,body.sourceText,list(dependencies),body.groupId,body.subsetId,bank_id))
    for i, o in enumerate(body.options):
        db.execute("insert into question_options(question_id,option_label,content,sort_order) values(%s,%s,%s,%s)", (q["id"],o.label,o.content,i+1))
    item_ids = replace_items(db, q["id"], body.answerMode, body.items) if body.answerMode in {"ordering", "matching"} else None
    if body.answerMode is None:
        db.execute("update questions set draft_items=%s where id=%s", (Jsonb([i.model_dump() for i in body.items]), q["id"]))
    save_draft_answer(db, q["id"], body.answerPayload, body.options, item_ids, body.items)
    if body.status == "active":
        require_complete(question(db, q["id"]))
        db.execute("update questions set status='active' where id=%s", (q["id"],))
    elif body.status == "archived":
        db.execute("update questions set status='archived' where id=%s", (q["id"],))
    return details(db, q["id"], True)


@router.get("/banks")
def banks(db: DB, page: Page, scope: Literal["all", "favorites"] = "all", subject: str = "", q: str = ""):
    rows = db.execute(
        "select * from question_banks where deleted_at is null and (%s='all' or is_favorite) and (%s='' or subject_id=%s) and name ilike %s order by updated_at desc,id desc limit %s offset %s",
        (scope, subject, subject, f"%{q}%", page.limit + 1, page.offset),
    ).fetchall()
    return page.result(rows)


@router.post("/banks", status_code=201)
def add_bank(body: BankIn, db: DB):
    return ok(
        one(
            db,
            "insert into question_banks(name,subject_id,description) values(%s,%s,%s) returning *",
            (body.name, body.subject, body.description),
        )
    )


@router.get("/banks/{bank_id}")
def get_bank(bank_id: Positive, db: DB):
    return ok(bank(db, bank_id))


@router.patch("/banks/{bank_id}")
def edit_bank(bank_id: Positive, body: BankPatch, db: DB):
    bank(db, bank_id)
    if not body.model_fields_set:
        invalid("Provide a field to update")
    if "name" in body.model_fields_set and body.name is None:
        invalid("Name cannot be null")
    return ok(
        one(
            db,
            "update question_banks set name=coalesce(%s,name),description=case when %s then %s else description end,updated_at=now() where id=%s returning *",
            (body.name, "description" in body.model_fields_set, body.description, bank_id),
        )
    )


@router.delete("/banks/{bank_id}", status_code=204)
def delete_bank(bank_id: Positive, db: DB):
    bank(db, bank_id)
    db.execute("update question_banks set deleted_at=now() where id=%s", (bank_id,))
    return Response(status_code=204)


@router.post("/banks/{bank_id}/favorite", status_code=204)
def favorite(bank_id: Positive, db: DB):
    bank(db, bank_id)
    db.execute("update question_banks set is_favorite=true where id=%s", (bank_id,))
    return Response(status_code=204)


@router.delete("/banks/{bank_id}/favorite", status_code=204)
def unfavorite(bank_id: Positive, db: DB):
    bank(db, bank_id)
    db.execute("update question_banks set is_favorite=false where id=%s", (bank_id,))
    return Response(status_code=204)


@router.get("/banks/{bank_id}/items")
def items(
    bank_id: Positive,
    db: DB,
    page: Page,
    status: Status | None = None,
    incomplete: bool | None = None,
    type: str = "",
    groupId: Positive | None = None,
):
    bank(db, bank_id)
    rows = db.execute(
        "select id as question_id,id,bank_id,question_type_id,answer_mode,choice_variant,stem,status as question_status,missing_fields as \"missingFields\",group_id,subset_id,sort_order from questions where bank_id=%s and deleted_at is null and (%s::text is null or status=%s) and (%s='' or question_type_id=%s) and (%s::bigint is null or group_id=%s) and (%s::boolean is null or (cardinality(missing_fields)>0)=%s) order by sort_order,id limit %s offset %s",
        (bank_id, status, status, type, type, groupId, groupId, incomplete, incomplete, page.limit + 1, page.offset),
    ).fetchall()
    return page.result(rows)


@router.post("/banks/{bank_id}/questions", status_code=201)
def add_question(bank_id: Positive, body: QuestionIn, db: DB):
    return ok(create_question(db, bank_id, body))


@router.get("/questions/{qid}")
def get_question(qid: Positive, db: DB):
    return ok(details(db, qid))


@router.get("/questions/{qid}/management")
def manage_question(qid: Positive, db: DB):
    return ok(details(db, qid, True))


class QuestionPatch(DraftInput):
    questionTypeId: Annotated[str, Field(min_length=1, max_length=64)] | None = None
    answerMode: Mode | None = None
    choiceVariant: Literal["single", "multiple"] | None = None
    sourceText: Annotated[str, Field(max_length=120000)] | None = None
    options: Annotated[list[Option], Field(max_length=100)] | None = None
    items: Annotated[list[ItemIn], Field(max_length=100)] | None = None
    matchingVariant: Literal["one_to_one", "many_to_one"] | None = None
    answerPayload: dict | None = None
    stem: Annotated[str, Field(min_length=1, max_length=120000)] | None = None
    analysis: Annotated[str, Field(max_length=100000)] | None = None
    groupId: Positive | None = None
    subsetId: Positive | None = None


def replace_items(db, qid, mode, items: list[ItemIn]):
    """Replace ordering/matching items wholesale; returns new item ids in input order."""
    ids = []
    if mode == "ordering":
        db.execute("delete from question_ordering_items where question_id=%s", (qid,))
        for i, item in enumerate(items):
            ids.append(
                one(
                    db,
                    "insert into question_ordering_items(question_id,content,sort_order) values(%s,%s,%s) returning id",
                    (qid, item.content, i + 1),
                )["id"]
            )
    else:
        db.execute("delete from question_matching_items where question_id=%s", (qid,))
        counters = {"left": 0, "right": 0, None: 0}
        for item in items:
            counters[item.side] += 1
            ids.append(
                one(
                    db,
                    "insert into question_matching_items(question_id,side,content,sort_order) values(%s,%s,%s,%s) returning id",
                    (qid, item.side, item.content, counters[item.side]),
                )["id"]
            )
    return ids


def key_from_indices(mode, payload, items: list[ItemIn], item_ids: list[int]):
    """Map 0-based item indices in an answer payload to freshly assigned item ids."""
    grading = payload.get("grading")
    if mode == "ordering":
        order = int_list(payload.get("order"), "Ordering answer must be a distinct integer list")
        if len(set(order)) != len(order) or any(v < 0 or v >= len(items) for v in order):
            invalid("Ordering answer must be a permutation of item positions")
        key = {"order": [item_ids[v] for v in order]}
    else:
        lefts = sum(1 for i in items if i.side == "left")
        rights = len(items) - lefts
        normalized = normalize_key("matching", payload)
        if any(m["left"] < 0 or m["left"] >= lefts or m["right"] < 0 or m["right"] >= rights for m in normalized["matches"]):
            invalid("Matching answer must reference valid item positions")
        side_ids = {"left": [], "right": []}
        for position, item in enumerate(items):
            side_ids[item.side].append(item_ids[position])
        key = {"matches": [{"left": side_ids["left"][m["left"]], "right": side_ids["right"][m["right"]]} for m in normalized["matches"]]}
    if isinstance(grading, dict):
        key["grading"] = grading
    return key


@router.patch("/questions/{qid}")
def edit_question(qid: Positive, body: QuestionPatch, db: DB):
    q = question(db, qid)
    db.execute("select id from questions where id=%s for update", (qid,))
    fields = body.model_fields_set
    if not fields:
        invalid("Provide a field to update")
    for field, column in (("answerMode", "answer_mode"), ("questionTypeId", "question_type_id")):
        if field in fields and q[column] is not None and getattr(body, field) != q[column]:
            invalid("An established question type cannot change; create a new draft")
    values = {"questionTypeId":q["question_type_id"],"answerMode":q["answer_mode"],"choiceVariant":q["choice_variant"],"matchingVariant":q["matching_variant"],"stem":q["stem"],"analysis":q["analysis"],"sourceText":q["source_text"],"groupId":q["group_id"],"subsetId":q["subset_id"]}
    if body.items is None and q["answer_mode"] is None and q["draft_items"] and body.answerMode in {"ordering", "matching"}:
        body.items = [ItemIn.model_validate(item) for item in q["draft_items"]]
    values.update(body.model_dump(exclude_unset=True))
    validated = QuestionIn.model_validate(values)
    validate_question_type(db, q["subject_id"], validated.questionTypeId, validated.answerMode)
    db.execute("update questions set question_type_id=%s,answer_mode=%s,choice_variant=%s,matching_variant=%s,stem=%s,analysis=%s,source_text=%s,group_id=%s,subset_id=%s,updated_at=now() where id=%s", (validated.questionTypeId,validated.answerMode,validated.choiceVariant,validated.matchingVariant,validated.stem,validated.analysis,validated.sourceText,validated.groupId,validated.subsetId,qid))
    if body.options is not None:
        old = db.execute("select * from question_options where question_id=%s order by sort_order", (qid,)).fetchall()
        referenced = db.execute("select 1 from practice_session_questions where question_id=%s limit 1", (qid,)).fetchone()
        if referenced and [o.label for o in body.options] != [o["option_label"] for o in old]:
            invalid("Options referenced by practice sessions cannot be replaced")
        for i, option in enumerate(body.options):
            if i < len(old):
                db.execute("update question_options set option_label=%s,content=%s where id=%s", (option.label,option.content,old[i]["id"]))
            else:
                db.execute("insert into question_options(question_id,option_label,content,sort_order) values(%s,%s,%s,%s)", (qid,option.label,option.content,i+1))
        for option in old[len(body.options):]:
            db.execute("delete from question_options where id=%s", (option["id"],))
    item_ids = None
    if body.items is not None and validated.answerMode is None:
        db.execute("update questions set draft_items=%s where id=%s", (Jsonb([i.model_dump() for i in body.items]), qid))
    elif body.items is not None:
        if validated.answerMode not in ("ordering", "matching"):
            invalid("Only ordering and matching questions take items")
        item_ids = replace_items(db, qid, validated.answerMode, body.items)
        db.execute("update questions set draft_items='[]' where id=%s", (qid,))
        if "answerPayload" not in fields and db.execute("select 1 from question_answer_keys where question_id=%s and is_primary", (qid,)).fetchone():
            raise Error(409, "INVALID_STATE", "Replacing items requires a new answer")
    if "answerPayload" in fields:
        save_draft_answer(db, qid, body.answerPayload, body.options or (), item_ids, body.items or ())
    elif q["draft_answer_payload"] is not None and (body.options is not None or body.items is not None or "answerMode" in fields):
        save_draft_answer(db, qid, q["draft_answer_payload"], body.options or (), item_ids, body.items or ())
    elif body.options is not None or {"choiceVariant", "matchingVariant"} & fields:
        key = db.execute("select answer_payload from question_answer_keys where question_id=%s and is_primary", (qid,)).fetchone()
        if key:
            validate_key(db, question(db, qid), key["answer_payload"])
    restore_active(db, q)
    return ok(details(db, qid, True))


@router.post("/questions/{qid}/publish")
def publish(qid: Positive, db: DB):
    q = question(db, qid)
    require_complete(q)
    key = one(
        db, "select answer_payload from question_answer_keys where question_id=%s and is_primary", (qid,)
    )
    validate_key(db, q, key["answer_payload"])
    db.execute("update questions set status='active',updated_at=now() where id=%s", (qid,))
    return ok(details(db, qid, True))


@router.post("/questions/{qid}/archive")
def archive(qid: Positive, db: DB):
    question(db, qid)
    db.execute("update questions set status='archived',updated_at=now() where id=%s", (qid,))
    return ok(details(db, qid, True))


@router.delete("/questions/{qid}", status_code=204)
def delete_question(qid: Positive, db: DB):
    question(db, qid)
    db.execute("update questions set deleted_at=now() where id=%s", (qid,))
    return Response(status_code=204)


class KeyIn(Input):
    answerMode: Mode
    answerPayload: dict
    explanationPayload: dict = Field(default_factory=dict)


@router.post("/questions/{qid}/answer-keys", status_code=201)
def add_key(qid: Positive, body: KeyIn, db: DB):
    q = question(db, qid)
    db.execute("select id from questions where id=%s for update", (qid,))
    if body.answerMode != q["answer_mode"]:
        invalid("Answer mode cannot change")
    payload = normalize_key(body.answerMode, body.answerPayload)
    validate_key(db, q, payload)
    db.execute("update questions set draft_answer_payload=null where id=%s", (qid,))
    db.execute("update question_answer_keys set is_primary=false where question_id=%s", (qid,))
    result = one(db,
        "insert into question_answer_keys(question_id,version,answer_payload,explanation_payload) values(%s,(select coalesce(max(version),0)+1 from question_answer_keys where question_id=%s),%s,%s) returning *",
        (qid,qid,Jsonb(payload),Jsonb(body.explanationPayload)))
    restore_active(db, q)
    return ok(result)



class Tags(Input):
    tags: Annotated[list[Annotated[str, Field(min_length=1, max_length=64)]], Field(max_length=30)]


@router.get("/banks/{bank_id}/tags")
def get_tags(bank_id: Positive, db: DB):
    bank(db, bank_id)
    return ok(
        [r["tag"] for r in db.execute("select tag from bank_tags where bank_id=%s order by tag", (bank_id,))]
    )


@router.patch("/banks/{bank_id}/tags")
def set_tags(bank_id: Positive, body: Tags, db: DB):
    bank(db, bank_id)
    tags = list({t.casefold(): t for t in body.tags}.values())
    db.execute("delete from bank_tags where bank_id=%s", (bank_id,))
    for tag in tags:
        db.execute("insert into bank_tags values(%s,%s)", (bank_id, tag))
    return ok(tags)


class SubsetIn(Input):
    name: Name
    parentId: Positive | None = None
    sortOrder: Positive = 1


@router.get("/banks/{bank_id}/subsets")
def subsets(bank_id: Positive, db: DB):
    bank(db, bank_id)
    return ok(
        db.execute(
            "select * from bank_subsets where bank_id=%s order by sort_order,id", (bank_id,)
        ).fetchall()
    )


@router.post("/banks/{bank_id}/subsets", status_code=201)
def add_subset(bank_id: Positive, body: SubsetIn, db: DB):
    bank(db, bank_id)
    return ok(
        one(
            db,
            "insert into bank_subsets(bank_id,parent_id,name,sort_order) values(%s,%s,%s,%s) returning *",
            (bank_id, body.parentId, body.name, body.sortOrder),
        )
    )


@router.patch("/banks/{bank_id}/subsets/{sid}")
def edit_subset(bank_id: Positive, sid: Positive, body: SubsetIn, db: DB):
    bank(db, bank_id)
    return ok(
        one(
            db,
            "update bank_subsets set parent_id=%s,name=%s,sort_order=%s where id=%s and bank_id=%s returning *",
            (body.parentId, body.name, body.sortOrder, sid, bank_id),
        )
    )


@router.delete("/banks/{bank_id}/subsets/{sid}", status_code=204)
def delete_subset(bank_id: Positive, sid: Positive, db: DB):
    bank(db, bank_id)
    one(db, "delete from bank_subsets where id=%s and bank_id=%s returning id", (sid, bank_id))
    return Response(status_code=204)


class GroupIn(Input):
    title: Annotated[str, Field(min_length=1, max_length=1000)]
    instructions: Annotated[str, Field(max_length=120000)] = ""
    status: Status = "active"
    subsetId: Positive | None = None
    sortOrder: Positive = 1


@router.get("/banks/{bank_id}/groups")
def groups(bank_id: Positive, db: DB):
    bank(db, bank_id)
    return ok(
        db.execute(
            "select * from question_groups where bank_id=%s order by sort_order,id", (bank_id,)
        ).fetchall()
    )


@router.post("/banks/{bank_id}/groups", status_code=201)
def add_group(bank_id: Positive, body: GroupIn, db: DB):
    bank(db, bank_id)
    return ok(
        one(
            db,
            "insert into question_groups(bank_id,title,instructions,status,subset_id,sort_order) values(%s,%s,%s,%s,%s,%s) returning *",
            (bank_id, body.title, body.instructions, body.status, body.subsetId, body.sortOrder),
        )
    )


@router.get("/groups/{gid}")
def get_group(gid: Positive, db: DB):
    g = one(db, "select * from question_groups where id=%s", (gid,))
    bank(db, g["bank_id"])
    g["questions"] = db.execute(
        "select id,stem,status,answer_mode,question_type_id from questions where group_id=%s and deleted_at is null order by sort_order,id",
        (gid,),
    ).fetchall()
    g["content_blocks"] = db.execute(
        "select * from question_content_blocks where group_id=%s order by sequence", (gid,)
    ).fetchall()
    g["media"] = db.execute(
        "select l.*,m.mime_type from media_links l join media_assets m on m.id=l.media_id where l.group_id=%s and m.deleted_at is null order by l.sort_order",
        (gid,),
    ).fetchall()
    return ok(g)


@router.patch("/groups/{gid}")
def edit_group(gid: Positive, body: GroupIn, db: DB):
    get_group(gid, db)
    return ok(
        one(
            db,
            "update question_groups set title=%s,instructions=%s,status=%s,subset_id=%s,sort_order=%s where id=%s returning *",
            (body.title, body.instructions, body.status, body.subsetId, body.sortOrder, gid),
        )
    )


@router.delete("/groups/{gid}", status_code=204)
def delete_group(gid: Positive, db: DB):
    get_group(gid, db)
    db.execute("update questions set group_id=null where group_id=%s", (gid,))
    db.execute("delete from media_links where group_id=%s", (gid,))
    db.execute("delete from question_content_blocks where group_id=%s", (gid,))
    db.execute("delete from question_groups where id=%s", (gid,))
    return Response(status_code=204)


class ReorderItem(Input):
    questionId: Positive | None = None
    groupId: Positive | None = None
    sortOrder: Positive


class Reorder(Input):
    items: Annotated[list[ReorderItem], Field(min_length=1, max_length=10000)]


@router.patch("/banks/{bank_id}/items/reorder", status_code=204)
def reorder(bank_id: Positive, body: Reorder, db: DB):
    bank(db, bank_id)
    existing = {
        (r["kind"], r["id"])
        for r in db.execute(
            "select 'q' kind,id from questions where bank_id=%s and deleted_at is null union all select 'g',id from question_groups where bank_id=%s",
            (bank_id, bank_id),
        )
    }
    incoming = [("q", i.questionId) if i.questionId is not None else ("g", i.groupId) for i in body.items]
    if (
        any((i.questionId is None) == (i.groupId is None) for i in body.items)
        or len(set(incoming)) != len(incoming)
        or set(incoming) != existing
        or len({i.sortOrder for i in body.items}) != len(body.items)
    ):
        invalid("Include every item exactly once with distinct positions")
    for i in body.items:
        if i.questionId:
            db.execute("update questions set sort_order=%s where id=%s", (i.sortOrder, i.questionId))
        else:
            db.execute("update question_groups set sort_order=%s where id=%s", (i.sortOrder, i.groupId))
    return Response(status_code=204)


@router.get("/search/questions")
def search(
    db: DB,
    page: Page,
    q: str = "",
    bankId: Positive | None = None,
    type: str = "",
    status: Status | None = None,
):
    rows = db.execute(
        "select q.id,q.bank_id,q.stem,q.question_type_id,q.answer_mode,q.status,q.missing_fields as \"missingFields\" from questions q join question_banks b on b.id=q.bank_id where b.deleted_at is null and q.deleted_at is null and q.stem ilike %s and (%s::bigint is null or q.bank_id=%s) and (%s='' or q.question_type_id=%s) and (%s::text is null or q.status=%s) order by q.updated_at desc,q.id desc limit %s offset %s",
        (f"%{q}%", bankId, bankId, type, type, status, status, page.limit + 1, page.offset),
    ).fetchall()
    return page.result(rows)


@router.get("/subjects")
def subjects(db: DB):
    return ok(db.execute("select id as subject_id,display_name from subjects order by id").fetchall())


@router.get("/question-types")
def types(db: DB, subject: str = ""):
    return ok(
        db.execute(
            "select id as type_id,subject_id,display_name,answer_mode as default_answer_mode from question_types where %s='' or subject_id=%s order by id",
            (subject, subject),
        ).fetchall()
    )


class Knowledge(Input):
    subjectId: str = "general"
    code: Annotated[str, Field(min_length=1, max_length=128)]
    displayName: Annotated[str, Field(min_length=1, max_length=256)]
    parentId: Positive | None = None


@router.get("/knowledge-points")
def knowledge(db: DB, page: Page, subject: str = "", q: str = "", parentId: Positive | None = None):
    return page.result(
        db.execute(
            "select * from knowledge_points where (%s='' or subject_id=%s) and (display_name ilike %s or code ilike %s) and (%s::bigint is null or parent_id=%s) order by id limit %s offset %s",
            (subject, subject, f"%{q}%", f"%{q}%", parentId, parentId, page.limit + 1, page.offset),
        ).fetchall()
    )


@router.post("/knowledge-points", status_code=201)
def add_knowledge(body: Knowledge, db: DB):
    return ok(
        one(
            db,
            "insert into knowledge_points(subject_id,code,display_name,parent_id) values(%s,%s,%s,%s) returning *",
            (body.subjectId, body.code, body.displayName, body.parentId),
        )
    )


@router.patch("/knowledge-points/{kid}")
def edit_knowledge(kid: Positive, body: Knowledge, db: DB):
    return ok(
        one(
            db,
            "update knowledge_points set subject_id=%s,code=%s,display_name=%s,parent_id=%s where id=%s returning *",
            (body.subjectId, body.code, body.displayName, body.parentId, kid),
        )
    )


@router.delete("/knowledge-points/{kid}", status_code=204)
def delete_knowledge(kid: Positive, db: DB):
    one(db, "delete from knowledge_points where id=%s returning id", (kid,))
    return Response(status_code=204)


class KnowledgeLinks(Input):
    knowledgePointIds: Annotated[list[Positive], Field(max_length=100)]


@router.put("/questions/{qid}/knowledge-points")
def set_knowledge(qid: Positive, body: KnowledgeLinks, db: DB):
    q = question(db, qid)
    db.execute("delete from question_knowledge_points where question_id=%s", (qid,))
    for kid in set(body.knowledgePointIds):
        db.execute("insert into question_knowledge_points values(%s,%s,%s)", (qid, kid, q["subject_id"]))
    return ok(details(db, qid, True)["knowledge_points"])


class BlockIn(Input):
    partType: Literal[
        "text", "formula", "image", "table", "list", "html", "markdown", "chart", "diagram", "qr_code"
    ]
    payload: dict


class Blocks(Input):
    blocks: Annotated[list[BlockIn], Field(max_length=1000)]


@router.put("/questions/{qid}/content-blocks")
def replace_blocks(qid: Positive, body: Blocks, db: DB):
    question(db, qid)
    db.execute("delete from question_content_blocks where question_id=%s", (qid,))
    for i, block in enumerate(body.blocks, 1):
        db.execute(
            "insert into question_content_blocks(question_id,part_type,sequence,payload) values(%s,%s,%s,%s)",
            (qid, block.partType, i, Jsonb(block.payload)),
        )
    return ok(details(db, qid, True)["content_blocks"])


@router.put("/questions/{qid}/answer-key")
def replace_key(qid: Positive, body: KeyIn, db: DB):
    return add_key(qid, body, db)


class OptionPatch(DraftInput):
    content: Annotated[str, Field(min_length=1, max_length=20000)] | None = None


@router.post("/questions/{qid}/options", status_code=201)
def add_option(qid: Positive, body: Option, db: DB):
    q = question(db, qid)
    if q["answer_mode"] != "choice":
        invalid("Only choice questions have options")
    if q["status"] == "active":
        invalid("Archive the question before adding options")
    return ok(
        one(
            db,
            "insert into question_options(question_id,option_label,content,sort_order) values(%s,%s,%s,(select coalesce(max(sort_order),0)+1 from question_options where question_id=%s)) returning *",
            (qid, body.label, body.content, qid),
        )
    )


@router.patch("/questions/{qid}/options/{oid}")
def edit_option(qid: Positive, oid: Positive, body: OptionPatch, db: DB):
    question(db, qid)
    return ok(
        one(
            db,
            "update question_options set content=%s where id=%s and question_id=%s returning *",
            (body.content, oid, qid),
        )
    )


@router.delete("/questions/{qid}/options/{oid}", status_code=204)
def delete_option(qid: Positive, oid: Positive, db: DB):
    q = question(db, qid)
    if q["status"] == "active":
        invalid("Archive the question before deleting options")
    o = one(db, "select * from question_options where id=%s and question_id=%s", (oid, qid))
    if db.execute(
        "select 1 from question_answer_keys where question_id=%s and is_primary and answer_payload->'correct' ? %s",
        (qid, o["option_label"]),
    ).fetchone():
        invalid("Update the primary answer before removing a correct option")
    db.execute("delete from question_options where id=%s", (oid,))
    return Response(status_code=204)


class QuestionLink(Input):
    questionId: Positive


@router.post("/groups/{gid}/questions")
def link_question(gid: Positive, body: QuestionLink, db: DB):
    g = get_group(gid, db)["data"]
    q = question(db, body.questionId)
    if q["bank_id"] != g["bank_id"]:
        invalid("Question and material must belong to the same bank")
    db.execute("update questions set group_id=%s where id=%s", (gid, body.questionId))
    return ok(details(db, body.questionId, True))


@router.delete("/groups/{gid}/questions/{qid}", status_code=204)
def unlink_question(gid: Positive, qid: Positive, db: DB):
    get_group(gid, db)
    one(db, "update questions set group_id=null where id=%s and group_id=%s returning id", (qid, gid))
    return Response(status_code=204)


def group_state(gid, action, db):
    get_group(gid, db)
    db.execute(
        "update question_groups set status=%s where id=%s",
        ("active" if action == "publish" else "archived", gid),
    )
    return get_group(gid, db)


@router.post("/groups/{gid}/publish")
def publish_group(gid: Positive, db: DB):
    return group_state(gid, "publish", db)


@router.post("/groups/{gid}/archive")
def archive_group(gid: Positive, db: DB):
    return group_state(gid, "archive", db)


class GroupReorder(Input):
    questionIds: Annotated[list[Positive], Field(min_length=1, max_length=10000)]


@router.patch("/groups/{gid}/questions/reorder", status_code=204)
def reorder_group(gid: Positive, body: GroupReorder, db: DB):
    get_group(gid, db)
    ids = {
        r["id"]
        for r in db.execute("select id from questions where group_id=%s and deleted_at is null", (gid,))
    }
    if set(body.questionIds) != ids or len(body.questionIds) != len(ids):
        invalid("Include all group questions exactly once")
    for index, qid in enumerate(body.questionIds, 1):
        db.execute("update questions set sort_order=%s where id=%s", (index, qid))
    return Response(status_code=204)


class SubsetOrder(Input):
    id: Positive
    sortOrder: Positive


class SubsetReorder(Input):
    items: Annotated[list[SubsetOrder], Field(min_length=1, max_length=10000)]


# Register before the parameterized subset PATCH route to avoid matching 'reorder' as an ID.
@router.patch("/banks/{bank_id}/subsets/reorder", status_code=204)
def reorder_subsets(bank_id: Positive, body: SubsetReorder, db: DB):
    bank(db, bank_id)
    ids = {r["id"] for r in db.execute("select id from bank_subsets where bank_id=%s", (bank_id,))}
    if (
        {i.id for i in body.items} != ids
        or len(body.items) != len(ids)
        or len({i.sortOrder for i in body.items}) != len(ids)
    ):
        invalid("Include every subset exactly once with unique positions")
    for item in body.items:
        db.execute("update bank_subsets set sort_order=%s where id=%s", (item.sortOrder, item.id))
    return Response(status_code=204)


# Literal routes take precedence over parameterized routes within this module.
router.routes.sort(key=lambda route: "{" in route.path.rsplit("/", 1)[-1])
