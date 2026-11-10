"""Real PostgreSQL support operations; paid providers are never invoked."""
import asyncio
import hashlib
import json
from collections import OrderedDict
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from psycopg.types.json import Jsonb

from practiq_ai import admin_api, grading, identity, runtime, task_api, webapp
from practiq_ai.config import load
from practiq_ai.contracts import AdministrationFilter
from practiq_ai.import_control import ImportControl
from tests.db_support import new_database

PASSWORD = 'administrator-test-password'


async def sign_in(client, email='admin@example.test'):
    session = (await client.get('/api/auth/session')).json()
    reply = await client.post('/api/auth/login', json={'email': email, 'password': PASSWORD}, headers={'X-CSRF-Token': session['csrf']})
    assert reply.status_code == 200, reply.text
    client.headers['X-CSRF-Token'] = reply.json()['csrf']


@pytest.fixture
async def admin_service(disposable_databases, monkeypatch):
    for key, value in {'AI_READ_ONLY': '0', 'LLM_PROVIDER': 'openai', 'LLM_MODEL': 'test-model', 'LLM_API_KEY': 'secret-never-returned', 'LLM_BASE_URL': 'http://127.0.0.1:19099/v1'}.items():
        monkeypatch.setenv(key, value)
    database = await new_database()
    monkeypatch.setattr(runtime, 'current', SimpleNamespace(db=database, accepting=True, import_control=ImportControl(), task_summaries=OrderedDict(), active={}, delivery=SimpleNamespace(publisher_connected=True, consumer_connected=True)))
    encoded = await identity.password_hash(PASSWORD)
    async with database.transaction() as conn:
        for name, role in [('admin', 'admin'), ('alice', 'user'), ('bob', 'user')]:
            await conn.execute('INSERT INTO auth_users(id,email,name,password_hash,role) VALUES(%s,%s,%s,%s,%s)', (name, f'{name}@example.test', name.title(), encoded, role))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url='http://test') as client:
        yield database, client


async def add_call(db, key, user='alice', kind='modelCalls', record=None, scope='grade:example'):
    async with db.transaction() as conn:
        await conn.execute("INSERT INTO auth_calls(call_key,user_id,scope,kind,day,record,created_at) VALUES(%s,%s,%s,%s,'2026-11-09',%s,'2026-11-09T00:00:00Z')", (key, user, scope, kind, Jsonb(record or {'status': 'completed', 'usageStatus': 'known', 'inputTokens': 5, 'outputTokens': 3, 'modelId': 'test-model'})))


async def test_audit_actor_email_is_admin_only_searchable_and_preserves_unmapped_actors(admin_service):
    db, client = admin_service
    async with db.transaction() as conn:
        for actor in ('admin', 'alice', 'operator', 'monitoring', 'historical-actor'):
            await conn.execute("INSERT INTO auth_audit(actor,action,target) VALUES(%s,'email_test','sample')", (actor,))
    assert (await client.get('/api/admin/audit')).status_code == 401
    await sign_in(client, 'alice@example.test')
    assert (await client.get('/api/admin/audit')).status_code == 403
    await client.post('/api/auth/logout')
    await sign_in(client)
    response = await client.get('/api/admin/audit?action=email_test')
    assert response.status_code == 200, response.text
    emails = {row['actor']: row['actorEmail'] for row in response.json()}
    assert emails == {'admin': 'admin@example.test', 'alice': 'alice@example.test', 'operator': None, 'monitoring': None, 'historical-actor': None}
    filtered = await client.get('/api/admin/audit', params={'action': 'email_test', 'q': 'ALICE@EXAMPLE.TEST'})
    assert [row['actor'] for row in filtered.json()] == ['alice']
    assert (await client.get('/api/admin/audit', params={'q': "alice@example.test' OR true--"})).json() == []
    assert PASSWORD not in response.text and 'secret-never-returned' not in response.text


