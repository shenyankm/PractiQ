import hashlib
import io
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
from PIL import Image
from psycopg.types.json import Jsonb

from practiq_backend.worker import claim, complete, run_once
from conftest import write


def test_content_constraints_and_soft_delete(client, content):
    b, q = content
    assert "answer_keys" not in client.get(f"/api/v1/questions/{q['id']}").json()["data"]
    assert write(client, "POST", f"/banks/{b['id']}/favorite").status_code == 204
    assert len(client.get("/api/v1/banks?scope=favorites").json()["data"]) == 1
    g = write(client, "POST", f"/banks/{b['id']}/groups", {"title": "材料"}).json()["data"]
    assert write(client, "PATCH", f"/questions/{q['id']}", {"groupId": g["id"]}).status_code == 200
    other = write(client, "POST", "/banks", {"name": "其他"}).json()["data"]
    bad = write(
        client,
        "POST",
        f"/banks/{other['id']}/questions",
        {
            "questionTypeId": "true_false",
            "answerMode": "true_false",
            "stem": "对吗",
            "answerPayload": {"value": True},
            "groupId": g["id"],
        },
    )
    assert bad.status_code == 409
    assert client.get(f"/api/v1/banks/{other['id']}/items").json()["data"] == []
    assert write(client, "DELETE", f"/banks/{b['id']}").status_code == 204
    assert client.get(f"/api/v1/questions/{q['id']}").status_code == 404


def test_idempotency_replay_conflict_and_validation(client):
    key = str(uuid.uuid4())
    r = write(client, "POST", "/banks", {"name": "once"}, key)
    assert r.status_code == 201, r.text
    replay = write(client, "POST", "/banks", {"name": "once"}, key)
    assert replay.content == r.content
    assert write(client, "POST", "/banks", {"name": "different"}, key).status_code == 409
    assert write(client, "POST", "/banks", {"name": " ", "unexpected": 1}).status_code == 422
    assert client.post("/api/v1/banks", json={"name": "no key"}).status_code == 422
    assert len(client.get("/api/v1/banks").json()["data"]) == 1


def test_concurrent_idempotency(app, client):
    barrier = threading.Barrier(2)
    key = str(uuid.uuid4())

    def create():
        barrier.wait()
        return write(client, "POST", "/banks", {"name": "concurrent"}, key)

    with ThreadPoolExecutor(2) as executor:
        results = list(executor.map(lambda _: create(), range(2)))
    assert all(r.status_code in {201, 409} for r in results)
    assert write(client, "POST", "/banks", {"name": "concurrent"}, key).status_code == 201
    assert len(client.get("/api/v1/banks").json()["data"]) == 1


def test_exam_hides_answers_and_freezes_key(client, content):
    b, q = content
    s = write(client, "POST", "/practice-sessions", {"bankId": b["id"], "mode": "exam"}).json()["data"]
    write(
        client,
        "POST",
        f"/questions/{q['id']}/answer-keys",
        {"answerMode": "choice", "answerPayload": {"correct": ["B"]}},
    )
    a = write(
        client,
        "POST",
        f"/practice-sessions/{s['id']}/answers",
        {"questionId": q["id"], "answerPayload": {"selected": ["A"]}},
    )
    assert a.status_code == 201, a.text
    assert a.json()["data"]["is_correct"] is None
    snapshot = client.get("/api/v1/analytics/snapshot").json()["data"]
    assert snapshot["summary"]["attempts"] == 0
    assert snapshot["recentSessions"][0]["correct_count"] is None
    assert (
        client.get(f"/api/v1/practice-sessions/{s['id']}/question-page").json()["data"]["progress"][0][
            "isCorrect"
        ]
        is None
    )
    assert write(client, "POST", f"/practice-sessions/{s['id']}/complete").status_code == 200
    result = client.get(f"/api/v1/practice-sessions/{s['id']}/results").json()["data"][0]["result"]
    assert result["is_correct"] is True
    assert result["answer_key_payload"] == {"correct": ["A"]}
    assert client.get("/api/v1/analytics/snapshot").json()["data"]["summary"]["correct"] == 1


