"""Account security integration against disposable PostgreSQL; no model calls."""
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest

from practiq_ai import identity, runtime, webapp
from practiq_ai.import_control import ImportControl
from tests.db_support import new_database

PASSWORD = 'a-long-test-password'


@pytest.fixture
async def accounts(disposable_databases, monkeypatch):
    database = await new_database()
    monkeypatch.setattr(runtime, 'current', SimpleNamespace(db=database, accepting=True, import_control=ImportControl()))
    encoded = await identity.password_hash(PASSWORD)
    async with database.transaction() as conn:
        await conn.execute("INSERT INTO auth_users(id,email,password_hash,role) VALUES('admin','admin@example.test',%s,'admin')", (encoded,))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url='http://test') as client:
        yield database, client


async def login(client, email='admin@example.test', register=False):
    session = (await client.get('/api/auth/session')).json()
    response = await client.post('/api/auth/register' if register else '/api/auth/login', json={'email': email, 'password': PASSWORD}, headers={'X-CSRF-Token': session['csrf']})
    assert response.status_code == 200, response.text
    client.headers['X-CSRF-Token'] = response.json()['csrf']
    return response.json()


async def test_account_lifecycle_csrf_and_role_boundary(accounts):
    database, client = accounts
    assert (await client.get('/api/document-tasks')).status_code == 401
    assert (await client.post('/api/auth/login', json={'email': 'admin@example.test', 'password': PASSWORD})).status_code == 403
    value = await login(client, 'first@example.test', register=True)
    assert value['user']['role'] == 'user'
    assert (await client.get('/api/admin/users')).status_code == 403
    assert (await client.get('/api/document-tasks/' + str(uuid4()))).status_code == 404
    cookie = client.cookies.get(identity.COOKIE)
    stored = await database.rows('SELECT digest FROM auth_sessions')
    assert stored and all(row['digest'] != cookie for row in stored)
    invalid = await client.patch('/api/me/profile', json={'currentPassword': PASSWORD, 'password': 'too-short'})
    assert invalid.status_code == 422 and 'too-short' not in invalid.text and PASSWORD not in invalid.text
    assert (await client.post('/api/auth/logout')).status_code == 200
    assert (await client.get('/api/me/usage')).status_code == 401


async def test_admin_reset_single_use_and_last_admin(accounts):
    _, client = accounts
    await login(client)
    update = {'currentPassword': PASSWORD, 'enabled': False, 'role': 'user', 'limits': None}
    assert (await client.patch('/api/admin/users/admin', json=update)).status_code == 409
    result = await client.post('/api/admin/users/admin/reset-link', json={'currentPassword': PASSWORD})
    assert result.status_code == 200
    token = result.json()['path'].split('#')[1]
    assert (await client.get('/reset-password')).status_code in {200, 404}
    response = await client.post('/api/auth/reset-password', json={'token': token, 'password': 'a-new-long-password'})
    assert response.status_code == 200
    assert (await client.get('/api/admin/users')).status_code == 401
    # Refresh anonymous CSRF before testing reuse.
    csrf = (await client.get('/api/auth/session')).json()['csrf']
    assert (await client.post('/api/auth/reset-password', json={'token': token, 'password': 'another-long-password'}, headers={'X-CSRF-Token': csrf})).status_code == 400


async def test_personal_token_scope_and_disable_revocation(accounts):
    _, client = accounts
    user = (await login(client, 'token@example.test', register=True))['user']
    created = await client.post('/api/me/tokens', json={'currentPassword': PASSWORD, 'name': 'App'})
    raw = created.json()['token']
    assert raw.startswith('pq_grade_')
    assert raw not in (await client.get('/api/me/tokens')).text
    assert (await client.get('/api/document-tasks', headers={'Authorization': 'Bearer ' + raw})).status_code == 401
    assert (await client.get('/api/maintenance', headers={'Authorization': 'Bearer ' + raw})).status_code == 200
    await login(client)
    response = await client.patch('/api/admin/users/' + user['id'], json={'currentPassword': PASSWORD, 'enabled': False, 'role': 'user', 'limits': None})
    assert response.status_code == 200
    assert (await client.get('/api/maintenance', headers={'Authorization': 'Bearer ' + raw})).status_code == 401