async def test_allowance_conflicts_audit_and_receipt_preservation(admin_service):
    db, client = admin_service
    await add_call(db, 'unknown', kind='tencentCalls', record={'status': 'SUBMITTING', 'quotaPages': 7, 'admissionState': 'dispatched'})
    await sign_in(client)
    result = await client.get('/api/admin/users/alice')
    assert result.status_code == 200, result.text
    assert result.json()['balance']['remainingPages'] == 43 and result.json()['unknownPages'] == 7
    body = {'currentPassword': PASSWORD, 'expectedFreePages': 50, 'freePages': 75, 'reason': 'Confirmed platform fault'}
    changed = await client.post('/api/admin/users/alice/allowance', json=body)
    assert changed.status_code == 200, changed.text
    assert changed.json()['balance']['remainingPages'] == 68
    assert (await client.post('/api/admin/users/alice/allowance', json=body)).status_code == 409
    for change, status in [({'reason': '   '}, 422), ({'currentPassword': 'wrong'}, 403), ({'freePages': -1}, 422)]:
        assert (await client.post('/api/admin/users/alice/allowance', json={**body, **change})).status_code == status
    receipt = (await db.rows("SELECT record FROM auth_calls WHERE call_key='unknown'"))[0]['record']
    assert receipt['quotaPages'] == 7
    audit = (await client.get('/api/admin/audit?target=alice&action=allowance_update')).json()
    assert audit[0]['detail']['before']['freePages'] == 50 and audit[0]['detail']['after']['freePages'] == 75
    assert PASSWORD not in json.dumps(audit) and 'secret-never-returned' not in changed.text
    policy = {'currentPassword': PASSWORD, 'enabled': True, 'role': 'user', 'limits': None}
    assert (await client.patch('/api/admin/users/alice', json=policy)).status_code == 422
    assert (await client.patch('/api/admin/users/alice', json={**policy, 'reason': 'Reset explicit allowance override'})).status_code == 200
    assert (await client.get('/api/admin/users/missing')).status_code == 404
    assert (await client.post('/api/admin/users/missing/allowance', json=body)).status_code == 404


async def test_search_and_usage_totals_cover_all_matching_records(admin_service):
    db, client = admin_service
    await add_call(db, 'one')
    await add_call(db, 'two', user='bob')
    await add_call(db, 'unknown', record={'status': 'failed', 'error': 'MODEL_RESULT_UNKNOWN', 'usageStatus': 'unknown', 'inputTokens': None, 'outputTokens': None, 'modelId': 'other-model'})
    await add_call(db, 'failed', record={'status': 'failed', 'error': 'INVALID_OUTPUT', 'usageStatus': 'known', 'inputTokens': 7, 'outputTokens': 2, 'modelId': 'test-model'})
    await sign_in(client)
    assert [row['id'] for row in (await client.get('/api/admin/users?q=ALICE&role=user&enabled=true')).json()] == ['alice']
    assert (await client.get('/api/admin/users?q=%25')).json() == []
    result = await client.get('/api/admin/usage/summary?userId=alice')
    assert result.status_code == 200, result.text
    totals = result.json()['totals']
    assert totals['calls'] == 3 and totals['unknownCalls'] == totals['failedCalls'] == 1
    assert totals['inputTokens'] == 12 and totals['unknownTokenCalls'] == 1
    assert len(result.json()['items']) == 2
    assert [r['call_key'] for r in (await client.get('/api/admin/calls?state=unknown&userId=alice')).json()] == ['unknown']
    assert len((await client.get('/api/admin/usage?provider=test-model&kind=modelCalls')).json()) == 3
    assert (await client.get('/api/admin/calls?q=missing')).json() == []
    assert (await client.get('/api/admin/calls?state=invalid')).status_code == 422
    assert (await client.get('/api/admin/usage/summary?since=2026-11-10T00:00:00Z')).json()['totals']['calls'] == 0
    assert (await client.get('/api/admin/usage/summary?until=2020-01-01T00:00:00Z')).json()['items'] == []
    assert (await client.get('/api/admin/audit?actor=admin&q=usage')).json()
    assert (await client.get('/api/admin/audit?userId=alice&action=missing')).json() == []
    for url in ['/api/admin/users?since=2026-11-10T00:00:00Z&until=2026-11-09T00:00:00Z', '/api/admin/calls?since=2026-11-09T00:00:00', '/api/admin/users?offset=-1', '/api/admin/users?q=' + 'a' * 255]:
        assert (await client.get(url)).status_code == 422
    assert (await client.get("/api/admin/users?q=' OR true --")).json() == []