def test_hierarchy_and_knowledge(client, content):
    b, q = content
    root = write(client, "POST", f"/banks/{b['id']}/subsets", {"name": "root"}).json()["data"]
    child = write(
        client, "POST", f"/banks/{b['id']}/subsets", {"name": "child", "parentId": root["id"]}
    ).json()["data"]
    assert (
        write(
            client,
            "PATCH",
            f"/banks/{b['id']}/subsets/{root['id']}",
            {"name": "root", "parentId": child["id"]},
        ).status_code
        == 409
    )
    k = write(client, "POST", "/knowledge-points", {"code": "math", "displayName": "数学"}).json()["data"]
    assert (
        write(
            client, "PUT", f"/questions/{q['id']}/knowledge-points", {"knowledgePointIds": [k["id"]]}
        ).status_code
        == 200
    )
    assert write(client, "DELETE", f"/knowledge-points/{k['id']}").status_code == 409


def make_import(client, bank_id):
    r = write(
        client, "POST", "/import-jobs", {"bankId": bank_id, "sourceType": "text", "fileName": "questions.txt"}
    )
    assert r.status_code == 201, r.text
    j = r.json()["data"]
    r = client.post(
        f"/api/v1/import-jobs/{j['id']}/file",
        files={"file": ("questions.txt", b"1+1=2", "text/plain")},
        headers={"Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 201, r.text
    r = write(client, "POST", f"/import-jobs/{j['id']}/parse")
    assert r.status_code == 200, r.text
    return r.json()["data"]


def parsed():
    return {
        "questions": [
            {
                "stem": "Imported",
                "answerMode": "choice",
                "questionTypeId": "choice",
                "options": [
                    {"label": "A", "content": "yes", "isCorrect": True},
                    {"label": "B", "content": "no"},
                ],
                "answerPayload": {"correctOption": "A"},
                "contentBlocks": [{"partType": "text", "textValue": "Imported"}],
            }
        ],
        "groups": [],
    }


def test_worker_import_usage_cleanup_and_fencing(client, app, content):
    b, _ = content
    j = make_import(client, b["id"])
    response = {
        "data": parsed(),
        "meta": {"usage": [{"callId": "call-1", "inputTokens": 5, "outputTokens": 3}]},
    }
    with httpx.Client(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=response))
    ) as ai:
        assert run_once(app.state.pool, app.state.settings, ai)
    latest = client.get(f"/api/v1/import-jobs/{j['id']}").json()["data"]
    assert latest["status"] == "completed"
    assert latest["source_deleted_at"] is not None
    outputs = client.get(f"/api/v1/import-jobs/{j['id']}/outputs").json()["data"]
    assert len(outputs) == 1
    with app.state.pool.connection() as db:
        assert db.execute("select count(*) n from ai_task_calls").fetchone()["n"] == 1
    assert not any(p.is_file() for p in (app.state.settings.media_dir / "imports").rglob("*"))


def test_retry_lease_cancel_and_failed_usage(client, app, content):
    j = make_import(client, content[0]["id"])
    first = claim(app.state.pool, uuid.uuid4())
    with app.state.pool.connection() as db:
        db.execute(
            "update ai_tasks set worker_lease_until=now()-interval '1 second' where id=%s", (first["id"],)
        )
    second = claim(app.state.pool, uuid.uuid4())
    assert second["attempt"] == first["attempt"] + 1
    assert complete(app.state.pool, first, parsed(), [{"callId": "late"}]) is False
    assert (
        complete(
            app.state.pool, second, None, [{"callId": "failed"}], {"code": "AI_ERROR", "message": "failed"}
        )
        is False
    )
    assert write(client, "POST", f"/import-jobs/{j['id']}/retry").status_code == 200
    third = claim(app.state.pool, uuid.uuid4())
    assert write(client, "POST", f"/import-jobs/{j['id']}/cancel").status_code == 200
    assert complete(app.state.pool, third, parsed(), [{"callId": "cancelled-late"}]) is False
    with app.state.pool.connection() as db:
        assert db.execute("select count(*) n from ai_task_calls").fetchone()["n"] == 3
        assert db.execute("select count(*) n from question_import_job_outputs").fetchone()["n"] == 0


def test_invalid_import_rolls_back_all_questions(client, app, content):
    j = make_import(client, content[0]["id"])
    t = claim(app.state.pool, uuid.uuid4())
    result = parsed()
    result["questions"].append({**result["questions"][0], "stem": 123})
    assert complete(app.state.pool, t, result, [{"callId": "invalid"}]) is False
    assert client.get(f"/api/v1/import-jobs/{j['id']}").json()["data"]["status"] == "failed"
    assert client.get(f"/api/v1/import-jobs/{j['id']}/outputs").json()["data"] == []
    assert len(client.get(f"/api/v1/banks/{content[0]['id']}/items").json()["data"]) == 1