async def test_cross_user_source_proof_and_quota_atomicity(accounts):
    import asyncio

    from practiq_ai.errors import DocumentProcessingError
    database, client = accounts
    user = (await login(client, 'one@example.test', register=True))['user']
    task = str(uuid4())
    async with database.transaction() as conn:
        await conn.execute("INSERT INTO document_tasks(thread_id,request_hash,graph_id,document,failure_policy,expires_at,owner_id) VALUES(%s,'x','document_parser','{}','return_partial',now()+interval '1 day',%s)", (task, user['id']))
        await conn.execute("UPDATE auth_users SET limits='{" + '"modelCalls":1' + "}' WHERE id=%s", (user['id'],))
    async def reserve(key):
        try:
            await identity.reserve('task:' + task, key, 'modelCalls', {'status': 'started', 'usageStatus': 'unknown'})
            return True
        except DocumentProcessingError:
            return False
    assert sum(await asyncio.gather(reserve('first'), reserve('second'))) == 1
    await identity.reserve('task:' + task, 'first' if (await database.rows('SELECT call_key FROM auth_calls'))[0]['call_key'] == 'first' else 'second', 'modelCalls', {})
    await login(client, 'two@example.test', register=True)
    assert (await client.get('/api/document-tasks/' + task)).status_code == 404
    for suffix in ('/head', '/preview', '/export', '/corrections'):
        assert (await client.get('/api/document-tasks/' + task + suffix)).status_code == 404
    assert (await client.post('/api/artifacts/read?thread_id=' + task, json={})).status_code == 404
    body = {'requestId': str(uuid4()), 'document': {'objectKey': 'practiq-agent/sources/' + 'a'*64 + '/source.txt', 'sha256': 'a'*64, 'sizeBytes': 4, 'sourceType': 'text', 'mediaType': 'text/plain', 'fileName': 'x.txt'}}
    assert (await client.post('/api/document-tasks', json=body)).status_code == 404


async def test_preferences_global_settings_and_session_controls(accounts):
    database, client = accounts
    user = (await login(client, 'prefs@example.test', register=True))['user']
    initial = (await client.get('/api/import-settings')).json()
    changed = {**initial, 'settings': {**initial['settings'], 'generateAnswers': True}}
    saved = await client.put('/api/import-settings', json=changed)
    assert saved.status_code == 200 and saved.json()['settings']['generateAnswers'] is True
    assert (await client.put('/api/import-settings', json=changed)).status_code == 409
    forbidden = {**saved.json(), 'settings': {**saved.json()['settings'], 'tencentConcurrency': 1}}
    assert (await client.put('/api/import-settings', json=forbidden)).status_code == 403
    await login(client, 'other-prefs@example.test', register=True)
    assert (await client.get('/api/import-settings')).json()['settings']['generateAnswers'] is False
    await login(client)
    assert (await client.get('/api/admin/users')).status_code == 200
    setting = (await client.get('/api/admin/settings')).json()
    assert (await client.put('/api/admin/settings', json={**setting, 'registrationEnabled': False})).status_code == 200
    assert (await client.get('/api/admin/import-settings')).status_code == 200
    assert (await client.get('/api/admin/audit')).status_code == 200
    assert (await client.get('/api/admin/usage')).status_code == 200
    assert (await client.get('/api/me/usage')).status_code == 200
    sessions = (await client.get('/api/me/sessions')).json()
    assert sessions and 'digest' not in sessions[0]
    assert (await client.delete('/api/me/sessions/' + sessions[0]['id'])).status_code == 200
    assert (await client.get('/api/admin/users')).status_code == 401
    assert (await database.rows('SELECT preferences FROM auth_users WHERE id=%s', (user['id'],)))[0]['preferences']['generateAnswers'] is True