async def test_targeted_credential_revocation_is_scoped_and_immediate(admin_service):
    _, client = admin_service
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url='http://test') as alice:
        await sign_in(alice, 'alice@example.test')
        raw = alice.cookies.get(identity.COOKIE)
        assert raw is not None
        raw_token = (await alice.post('/api/me/tokens', json={'currentPassword': PASSWORD, 'name': 'isolated grading'})).json()['token']
        await sign_in(client)
        sessions = (await client.get('/api/admin/users/alice/sessions')).json()
        tokens = (await client.get('/api/admin/users/alice/tokens')).json()
        assert len(sessions) == len(tokens) == 1
        assert raw not in json.dumps(sessions) and identity.digest(raw) not in json.dumps(sessions)
        assert raw_token not in json.dumps(tokens)
        body = {'currentPassword': PASSWORD, 'reason': 'Lost device'}
        target = '/api/admin/users/alice/sessions/' + sessions[0]['id']
        assert (await client.request('DELETE', target, json=body, headers={'X-CSRF-Token': 'wrong'})).status_code == 403
        assert (await client.request('DELETE', target, json={**body, 'currentPassword': 'wrong'})).status_code == 403
        assert (await client.request('DELETE', target.replace('/alice/', '/bob/'), json=body)).status_code == 404
        assert (await client.request('DELETE', target, json=body)).status_code == 200
        assert (await alice.get('/api/me/usage')).status_code == 401
        assert (await client.request('DELETE', '/api/admin/users/alice/tokens/' + tokens[0]['id'], json=body)).status_code == 200
        assert (await client.get('/api/maintenance', headers={'Authorization': 'Bearer ' + raw_token})).status_code == 401
        assert (await client.request('DELETE', '/api/admin/users/alice/sessions', json=body)).status_code == 200
        assert (await client.get('/api/admin/users/admin/sessions')).json()


async def test_administration_routes_deny_anonymous_users_and_grading_tokens(admin_service):
    _, client = admin_service
    urls = ['/api/admin/users/alice', '/api/admin/users/alice/sessions', '/api/admin/users/alice/tokens', '/api/admin/calls', '/api/admin/usage/summary', '/api/admin/task-search', '/api/admin/operations']
    for path in urls:
        assert (await client.get(path)).status_code == 401
    await sign_in(client, 'alice@example.test')
    token = (await client.post('/api/me/tokens', json={'currentPassword': PASSWORD, 'name': 'App'})).json()['token']
    for path in urls:
        assert (await client.get(path)).status_code == 403
        assert (await client.get(path, headers={'Authorization': 'Bearer ' + token})).status_code == 401


async def test_task_search_owner_date_and_issue_boundaries(admin_service, monkeypatch):
    db, client = admin_service
    ids = [str(uuid4()), str(uuid4())]
    async with db.transaction() as conn:
        for task, owner in zip(ids, ['alice', 'bob'], strict=True):
            await conn.execute("INSERT INTO document_tasks(thread_id,request_hash,graph_id,document,failure_policy,expires_at,owner_id) VALUES(%s,'x','document_parser',%s,'return_partial',now()+interval '1 day',%s)", (task, Jsonb({'fileName': owner + '.txt', 'sourceType': 'text'}), owner))
    async def summaries(service, rows):
        for row in rows:
            yield {'threadId': row['thread_id'], 'fileName': row['document']['fileName'], 'createdAt': row['created_at'].isoformat(), 'expiresAt': row['expires_at'].isoformat(), 'state': 'PAUSED', 'status': None, 'checkpointId': None, 'questionCount': 0, 'reviewCount': 0}
    monkeypatch.setattr(task_api, '_task_summaries', summaries)
    await sign_in(client)
    result = await client.get('/api/admin/task-search?userId=alice&q=alice&state=paused')
    assert result.status_code == 200, result.text
    assert [row['threadId'] for row in result.json()['items']] == [ids[0]]
    assert result.json()['items'][0]['ownerEmail'] == 'alice@example.test'
    assert len((await client.get('/api/admin/task-search')).json()['items']) == 2
    for issue in ['unknown', 'stalled']:
        assert (await client.get('/api/admin/task-search?issue=' + issue)).json()['items'] == []
    assert (await client.get('/api/admin/task-search?state=invalid')).status_code == 422
    assert (await client.get('/api/admin/task-search?issue=refund')).status_code == 422
    assert (await client.get('/api/admin/task-search?since=2100-01-01T00:00:00Z&until=2101-01-01T00:00:00Z')).json()['items'] == []
    assert (await db.rows('SELECT count(*) AS n FROM auth_calls'))[0]['n'] == 0