def test_media_and_multipart_retry(client, content):
    out = io.BytesIO()
    Image.new("RGB", (4, 4)).save(out, format="PNG")
    key = str(uuid.uuid4())

    def upload(data):
        return client.post(
            "/api/v1/media", files={"file": ("test.png", data, "image/png")}, headers={"Idempotency-Key": key}
        )

    r = upload(out.getvalue())
    assert r.status_code == 201, r.text
    assert upload(out.getvalue()).content == r.content
    assert upload(b"different").status_code == 409
    mid = r.json()["data"]["id"]
    assert client.get(f"/api/v1/media/{mid}/content").content == out.getvalue()
    q = content[1]
    assert write(client, "POST", f"/questions/{q['id']}/media-links", {"mediaId": mid}).status_code == 201
    assert write(client, "DELETE", f"/media/{mid}").status_code == 409


def test_origin_host_paths_and_removed_routes(client):
    r = client.post(
        "/api/v1/banks",
        json={"name": "bad"},
        headers={"Origin": "https://evil.example", "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 403
    assert client.get("/api/health", headers={"Host": "evil.example"}).status_code == 400
    assert client.get("/api/v1/banks;alias").status_code == 400
    assert client.get("/api/v1/banks?cursor=bad").status_code == 422
    for path in ("/auth/wechat-login", "/payment-orders", "/users/me", "/study-groups", "/admin/users"):
        assert client.get("/api/v1" + path).status_code == 404


def test_timeout_keeps_usage_and_source_retry_window(client, app, content):
    j = make_import(client, content[0]["id"])
    task = claim(app.state.pool, uuid.uuid4())
    with app.state.pool.connection() as db:
        db.execute("update ai_tasks set deadline_at=now()-interval '1 second' where id=%s", (task["id"],))
    assert complete(app.state.pool, task, parsed(), [{"callId": "deadline"}]) is False
    current = client.get(f"/api/v1/import-jobs/{j['id']}").json()["data"]
    assert current["task"]["status"] == "timed_out"
    assert current["source_deleted_at"] is None
    assert write(client, "POST", f"/import-jobs/{j['id']}/retry").status_code == 200


def test_failed_http_call_records_usage(client, app, content):
    make_import(client, content[0]["id"])
    response = {
        "error": {"code": "AI_ERROR", "message": "model failed"},
        "meta": {"usage": [{"callId": "model-failure", "inputTokens": 10}]},
    }
    with httpx.Client(transport=httpx.MockTransport(lambda req: httpx.Response(502, json=response))) as ai:
        assert run_once(app.state.pool, app.state.settings, ai)
    with app.state.pool.connection() as db:
        assert db.execute("select status from ai_tasks").fetchone()["status"] == "failed"
        assert db.execute("select usage from ai_task_calls").fetchone()["usage"]["inputTokens"] == 10


def test_file_validation_and_empty_draft(client, content):
    b, _ = content
    j = write(
        client, "POST", "/import-jobs", {"bankId": b["id"], "sourceType": "pdf", "fileName": "bad.pdf"}
    ).json()["data"]
    r = client.post(
        f"/api/v1/import-jobs/{j['id']}/file",
        files={"file": ("bad.pdf", b"not a pdf", "application/pdf")},
        headers={"Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 422
    q = write(
        client,
        "POST",
        f"/banks/{b['id']}/questions",
        {"questionTypeId": "short_answer", "answerMode": "short_answer", "stem": "A draft without an answer"},
    )
    assert q.status_code == 201, q.text
    assert write(client, "POST", f"/questions/{q.json()['data']['id']}/publish").status_code != 200


def test_fresh_schema_no_accounts_and_spa_deep_links(client, app):
    with app.state.pool.connection() as db:
        tables = {
            r["table_name"]
            for r in db.execute(
                "select table_name from information_schema.tables where table_schema=current_schema()"
            )
        }
    assert not tables.intersection(
        {"users", "auth_sessions", "credit_accounts", "payment_orders", "study_groups"}
    )
    app.state.settings.web_dist.mkdir()
    (app.state.settings.web_dist / "index.html").write_text("<html>PractiQ</html>")
    assert client.get("/banks/1").text == "<html>PractiQ</html>"
    assert client.get("/api/v1/missing").status_code == 404
    assert client.get("/missing.js").status_code == 404


def test_answer_and_report_use_semantic_payloads(client, app, content):
    b, q = content
    t = write(client, "POST", f"/questions/{q['id']}/ai-answer-tasks")
    assert t.status_code == 201
    with app.state.pool.connection() as db:
        payload = db.execute(
            "select request_payload from ai_tasks where id=%s", (t.json()["data"]["id"],)
        ).fetchone()["request_payload"]
        assert not set(payload).intersection({"userId", "questionId", "bankId"})
    s = write(client, "POST", "/practice-sessions", {"bankId": b["id"]}).json()["data"]
    write(
        client,
        "POST",
        f"/practice-sessions/{s['id']}/answers",
        {"questionId": q["id"], "answerPayload": {"selected": ["A"]}},
    )
    report = write(client, "POST", "/analytics/report-tasks")
    assert report.status_code == 201, report.text
    with app.state.pool.connection() as db:
        payload = db.execute(
            "select request_payload from ai_tasks where id=%s", (report.json()["data"]["id"],)
        ).fetchone()["request_payload"]
        assert payload["stats"]["attemptCount"] == 1
        assert payload["stats"]["accuracy"] == 1
    assert write(client, "DELETE", f"/banks/{b['id']}/practice-data").status_code == 204
    assert client.get(f"/api/v1/ai-tasks/{report.json()['data']['id']}").status_code == 410


def test_import_creates_bank_metadata_atomically_and_replays(client, app, monkeypatch):
    body = {"name": "期末复习", "description": "数学复习资料", "tags": ["数学", "考试"],
            "sourceType": "pdf", "fileName": "exam.pdf"}
    key = str(uuid.uuid4())
    first = write(client, "POST", "/import-jobs", body, key=key)
    assert first.status_code == 201, first.text
    assert write(client, "POST", "/import-jobs", body, key=key).json() == first.json()
    bank_id = first.json()["data"]["bank_id"]
    assert client.get(f"/api/v1/banks/{bank_id}").json()["data"]["description"] == body["description"]
    assert set(client.get(f"/api/v1/banks/{bank_id}/tags").json()["data"]) == set(body["tags"])
    assert write(client, "POST", "/import-jobs", {**body, "name": "changed"}, key=key).status_code == 409
    assert write(client, "POST", "/import-jobs", {**body, "name": " "}).status_code == 422
    from practiq_backend import tasks
    def invalid_tag(bank_id, body, db):
        db.execute("insert into bank_tags values(%s,%s)", (bank_id, "duplicate"))
        db.execute("insert into bank_tags values(%s,%s)", (bank_id, "duplicate"))
    monkeypatch.setattr(tasks, "set_tags", invalid_tag)
    before = len(client.get('/api/v1/banks').json()['data'])
    assert write(client, "POST", "/import-jobs", {**body, "name": "rolled back"}).status_code == 409
    assert len(client.get('/api/v1/banks').json()['data']) == before


def test_metadata_worker_validation_usage_and_cancel(client, app):
    payload = {"description": "数学复习建议", "tags": ["数学", "复习"]}
    def respond(request):
        assert request.url.path == '/api/v1/ai/bank-metadata'
        assert request.read() == b'{"name":"Math"}'
        return httpx.Response(200, json={"data": payload, "meta": {"usage": [{"callId": "metadata"}]}})
    created = write(client, 'POST', '/bank-metadata-tasks', {"name": "Math"})
    assert created.status_code == 201
    with httpx.Client(transport=httpx.MockTransport(respond)) as ai:
        assert run_once(app.state.pool, app.state.settings, ai)
    task = client.get(f"/api/v1/ai-tasks/{created.json()['data']['id']}").json()['data']
    assert task['status'] == 'succeeded' and task['result'] == payload
    assert len(task['usage']) == 1
    write(client, 'POST', '/bank-metadata-tasks', {"name": "Math"})
    running = claim(app.state.pool, uuid.uuid4())
    assert not complete(app.state.pool, running, {"description": "x", "tags": ["x" * 65]}, [{"callId": "invalid"}])
    write(client, 'POST', '/bank-metadata-tasks', {"name": "Math"})
    running = claim(app.state.pool, uuid.uuid4())
    assert write(client, 'POST', f"/ai-tasks/{running['id']}/cancel").status_code == 200
    assert not complete(app.state.pool, running, payload, [{"callId": "late"}])


def test_complex_question_types_grading_review_and_groups(client, content):
    b, choice_q = content

    def create(payload, expect=201):
        r = write(client, "POST", f"/banks/{b['id']}/questions", {"analysis": "解析", "sourceText": "真实测试材料", **payload})
        assert r.status_code == expect, r.text
        return r.json()["data"] if expect == 201 else None

    # 排序题：下标创建 + 缺省顺序 + 形状校验
    oq = create({
        "questionTypeId": "ordering", "answerMode": "ordering", "stem": "按顺序排列", "status": "active",
        "items": [{"content": "甲"}, {"content": "乙"}, {"content": "丙"}],
        "answerPayload": {"order": [2, 0, 1]},
    })
    ids = [i["id"] for i in oq["items"]]
    assert oq["answer_keys"][0]["answer_payload"]["order"] == [ids[2], ids[0], ids[1]]
    default_q = create({
        "questionTypeId": "ordering", "answerMode": "ordering", "stem": "默认顺序", "status": "active",
        "answerPayload": {"order": [0, 1]},
        "items": [{"content": "一"}, {"content": "二"}],
    })
    assert default_q["answer_keys"][0]["answer_payload"]["order"] == [i["id"] for i in default_q["items"]]
    create({"questionTypeId": "ordering", "answerMode": "ordering", "stem": "太少", "items": [{"content": "甲"}]})

    # 连线题 one_to_one：缺 variant / 数量不等 → 422；下标配对归一化为 id
    create({
        "questionTypeId": "matching", "answerMode": "matching", "stem": "缺变体", "status": "active",
        "items": [{"side": "left", "content": "a"}, {"side": "left", "content": "b"}, {"side": "right", "content": "x"}, {"side": "right", "content": "y"}],
    }, 409)
    mq = create({
        "questionTypeId": "matching", "answerMode": "matching", "matchingVariant": "one_to_one",
        "stem": "国家-首都", "status": "active",
        "items": [
            {"side": "left", "content": "中国"}, {"side": "left", "content": "法国"},
            {"side": "right", "content": "巴黎"}, {"side": "right", "content": "北京"},
        ],
        "answerPayload": {"matches": [{"left": 0, "right": 1}, {"left": 1, "right": 0}]},
    })
    lefts = [i["id"] for i in mq["items"] if i["side"] == "left"]
    rights = [i["id"] for i in mq["items"] if i["side"] == "right"]
    assert mq["answer_keys"][0]["answer_payload"]["matches"] == [
        {"left": lefts[0], "right": rights[1]}, {"left": lefts[1], "right": rights[0]},
    ]

    # 填空题：每空多可接受答案 + blank_count
    fq = create({
        "questionTypeId": "fill_blank", "answerMode": "fill_blank", "stem": "2 读作___，3 读作___", "status": "active",
        "answerPayload": {"answers": [["2", "two"], "三"]},
    })
    assert client.get(f"/api/v1/questions/{fq['id']}").json()["data"]["blank_count"] == 2

    # 简答题：关键词判分（部分得分）与人工判分（自评）
    kq_ok = create({
        "questionTypeId": "short_answer", "answerMode": "short_answer", "stem": "说明导数与积分", "status": "active",
        "answerPayload": {"answer": "导数是变化率", "grading": {"type": "keyword", "keywords": [{"text": "导数", "weight": 1}, {"text": "积分", "weight": 3}], "threshold": 0.5}},
    })
    kq_low = create({
        "questionTypeId": "short_answer", "answerMode": "short_answer", "stem": "再说明一次", "status": "active",
        "answerPayload": {"answer": "导数是变化率", "grading": {"type": "keyword", "keywords": [{"text": "导数", "weight": 1}, {"text": "积分", "weight": 3}], "threshold": 0.5}},
    })
    manual_q = create({
        "questionTypeId": "short_answer", "answerMode": "short_answer", "stem": "简述方法", "status": "active",
        "answerPayload": {"answer": "略"},
    })

    # 分组 + groupId 筛选 + 组详情
    g = write(client, "POST", f"/banks/{b['id']}/groups", {"title": "材料组", "sortOrder": 1}).json()["data"]
    assert write(client, "PATCH", f"/questions/{choice_q['id']}", {"groupId": g["id"]}).status_code == 200
    assert write(client, "PATCH", f"/questions/{mq['id']}", {"groupId": g["id"]}).status_code == 200
    listed = client.get(f"/api/v1/banks/{b['id']}/items?groupId={g['id']}").json()["data"]
    assert [q["question_id"] for q in listed] == [choice_q["id"], mq["id"]]
    group_detail = client.get(f"/api/v1/groups/{g['id']}").json()["data"]
    assert len(group_detail["questions"]) == 2 and "content_blocks" in group_detail and "media" in group_detail

    # 会话：组优先排序 + 逐题判分
    s = write(client, "POST", "/practice-sessions", {"bankId": b["id"], "mode": "all"}).json()["data"]
    assert s["question_count"] == 8
    ordered = [q["id"] for q in client.get(f"/api/v1/practice-sessions/{s['id']}/questions").json()["data"]]
    assert ordered[:2] == [choice_q["id"], mq["id"]]

    def answer(qid, payload, expect=201):
        r = write(client, "POST", f"/practice-sessions/{s['id']}/answers", {"questionId": qid, "answerPayload": payload})
        assert r.status_code == expect, r.text
        return r.json()["data"] if expect == 201 else None

    assert answer(choice_q["id"], {"selected": ["A"]})["is_correct"] is True
    answer(mq["id"], {"matches": [{"left": lefts[0], "right": rights[0]}, {"left": lefts[1], "right": rights[0]}]}, 422)
    assert answer(mq["id"], {"matches": [{"left": lefts[0], "right": rights[1]}, {"left": lefts[1], "right": rights[0]}]})["score"] == 1
    assert answer(oq["id"], {"order": [ids[0], ids[1], ids[2]]})["is_correct"] is False
    answer(fq["id"], {"value": ["2"]}, 422)
    assert answer(fq["id"], {"value": ["Two", "三"]})["is_correct"] is True
    assert answer(kq_ok["id"], {"value": "导数和积分都重要"})["is_correct"] is True
    low = answer(kq_low["id"], {"value": "导数"})
    assert low["is_correct"] is False and low["score"] == 0.25
    manual = answer(manual_q["id"], {"value": "自评作答"})
    assert manual["is_correct"] is None and manual["score"] is None

    # 自评：未判分可回写、重复回写 409、已判分 409、未作答 404
    rv = write(client, "POST", f"/practice-sessions/{s['id']}/answers/{manual_q['id']}/review", {"isCorrect": True})
    assert rv.status_code == 200, rv.text
    assert rv.json()["data"]["is_correct"] is True and rv.json()["data"]["score"] == 1
    assert write(client, "POST", f"/practice-sessions/{s['id']}/answers/{manual_q['id']}/review", {"isCorrect": False}).status_code == 409
    assert write(client, "POST", f"/practice-sessions/{s['id']}/answers/{kq_ok['id']}/review", {"isCorrect": True}).status_code == 409
    assert write(client, "POST", f"/practice-sessions/{s['id']}/answers/{default_q['id']}/review", {"isCorrect": True}).status_code == 404

    # 条目替换：缺 answerPayload → 409；带下标 answerPayload → 原子出新键版本
    assert write(client, "PATCH", f"/questions/{oq['id']}", {"items": [{"content": "丙"}, {"content": "甲"}, {"content": "乙"}]}).status_code == 409
    edited = write(
        client,
        "PATCH",
        f"/questions/{oq['id']}",
        {"items": [{"content": "丙"}, {"content": "甲"}, {"content": "乙"}], "answerPayload": {"order": [0, 1, 2]}},
    )
    assert edited.status_code == 200, edited.text
    edited = edited.json()["data"]
    new_ids = [i["id"] for i in edited["items"]]
    assert edited["answer_keys"][-1]["is_primary"] and edited["answer_keys"][-1]["answer_payload"]["order"] == new_ids

    # 交卷后结果与部分得分
    write(client, "POST", f"/practice-sessions/{s['id']}/complete")
    by_id = {q["id"]: q["result"] for q in client.get(f"/api/v1/practice-sessions/{s['id']}/results").json()["data"]}
    assert by_id[kq_low["id"]]["is_correct"] is False and by_id[kq_low["id"]]["score"] == 0.25
    assert by_id[manual_q["id"]]["is_correct"] is True