async def test_all_business_routes_deny_anonymous_and_foreign_mutations(accounts):
    _, client = accounts
    for method, path in [('GET','/api/import-capabilities'), ('GET','/api/maintenance'), ('GET','/api/metrics'), ('GET','/api/me/banks'), ('POST','/api/uploads'), ('PUT','/api/uploads/content'), ('POST','/api/subjective-grades'), ('POST','/api/artifacts/read'), ('GET','/api/admin/audit')]:
        response = await client.request(method, path, json={} if method != 'GET' else None)
        assert response.status_code == 401, (method, path, response.text)
    await login(client, 'foreign@example.test', register=True)
    thread = str(uuid4())
    for method, suffix in [('DELETE',''), ('PUT','/corrections'), ('POST','/control'), ('POST','/reparse')]:
        assert (await client.request(method, '/api/document-tasks/' + thread + suffix, json={})).status_code == 404
    assert (await client.get('/api/document-tasks/' + thread + '/answer-matches?answer_task_id=' + str(uuid4()) + '&checkpoint_id=x')).status_code == 404


async def test_email_change_revokes_sessions_and_tokens_without_verifying_identity(accounts):
    _, client = accounts
    await login(client, 'before@example.test', register=True)
    token = (await client.post('/api/me/tokens', json={'currentPassword': PASSWORD, 'name': 'App'})).json()['token']
    response = await client.patch('/api/me/profile', json={'currentPassword': PASSWORD, 'email': 'after@example.test', 'name': 'Changed'})
    assert response.status_code == 200
    assert (await client.get('/api/me/sessions')).status_code == 401
    assert (await client.get('/api/maintenance', headers={'Authorization': 'Bearer ' + token})).status_code == 401
    assert (await login(client, 'after@example.test'))['user']['name'] == 'Changed'


async def test_tenant_admission_rejects_disabled_legacy_and_overlapping_tasks(accounts):
    from practiq_ai.errors import DocumentProcessingError
    database, client = accounts
    user = (await login(client, 'limited@example.test', register=True))['user']
    task = str(uuid4())
    async with database.transaction() as conn:
        await conn.execute("INSERT INTO document_tasks(thread_id,request_hash,graph_id,document,failure_policy,expires_at,owner_id) VALUES(%s,'x','document_parser','{}','return_partial',now()+interval '1 day',%s)", (task,user['id']))
        await conn.execute("UPDATE auth_users SET limits='{" + '"activeTasks":1' + "}' WHERE id=%s", (user['id'],))
        await conn.execute("INSERT INTO document_runs(run_id,thread_id,request_id,context) VALUES(%s,%s,'first','{}')", (str(uuid4()),task))
    async with database.transaction() as conn:
        with pytest.raises(DocumentProcessingError, match='concurrency'):
            await identity.admit(conn, {'owner_id':user['id']})
    await identity.reserve('task:' + task, 'retained-unknown', 'tencentCalls', {'status':'SUBMITTING'})
    async with database.transaction() as conn:
        await conn.execute('UPDATE auth_users SET enabled=false WHERE id=%s', (user['id'],))
    with pytest.raises(DocumentProcessingError, match='disabled'):
        await identity.reserve('task:' + task, 'blocked-call', 'modelCalls', {})
    with pytest.raises(DocumentProcessingError, match='owner'):
        await identity.reserve('task:historical-unmapped', 'legacy-call', 'modelCalls', {})
    assert (await database.rows('SELECT record FROM auth_calls WHERE call_key=%s', ('retained-unknown',)))[0]['record']['status'] == 'SUBMITTING'


async def test_upgrade_requires_a_verified_backup_before_any_mutation(accounts, monkeypatch, tmp_path):
    from practiq_ai import manage
    database, _ = accounts
    monkeypatch.setenv('DATABASE_URI', database.uri)
    with pytest.raises(ValueError, match='backup-bundle'):
        await manage.run('upgrade-db')
    with pytest.raises(ValueError, match='manifest'):
        await manage.run('upgrade-db', backup_bundle=tmp_path)
    assert await database.rows('SELECT version FROM practiq_schema') == [{'version': 6}]