def monitoring_payload(**changes):
    now = datetime.now(UTC)
    return {'version': 1, 'observedAt': now.isoformat(), 'backupLastSuccessAt': (now-timedelta(minutes=2)).isoformat(), 'backupLastAttemptSuccess': True, 'alertState': 'healthy', 'alertDeliveryVerifiedAt': None, **changes}


async def test_operations_are_passive_and_never_expose_secrets(admin_service, monkeypatch, tmp_path):
    db, client = admin_service
    await sign_in(client)
    response = await client.get('/api/admin/operations')
    assert response.status_code == 200, response.text
    assert response.json()['monitoringState'] == 'not_configured' and response.json()['broker']['publisher']
    assert response.json()['schemaVersion'] == 8 and 'secret-never-returned' not in response.text and PASSWORD not in response.text
    path = tmp_path / 'status.json'
    path.write_text(json.dumps(monitoring_payload()))
    monkeypatch.setenv('AI_OPERATIONS_STATUS_FILE', str(path))
    assert (await client.get('/api/admin/operations')).json()['monitoringState'] == 'current'
    assert (await db.rows('SELECT count(*) AS n FROM auth_calls'))[0]['n'] == 0
    assert (await db.rows('SELECT count(*) AS n FROM document_runs'))[0]['n'] == 0
    monkeypatch.setenv('AI_READ_ONLY', '1')
    assert (await client.post('/api/admin/users/alice/allowance', json={'currentPassword': PASSWORD, 'expectedFreePages': 50, 'freePages': 99, 'reason': 'Read-only refusal'})).status_code == 409


@pytest.mark.parametrize('change,expected', [({}, 'current'), ({'observedAt': '2000-01-01T00:00:00Z', 'backupLastSuccessAt': None}, 'stale'), ({'version': 2}, 'unavailable'), ({'secret': 'private'}, 'unavailable'), ({'observedAt': '2099-01-01T00:00:00Z'}, 'unavailable'), ({'observedAt': '2026-11-09T00:00:00'}, 'unavailable'), ({'backupLastSuccessAt': '2099-01-01T00:00:00Z'}, 'unavailable')])
def test_monitoring_status_is_bounded_validated_and_fresh(tmp_path, change, expected):
    path = tmp_path / 'status.json'
    path.write_text(json.dumps(monitoring_payload(**change)))
    assert admin_api.read_monitoring(path)[0] == expected
    assert admin_api.read_monitoring(None) == ('not_configured', None)
    assert admin_api.read_monitoring(tmp_path / 'missing') == ('unavailable', None)
    for payload in [b'x' * 16_385, b'{']:
        path.write_bytes(payload)
        assert admin_api.read_monitoring(path) == ('unavailable', None)


def test_monitoring_config_requires_a_trusted_absolute_path(monkeypatch):
    monkeypatch.setenv('AI_OPERATIONS_STATUS_FILE', 'relative-status.json')
    with pytest.raises(ValueError, match='absolute'):
        load()
    with pytest.raises(ValueError):
        AdministrationFilter.model_validate({'since': '2026-11-09T00:00:00'})


