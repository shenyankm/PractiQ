"""Personal content operations; SQL and Pydantic are the contracts."""

from typing import Annotated, Literal

from fastapi import APIRouter, Response
from psycopg.types.json import Jsonb
from pydantic import Field, model_validator

from .core import DB, Input, Name, Page, Positive, bank, invalid, ok, one, question

router = APIRouter(prefix="/api/v1")
Mode = Literal["choice", "true_false", "fill_blank", "short_answer"]
Status = Literal["draft", "active", "archived"]


class BankIn(Input):
    name: Name
    subject: str = "general"
    description: Annotated[str, Field(max_length=500)] = ""


class BankPatch(Input):
    name: Name | None = None
    description: Annotated[str, Field(max_length=500)] | None = None


class Option(Input):
    label: Annotated[str, Field(min_length=1, max_length=16)]
    content: Annotated[str, Field(min_length=1, max_length=20000)]
    isCorrect: bool = False


class QuestionIn(Input):
    questionTypeId: Annotated[str, Field(min_length=1, max_length=64)]
    answerMode: Mode
    stem: Annotated[str, Field(min_length=1, max_length=120000)]
    analysis: Annotated[str, Field(max_length=100000)] = ""
    choiceVariant: Literal["single", "multiple"] | None = None
    status: Status = "draft"
    options: Annotated[list[Option], Field(max_length=100)] = Field(default_factory=list)
    answerPayload: dict = Field(default_factory=dict)
    groupId: Positive | None = None
    subsetId: Positive | None = None

    @model_validator(mode="after")
    def shape(self):
        labels = [o.label for o in self.options]
        if len(set(labels)) != len(labels):
            raise ValueError("Option labels must be unique")
        if self.answerMode == "choice":
            if not self.choiceVariant or len(labels) < 2:
                raise ValueError("Choice questions require a variant and at least two options")
        elif self.choiceVariant or self.options:
            raise ValueError("Only choice questions have options")
        return self


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
    raw = payload.get("value", payload.get("answers", payload.get("answer")))
    if mode == "true_false" and not isinstance(raw, bool):
        invalid("A boolean answer is required")
    if mode == "fill_blank":
        if isinstance(raw, str):
            raw = [raw]
        if not isinstance(raw, list) or not raw or any(not isinstance(v, str) or not v.strip() for v in raw):
            invalid("Blank answers must contain non-empty text")
        return {"answers": raw}
    if mode == "short_answer" and (not isinstance(raw, str) or not raw.strip()):
        invalid("A reference answer is required")
    return {"answer": raw}


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


def details(db, qid, management=False):
    q = question(db, qid)
    q["options"] = db.execute(
        "select * from question_options where question_id=%s order by sort_order", (qid,)
    ).fetchall()
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
        q.pop("analysis", None)
    return q


def create_question(db, bank_id, body: QuestionIn):
    b = bank(db, bank_id)
    has_key = bool(body.answerPayload) or any(o.isCorrect for o in body.options)
    key = normalize_key(body.answerMode, body.answerPayload, body.options) if has_key else None
    if key is None and body.status == "active":
        invalid("Publish requires an answer key")
    q = one(
        db,
        """insert into questions(bank_id,subject_id,question_type_id,answer_mode,choice_variant,stem,analysis,status,group_id,subset_id,sort_order)
        values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,(select coalesce(max(sort_order),0)+1 from questions where bank_id=%s)) returning *""",
        (
            bank_id,
            b["subject_id"],
            body.questionTypeId,
            body.answerMode,
            body.choiceVariant,
            body.stem,
            body.analysis,
            body.status,
            body.groupId,
            body.subsetId,
            bank_id,
        ),
    )
    for i, o in enumerate(body.options):
        db.execute(
            "insert into question_options(question_id,option_label,content,sort_order) values(%s,%s,%s,%s)",
            (q["id"], o.label, o.content, i + 1),
        )
    if key is not None:
        validate_key(db, q, key)
        db.execute(
            "insert into question_answer_keys(question_id,version,answer_payload) values(%s,1,%s)",
            (q["id"], Jsonb(key)),
        )
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
def items(bank_id: Positive, db: DB, page: Page, status: Status | None = None, type: str = ""):
    bank(db, bank_id)
    rows = db.execute(
        "select id as question_id,id,bank_id,question_type_id,answer_mode,choice_variant,stem,status as question_status,group_id,subset_id,sort_order from questions where bank_id=%s and deleted_at is null and (%s::text is null or status=%s) and (%s='' or question_type_id=%s) order by sort_order,id limit %s offset %s",
        (bank_id, status, status, type, type, page.limit + 1, page.offset),
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


class QuestionPatch(Input):
    options: Annotated[list[Option], Field(max_length=100)] | None = None
    stem: Annotated[str, Field(min_length=1, max_length=120000)] | None = None
    analysis: Annotated[str, Field(max_length=100000)] | None = None
    groupId: Positive | None = None
    subsetId: Positive | None = None


@router.patch("/questions/{qid}")
def edit_question(qid: Positive, body: QuestionPatch, db: DB):
    question(db, qid)
    if not body.model_fields_set:
        invalid("Provide a field to update")
    if "stem" in body.model_fields_set and body.stem is None:
        invalid("Stem cannot be null")
    db.execute(
        "update questions set stem=coalesce(%s,stem),analysis=case when %s then %s else analysis end,group_id=case when %s then %s else group_id end,subset_id=case when %s then %s else subset_id end,updated_at=now() where id=%s",
        (
            body.stem,
            "analysis" in body.model_fields_set,
            body.analysis,
            "groupId" in body.model_fields_set,
            body.groupId,
            "subsetId" in body.model_fields_set,
            body.subsetId,
            qid,
        ),
    )
    if body.options is not None:
        old_labels = {
            r["option_label"]
            for r in db.execute("select option_label from question_options where question_id=%s", (qid,))
        }
        if {o.label for o in body.options} != old_labels or len(body.options) != len(old_labels):
            invalid("Existing option labels cannot be changed")
        for option in body.options:
            db.execute(
                "update question_options set content=%s where question_id=%s and option_label=%s",
                (option.content, qid, option.label),
            )
    return ok(details(db, qid, True))


@router.post("/questions/{qid}/publish")
def publish(qid: Positive, db: DB):
    q = question(db, qid)
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
    db.execute("update question_answer_keys set is_primary=false where question_id=%s", (qid,))
    return ok(
        one(
            db,
            "insert into question_answer_keys(question_id,version,answer_payload,explanation_payload) values(%s,(select coalesce(max(version),0)+1 from question_answer_keys where question_id=%s),%s,%s) returning *",
            (qid, qid, Jsonb(payload), Jsonb(body.explanationPayload)),
        )
    )


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
        "select id,stem,status from questions where group_id=%s and deleted_at is null order by sort_order,id",
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
        "select q.id,q.bank_id,q.stem,q.question_type_id,q.answer_mode,q.status from questions q join question_banks b on b.id=q.bank_id where b.deleted_at is null and q.deleted_at is null and q.stem ilike %s and (%s::bigint is null or q.bank_id=%s) and (%s='' or q.question_type_id=%s) and (%s::text is null or q.status=%s) order by q.updated_at desc,q.id desc limit %s offset %s",
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


class OptionPatch(Input):
    content: Annotated[str, Field(min_length=1, max_length=20000)]


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