async def test_offline_schema_five_upgrade_preserves_unowned_work(accounts):
    from tests.db_support import strip_identity_schema
    database, _ = accounts
    await strip_identity_schema(database)
    async with database.transaction() as conn:
        await conn.execute('UPDATE practiq_schema SET version=5')
        await conn.execute("INSERT INTO document_tasks(thread_id,request_hash,graph_id,document,failure_policy,expires_at) VALUES('historical','retained','document_parser','{}','return_partial',now()+interval '1 day')")
    await database.upgrade()
    await database.check_schema()
    assert await database.rows('SELECT thread_id,request_hash,owner_id FROM document_tasks') == [{'thread_id':'historical','request_hash':'retained','owner_id':None}]
    assert not await database.rows('SELECT * FROM auth_users')


async def test_https_session_cookie_has_host_only_security_flags(accounts):
    _, original = accounts
    async with httpx.AsyncClient(transport=original._transport, base_url='https://test') as client:
        snapshot = (await client.get('/api/auth/session')).json()
        response = await client.post('/api/auth/login', json={'email':'admin@example.test','password':PASSWORD}, headers={'X-CSRF-Token':snapshot['csrf']})
        assert response.status_code == 200
        cookie = response.headers['set-cookie']
        for flag in ('__Host-practiq_session=', 'HttpOnly', 'Secure', 'SameSite=lax', 'Path=/'):
            assert flag in cookie
        assert 'Domain=' not in cookie


async def test_daily_quota_uses_singapore_boundary_and_retains_unknown_receipts(accounts, monkeypatch):
    from datetime import UTC, timedelta
    from datetime import datetime as RealDateTime

    from practiq_ai.errors import DocumentProcessingError
    database, client = accounts
    user = (await login(client,'daily@example.test',register=True))['user']
    task = str(uuid4())
    async with database.transaction() as conn:
        await conn.execute("INSERT INTO document_tasks(thread_id,request_hash,graph_id,document,failure_policy,expires_at,owner_id) VALUES(%s,'x','document_parser','{}','return_partial',now()+interval '1 day',%s)", (task,user['id']))
        await conn.execute("UPDATE auth_users SET limits='{" + '"modelCalls":1' + "}' WHERE id=%s", (user['id'],))
    now = RealDateTime(2026,11,6,15,59,59,tzinfo=UTC)
    class Clock(RealDateTime):
        @classmethod
        def now(cls, tz=None):
            return now.astimezone(tz)
    monkeypatch.setattr(identity,'datetime',Clock)
    await identity.reserve('task:'+task,'before-midnight','modelCalls',{'usageStatus':'unknown'})
    with pytest.raises(DocumentProcessingError,match='limit'):
        await identity.reserve('task:'+task,'over-limit','modelCalls',{})
    now += timedelta(seconds=1)
    await identity.reserve('task:'+task,'after-midnight','modelCalls',{'usageStatus':'unknown'})
    rows = await database.rows('SELECT day,record FROM auth_calls ORDER BY created_at')
    assert [str(r['day']) for r in rows] == ['2026-11-06','2026-11-07']
    assert all(r['record']['usageStatus']=='unknown' for r in rows)