async def test_payment_filters_and_frozen_refunds_do_not_contact_providers(admin_service):
    from practiq_ai.billing import PRODUCTS
    db, client = admin_service
    products = PRODUCTS[1].model_dump(mode='json')
    ids = ['a'*32, 'b'*32, 'c'*32]
    async with db.transaction() as conn:
        for order_id, owner, environment, state in [(ids[0], 'alice', 'production', 'PAID'), (ids[1], 'bob', 'sandbox', 'UNKNOWN'), (ids[2], 'alice', 'production', 'PENDING_PAYMENT')]:
            await conn.execute('INSERT INTO payment_orders(id,owner_id,request_id,environment,app_id,seller_id,amount,subject,return_url,state,product) VALUES(%s,%s,%s,%s,\'test-app\',\'test-seller\',3900,\'Plus\',\'http://127.0.0.1/return\',%s,%s)', (order_id, owner, str(uuid4()), environment, state, Jsonb(products)))
        await conn.execute("INSERT INTO page_grants(order_id,owner_id,product,expires_at,state) VALUES(%s,'alice',%s,now()+interval '30 days','refund_pending')", (ids[0], Jsonb(products)))
    await sign_in(client)
    for suffix, expected in [('userId=alice', [ids[0], ids[2]]), ('q=bob&environment=sandbox&state=UNKNOWN', [ids[1]]), ('issue=refund', [ids[0]]), ('issue=unknown', [ids[1]]), ('since=2100-01-01T00:00:00Z', []), ('until=2000-01-01T00:00:00Z', [])]:
        response = await client.get('/api/admin/payments?' + suffix)
        assert response.status_code == 200, response.text
        assert [row['id'] for row in response.json()] == expected
    assert (await client.get('/api/admin/payments?state=invalid')).status_code == 422
    assert (await db.rows('SELECT count(*) AS n FROM payment_refunds'))[0]['n'] == 0


@pytest.mark.parametrize('blocking', ['FREE_PAGE_QUOTA_EXCEEDED', {'reviewFailures': [{'code': 'MODEL_BUDGET_EXCEEDED'}]}, 'COST_BUDGET_EXCEEDED'])
async def test_anomaly_queries_preserve_current_runs_and_show_blocked_tasks(admin_service, monkeypatch, blocking):
    from practiq_ai.errors import DocumentProcessingError
    db, client = admin_service
    ids = [str(uuid4()), str(uuid4()), str(uuid4())]
    async with db.transaction() as conn:
        for index, task in enumerate(ids):
            await conn.execute("INSERT INTO document_tasks(thread_id,request_hash,graph_id,document,failure_policy,expires_at,owner_id) VALUES(%s,'x','document_parser',%s,'return_partial',now()+interval '1 day','alice')", (task, Jsonb({'sourceType': 'text', 'fileName': str(index)+'.txt'})))
        await conn.execute("INSERT INTO document_runs(run_id,thread_id,request_id,context,status,created_at) VALUES(%s,%s,%s,'{}','pending',now()-interval '31 minutes')", (str(uuid4()), ids[2], str(uuid4())))
    await add_call(db, 'unknown-task', scope='task:'+ids[0], record={'status': 'started', 'usageStatus': 'unknown'})
    await add_call(db, 'active-task', scope='task:'+ids[2], record={'status': 'started', 'usageStatus': 'unknown'})
    async def summaries(service, rows):
        for row in rows:
            yield {'threadId': row['thread_id'], 'fileName': row['document']['fileName'], 'createdAt': row['created_at'].isoformat(), 'expiresAt': row['expires_at'].isoformat(), 'state': 'PAUSED', 'status': None, 'checkpointId': None, 'questionCount': 0, 'reviewCount': 0}
    async def detail(task):
        if task == ids[1]:
            raise DocumentProcessingError(404, 'Artifact unavailable', 'OBJECT_NOT_FOUND')
        return SimpleNamespace(blocking=[blocking] if task == ids[0] else [])
    monkeypatch.setattr(task_api, '_task_summaries', summaries)
    monkeypatch.setattr(task_api, 'get_task_model', detail)
    await sign_in(client)
    for issue, expected in [('unknown', {ids[0]}), ('stalled', {ids[2]}), ('quota', {ids[0]}), ('blocked', {ids[0], ids[1]})]:
        response = await client.get('/api/admin/task-search?issue='+issue)
        assert response.status_code == 200, response.text
        assert {row['threadId'] for row in response.json()['items']} == expected
    calls = (await client.get('/api/admin/calls')).json()
    assert {row['call_key']: row['state'] for row in calls} == {'unknown-task': 'unknown', 'active-task': 'pending'}
    actor = identity.actor.set({'id': 'alice', 'role': 'user'})
    try:
        with pytest.raises(DocumentProcessingError, match='Administrator'):
            await task_api.list_tasks(admin_filter=AdministrationFilter())
    finally:
        identity.actor.reset(actor)