@pytest.mark.parametrize('global_rejection',[False,True])
async def test_account_admission_precedes_cost_and_releases_only_unsent_reservations(accounts,monkeypatch,global_rejection):
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock

    from langchain_core.messages import HumanMessage
    from pydantic import BaseModel

    from practiq_ai import cost_budget, llm
    from practiq_ai.errors import DocumentProcessingError
    from tests.support import FakeModel
    database, client = accounts
    user = (await login(client,'cost-order@example.test',register=True))['user']
    grade_id = str(uuid4())
    async with database.transaction() as conn:
        await conn.execute('INSERT INTO grades(id,digest,owner_id) VALUES(%s,%s,%s)',(grade_id,'x',user['id']))
        if not global_rejection:
            await conn.execute("UPDATE auth_users SET limits='{"+'"modelCalls":0'+"}' WHERE id=%s",(user['id'],))
    cost = AsyncMock(side_effect=DocumentProcessingError(429,'Global budget exhausted','COST_BUDGET_EXCEEDED'))
    monkeypatch.setattr(cost_budget,'reserve',cost)
    monkeypatch.setattr(llm,'load',lambda:SimpleNamespace(cost_enabled=True,model_max_input_chars=1000,model_max_tokens=10,cost_input_per_million=1,cost_output_per_million=1))
    @asynccontextmanager
    async def slot(*args,**kwargs):
        yield
    monkeypatch.setattr(llm,'provider_slot',slot)
    class Output(BaseModel):
        value: int
    model = FakeModel(responses=[{'value':1}])
    with pytest.raises(DocumentProcessingError):
        await llm.structured_call(model,[HumanMessage(content='Test')],Output,'test',cost_scope='grade:'+grade_id)
    assert cost.await_count == int(global_rejection)
    assert not model.calls
    assert not await database.rows('SELECT * FROM auth_calls')


async def test_shared_sources_require_bytes_and_metadata_never_reveals_other_owners(accounts):
    import hashlib
    database, client = accounts
    first = (await login(client,'source-one@example.test',register=True))['user']
    payload = b'private immutable source'
    metadata = {'sourceType':'text','fileName':'private.txt','mediaType':'text/plain','sizeBytes':len(payload),'sha256':hashlib.sha256(payload).hexdigest()}
    prepared = (await client.post('/api/uploads',json=metadata)).json()
    assert prepared['upload']
    assert (await client.put(prepared['upload']['url'],content=payload)).status_code == 200
    assert (await client.post('/api/uploads',json=metadata)).json()['upload'] is None
    second = (await login(client,'source-two@example.test',register=True))['user']
    disguised = await client.post('/api/uploads',json={**metadata,'sizeBytes':len(payload)+1})
    assert disguised.status_code == 201 and disguised.json()['upload']
    assert not await database.rows('SELECT 1 FROM auth_uploads WHERE user_id=%s',(second['id'],))
    assert (await client.put(disguised.json()['upload']['url'],content=payload)).status_code == 409
    prepared = (await client.post('/api/uploads',json=metadata)).json()
    assert prepared['upload']
    assert (await client.put(prepared['upload']['url'],content=payload)).status_code == 200
    assert len(await database.rows('SELECT user_id FROM auth_uploads ORDER BY user_id')) == 2
    assert first['id'] != second['id']


async def test_malformed_csrf_is_denied_and_auth_errors_are_never_cached(accounts):
    _, client = accounts
    await client.get('/api/auth/session')
    response = await client.post('/api/auth/login',headers={b'x-csrf-token':b'\xff'},json={'email':'admin@example.test','password':PASSWORD})
    assert response.status_code == 403
    assert response.headers['Cache-Control'] == 'no-store'


async def test_fifty_lifetime_pages_are_atomic_and_survive_replay_midnight_and_deletion(accounts):
    import asyncio

    from practiq_ai.errors import DocumentProcessingError
    database, client = accounts
    user = (await login(client, 'pages@example.test', register=True))['user']
    usage = (await client.get('/api/me/usage')).json()
    assert (usage['limits']['freePages'], usage['usedPages'], usage['remainingPages']) == (50, 0, 50)
    tasks = [str(uuid4()), str(uuid4())]
    async with database.transaction() as conn:
        for task in tasks:
            await conn.execute("INSERT INTO document_tasks(thread_id,request_hash,graph_id,document,failure_policy,expires_at,owner_id) VALUES(%s,'x','document_parser','{}','return_partial',now()+interval '1 day',%s)", (task, user['id']))
    with pytest.raises(ValueError, match='positive'):
        await identity.reserve('task:' + tasks[0], 'invalid-pages', 'tencentCalls', {}, pages=0)
    receipt = {'status': 'SUBMITTING'}
    await identity.reserve('task:' + tasks[0], 'unknown-49-pages', 'tencentCalls', receipt, pages=49)
    await identity.record_call('unknown-49-pages', receipt)
    async with database.transaction() as conn:
        await conn.execute("UPDATE auth_calls SET day=day-1 WHERE call_key='unknown-49-pages'")

    async def last_page(index):
        try:
            await identity.reserve('task:' + tasks[index], f'last-page-{index}', 'tencentCalls', {}, pages=1)
            return index
        except DocumentProcessingError as exc:
            assert exc.code == 'FREE_PAGE_QUOTA_EXCEEDED'
            return None
    admitted = [index for index in await asyncio.gather(last_page(0), last_page(1)) if index is not None]
    assert len(admitted) == 1
    index = admitted[0]
    replay = {}
    await identity.reserve('task:' + tasks[index], f'last-page-{index}', 'tencentCalls', replay, pages=1)
    assert replay['quotaPages'] == 1
    assert (await client.get('/api/me/usage')).json()['remainingPages'] == 0
    await identity.release('unknown-49-pages')  # Unknown submissions cannot be refunded as unsent.
    await identity.release(f'last-page-{index}')
    with pytest.raises(DocumentProcessingError, match='quota'):
        await identity.reserve('task:' + tasks[1], 'too-large', 'tencentCalls', {}, pages=2)
    await identity.reserve('task:' + tasks[1], 'model-only', 'modelCalls', {})
    async with database.transaction() as conn:
        await conn.execute('DELETE FROM document_tasks WHERE thread_id=%s', (tasks[0],))
    usage = (await client.get('/api/me/usage')).json()
    assert (usage['usedPages'], usage['remainingPages']) == (49, 1)
    await login(client)
    settings = (await client.get('/api/admin/settings')).json()
    assert (await client.put('/api/admin/settings', json={**settings, 'freePages': 100})).status_code == 200
    assert (await database.rows('SELECT limits FROM auth_users WHERE id=%s', (user['id'],)))[0]['limits']['freePages'] == 50
    changed = await client.patch('/api/admin/users/' + user['id'], json={'currentPassword': PASSWORD, 'enabled': True, 'role': 'user', 'limits': {'freePages': 55, 'modelCalls': 1000, 'tencentCalls': 50, 'activeTasks': 2}})
    assert changed.status_code == 200
    await login(client, 'pages@example.test')
    assert (await client.get('/api/me/usage')).json()['remainingPages'] == 6


@pytest.mark.parametrize('reported', [2, None])
async def test_unknown_document_pagination_is_bounded_and_only_known_pages_are_settled(accounts, monkeypatch, reported):
    import hashlib
    from typing import Any, cast
    from unittest.mock import AsyncMock

    from langgraph.store.memory import InMemoryStore

    from practiq_ai import tencent
    from practiq_ai.contracts import DocumentReference
    from tests.support import FakeObjectStore
    database, client = accounts
    user = (await login(client, 'office-pages@example.test', register=True))['user']
    task = str(uuid4())
    async with database.transaction() as conn:
        await conn.execute("INSERT INTO document_tasks(thread_id,request_hash,graph_id,document,failure_policy,expires_at,owner_id) VALUES(%s,'x','document_parser','{}','return_partial',now()+interval '1 day',%s)", (task, user['id']))
    monkeypatch.setenv('AI_TENCENT_SECRET_ID', 'synthetic-id')
    monkeypatch.setenv('AI_TENCENT_SECRET_KEY', 'synthetic-key')
    source = b'office document substitute'
    reference = DocumentReference(sourceType='docx', mediaType='application/vnd.openxmlformats-officedocument.wordprocessingml.document', objectKey='source', sizeBytes=len(source), sha256=hashlib.sha256(source).hexdigest())
    files = FakeObjectStore({'source': source})
    monkeypatch.setattr(tencent, 'get_object_store', lambda: files)
    monkeypatch.setattr(tencent, 'guard', AsyncMock())
    monkeypatch.setattr(tencent, 'run_remaining', AsyncMock(return_value=60))
    request = AsyncMock(side_effect=[{'TaskId': 'saved-provider-job'}, {'Status': 'Success', 'ResultUrl': 'result', 'SuccessPageNum': reported, 'FailPageNum': 0}])
    monkeypatch.setattr(tencent, 'request', request)
    monkeypatch.setattr(tencent, 'download_result', AsyncMock(return_value=b'archive substitute'))
    execution = cast(Any, SimpleNamespace(store=InMemoryStore(), execution_info=SimpleNamespace(thread_id=task, run_id='run')))
    result = await tencent.parse_job(reference, execution)
    assert request.await_args_list[0].args[1]['FileEndPageNumber'] == 50
    assert result['pageLimit'] == 50
    assert await tencent.parse_job(reference, execution) == result
    assert request.await_count == 2
    usage = (await client.get('/api/me/usage')).json()
    assert usage['usedPages'] == (reported or 50)
    assert usage['remainingPages'] == 50 - (reported or 50)