async def test_tencent_usage_joins_only_the_matching_task_receipt(admin_service):
    db, client = admin_service
    task = str(uuid4())
    await add_call(db, 'tencent-one', kind='tencentCalls', scope='task:'+task, record={'status': 'SUBMITTING', 'taskId': 'provider-one', 'quotaPages': 3})
    await db.store.aput(('document_tasks', task, 'tencent_jobs'), 'job', {'taskId': 'provider-one', 'status': 'Failed'})
    await db.store.aput(('document_tasks', str(uuid4()), 'tencent_jobs'), 'job', {'taskId': 'provider-one', 'status': 'Success'})
    await sign_in(client)
    result = await client.get('/api/admin/calls?kind=tencentCalls')
    assert result.status_code == 200, result.text
    assert result.json()[0]['status'] == 'Failed' and result.json()[0]['state'] == 'failed'
    assert (await client.get('/api/admin/users/alice')).json()['heldPages'] == 3
    # Receipt metadata is read, never rewritten or resubmitted by administrator queries.
    saved = await db.store.aget(('document_tasks', task, 'tencent_jobs'), 'job')
    assert saved is not None and saved.value['status'] == 'Failed'


async def test_exhausted_user_search_and_related_audit_preserve_ownership(admin_service):
    db, client = admin_service
    await add_call(db, 'exhausted', kind='tencentCalls', record={'status': 'Success', 'quotaPages': 50})
    task = str(uuid4())
    async with db.transaction() as conn:
        await conn.execute("INSERT INTO document_tasks(thread_id,request_hash,graph_id,document,failure_policy,expires_at,owner_id) VALUES(%s,'x','document_parser','{}','return_partial',now()+interval '1 day','alice')", (task,))
        await conn.execute("INSERT INTO auth_audit(actor,action,target) VALUES('alice','profile_update','alice'),('admin','task_action',%s),('bob','profile_update','bob')", (task,))
        await conn.execute("INSERT INTO auth_audit(actor,action,target) VALUES('admin','admin_request',%s)", ('/api/admin/document-tasks/'+task+'/control',))
    await sign_in(client)
    result = await client.get('/api/admin/users?issue=quota')
    assert result.status_code == 200, result.text
    assert [row['id'] for row in result.json()] == ['alice']
    events = (await client.get('/api/admin/audit?userId=alice')).json()
    assert {event['action'] for event in events} == {'profile_update', 'task_action', 'admin_request'}
    assert all(event['actor'] != 'bob' for event in events)
    assert (await client.get('/api/admin/users?issue=refund')).status_code == 422
    assert (await client.get('/api/admin/payments?issue=quota')).status_code == 422
    body = {'currentPassword': PASSWORD, 'expectedFreePages': 50, 'freePages': '75', 'reason': 'Strict input boundary'}
    assert (await client.post('/api/admin/users/alice/allowance', json=body)).status_code == 422
    response = await client.request('DELETE', '/api/admin/users/alice/sessions', content=b'x'*(1024*1024+1), headers={'Content-Type': 'application/json'})
    assert response.status_code == 413