@pytest.mark.parametrize(('method', 'path', 'body'), [
    ('POST', '/api/auth/login', {'email': 'admin@example.test', 'password': PASSWORD}),
    ('POST', '/api/me/tokens', {'currentPassword': PASSWORD, 'name': 'App'}),
    ('PATCH', '/api/me/profile', {'currentPassword': PASSWORD, 'name': 'stale update'}),
    ('POST', '/api/admin/users/admin/reset-link', {'currentPassword': PASSWORD}),
    ('PATCH', '/api/admin/users/admin', {'currentPassword': PASSWORD, 'enabled': True, 'role': 'admin', 'limits': None}),
])
async def test_concurrent_password_reset_fences_in_flight_credential_mutations(accounts, monkeypatch, method, path, body):
    database, client = accounts
    await login(client)
    replacement = await identity.password_hash('replacement-test-password')
    verify = identity.verify

    async def reset_after_verification(password, encoded):
        valid = await verify(password, encoded)
        async with database.transaction() as conn:
            await conn.execute("UPDATE auth_users SET password_hash=%s WHERE id='admin'", (replacement,))
            await conn.execute('DELETE FROM auth_sessions')
            await conn.execute('DELETE FROM auth_tokens')
        return valid
    monkeypatch.setattr(identity, 'verify', reset_after_verification)
    response = await client.request(method, path, json=body)
    assert response.status_code == 401, response.text
    assert not await database.rows('SELECT * FROM auth_sessions')
    assert not await database.rows('SELECT * FROM auth_tokens')
    admin = (await database.rows("SELECT * FROM auth_users WHERE id='admin'"))[0]
    assert admin['password_hash'] == replacement and admin['name'] != 'stale update'


async def test_admin_can_read_verified_historical_sources_but_cannot_mutate_them(accounts):
    import hashlib

    from psycopg.types.json import Jsonb

    from practiq_ai.contracts import DocumentUploadRequest
    from practiq_ai.storage import get_object_store
    database, client = accounts
    await login(client)
    source = b'preserved historical source'
    metadata = DocumentUploadRequest(sourceType='text', fileName='history.txt', mediaType='text/plain', sizeBytes=len(source), sha256=hashlib.sha256(source).hexdigest())
    store = get_object_store()
    reference = await store.put_document(source, metadata)
    task = str(uuid4())
    async with database.transaction() as conn:
        await conn.execute("INSERT INTO document_tasks(thread_id,request_hash,graph_id,document,failure_policy,expires_at) VALUES(%s,'x','document_parser',%s,'return_partial',now()+interval '1 day')", (task, Jsonb(reference.model_dump(mode='json'))))
    artifact = reference.model_dump(include={'objectKey','sha256','sizeBytes','mediaType'})
    read = await client.post('/api/admin/artifacts/read?thread_id=' + task, json=artifact)
    assert read.status_code == 200 and read.content == source
    blocked = await client.post('/api/admin/document-tasks/' + task + '/control', json={})
    assert blocked.status_code == 409 and blocked.json()['detail']['code'] == 'HISTORICAL_OWNERSHIP_REQUIRED'
    await login(client, 'reader@example.test', register=True)
    assert (await client.post('/api/artifacts/read?thread_id=' + task, json=artifact)).status_code == 404