def test_monitoring_does_not_follow_links_or_block_on_fifo(tmp_path):
    import os
    target = tmp_path / 'target.json'
    target.write_text(json.dumps(monitoring_payload()))
    link = tmp_path / 'linked.json'
    link.symlink_to(target)
    assert admin_api.read_monitoring(link) == ('unavailable', None)
    assert admin_api.read_monitoring(tmp_path) == ('unavailable', None)
    fifo = tmp_path / 'fifo'
    os.mkfifo(fifo)
    assert admin_api.read_monitoring(fifo) == ('unavailable', None)


async def test_rejected_tencent_submission_uses_exact_durable_identity(admin_service):
    db, client = admin_service
    task = str(uuid4())
    source = 'a' * 64
    key = hashlib.sha256(f'{task}/rejected/{source}'.encode()).hexdigest()
    unknown = hashlib.sha256(f'{task}/uncertain/{source}'.encode()).hexdigest()
    for call_key in [key, unknown]:
        await add_call(db, call_key, kind='tencentCalls', scope='task:'+task,
                       record={'status': 'SUBMITTING', 'sourceSha256': source, 'quotaPages': 3})
    await db.store.aput(('document_tasks', task, 'tencent_jobs'), 'rejected', {'sourceSha256': source, 'status': 'REJECTED'})
    await db.store.aput(('document_tasks', str(uuid4()), 'tencent_jobs'), 'uncertain', {'sourceSha256': source, 'status': 'Success'})
    await sign_in(client)
    response = await client.get('/api/admin/calls?kind=tencentCalls')
    assert response.status_code == 200, response.text
    assert {row['call_key']: row['state'] for row in response.json()} == {key: 'failed', unknown: 'unknown'}
    totals = (await client.get('/api/admin/usage/summary')).json()['totals']
    assert totals['failedCalls'] == totals['unknownCalls'] == 1
    detail = (await client.get('/api/admin/users/alice')).json()
    assert detail['heldPages'] == 6 and detail['unknownPages'] == 3
    assert all(row['record']['status'] == 'SUBMITTING' for row in await db.rows('SELECT record FROM auth_calls'))


@pytest.mark.parametrize('cancel', [False, True])
async def test_active_grading_is_pending_until_completion_or_cancellation(admin_service, monkeypatch, cancel):
    db, client = admin_service
    monkeypatch.setenv('DATABASE_URI', db.uri)
    started, release = asyncio.Event(), asyncio.Event()
    calls = 0
    async def model(*args, **kwargs):
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()
        return None, [], 'AI_PROVIDER_TIMEOUT'
    monkeypatch.setattr(grading, 'get_model', lambda: None)
    monkeypatch.setattr(grading, 'structured_call', model)
    request = grading.GradeRequest.model_validate({
        'requestId': str(uuid4()), 'inputDigest': 'a'*64, 'maxCents': 500,
        'question': {'stem': 'Explain evaporation', 'answerMode': 'short_answer',
                     'questionTypeId': 'short answer', 'answerPayload': {'text': 'Liquid turns to gas'}},
        'answer': 'Liquid turns to gas',
    })
    await add_call(db, 'live-grade', scope=f'grade:{request.requestId}', record={'status': 'started', 'usageStatus': 'unknown'})
    await sign_in(client)
    async def state():
        response = await client.get('/api/admin/calls?q=live-grade')
        assert response.status_code == 200, response.text
        return response.json()[0]['state']
    assert await state() == 'unknown'
    operation = asyncio.create_task(grading.grade(request))
    try:
        await asyncio.wait_for(started.wait(), timeout=5)
        assert await state() == 'pending'
        assert (await grading.grade(request))['status'] == 'unknown'
        assert await state() == 'pending' and calls == 1
        if cancel:
            operation.cancel()
            with pytest.raises(asyncio.CancelledError):
                await operation
        else:
            release.set()
            assert (await operation)['status'] == 'unknown'
        assert await state() == 'unknown'
        assert (await client.get('/api/admin/usage/summary')).json()['totals']['unknownCalls'] == 1
        assert (await grading.grade(request))['status'] == 'unknown' and calls == 1
    finally:
        operation.cancel()
        await asyncio.gather(operation, return_exceptions=True)
