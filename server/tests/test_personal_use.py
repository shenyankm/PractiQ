"""Personal service access and non-destructive retirement of customer deployments."""
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from psycopg import sql

from practiq_ai import webapp
from practiq_ai.contracts import DocumentReference, DocumentTaskCreate
from practiq_ai.execution import namespace
from tests.db_support import new_database, setup_api


@pytest.mark.usefixtures('disposable_databases')
async def test_personal_import_needs_only_service_token_and_has_no_billing(monkeypatch):
    service, reference, model = await setup_api(monkeypatch)
    assert not any(name.startswith(('import_', 'payment_')) for name in await service.db.tables())
    request = DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)).model_dump(mode='json')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url='http://test') as client:
        for authorization in ('', 'Bearer wrong', 'Account retired-token'):
            response = await client.post('/api/document-tasks', json=request, headers={'Authorization': authorization})
            assert response.status_code == 401
        assert not model.calls and not await service.db.rows('SELECT * FROM document_tasks')
        client.headers['Authorization'] = 'Bearer test-token'
        response = await client.post('/api/document-tasks', json=request)
        assert response.status_code == 202, response.text
        assert (await client.post('/api/document-tasks', json=request)).json() == response.json()
        await service.wait_idle()
        detail = (await client.get('/api/document-tasks/' + response.json()['threadId'])).json()
        assert detail['state'] == 'COMPLETED' and 'billing' not in detail
        assert len(model.calls) == 1 and detail['usage']
        for path in ('/api/account', '/api/account/ledger', '/api/products', '/api/payments/products', '/api/payments/orders'):
            assert (await client.get(path)).status_code == 404
    schemas = webapp.app.openapi()['components']['schemas']
    assert not any(name in schemas for name in ('ImportAccount', 'PointRates', 'TaskBilling', 'PaymentOrder'))


async def legacy_database(version=4):
    db = await new_database()
    ddl = (Path(__file__).parent / 'fixtures/legacy-account-schema-v4.sql').read_bytes()
    async with db.transaction() as conn:
        await conn.execute(ddl, prepare=False)
        if version == 3:
            await conn.execute('DROP TABLE import_account_tokens')
            await conn.execute('CREATE TABLE import_cards(digest text PRIMARY KEY,account_id text REFERENCES import_accounts(account_id))')
        await conn.execute("INSERT INTO import_accounts VALUES ('customer','+6512345678',100)")
        await conn.execute("INSERT INTO import_ledger(account_id,amount,kind,reference,note) VALUES ('customer',100,'purchase','historical','retain historical evidence')")
        await conn.execute('UPDATE practiq_schema SET version=%s', (version,))
    return db


@pytest.mark.usefixtures('disposable_databases')
@pytest.mark.parametrize('version', [3, 4])
@pytest.mark.parametrize('owned', [False, True])
async def test_upgrade_preserves_archives_and_refuses_customer_task_adoption(version, owned):
    db = await legacy_database(version)
    if owned:
        async with db.transaction() as conn:
            await conn.execute("INSERT INTO document_tasks(thread_id,request_hash,graph_id,document,failure_policy,expires_at,account_id) VALUES ('customer-task','hash','document_parser','{}','return_partial',now()+interval '1 day','customer')")
    tables = await db.tables()
    ledger = await db.rows('SELECT * FROM import_ledger')
    if owned:
        with pytest.raises(RuntimeError, match='separate archived database'):
            await db.upgrade()
        assert await db.rows('SELECT version FROM practiq_schema') == [{'version': version}]
        assert (await db.rows('SELECT account_id FROM document_tasks')) == [{'account_id': 'customer'}]
    else:
        await db.upgrade()
        await db.upgrade()
        await db.check_schema()
        assert await db.rows('SELECT version FROM practiq_schema') == [{'version': 5}]
    assert await db.tables() == tables
    assert await db.rows('SELECT * FROM import_ledger') == ledger


@pytest.mark.usefixtures('disposable_databases')
async def test_upgrade_refuses_archived_uploads_even_after_customer_tasks_were_deleted():
    db = await legacy_database()
    async with db.transaction() as conn:
        await conn.execute("INSERT INTO import_uploads VALUES ('customer','retained-private-source','sha256','text/plain',10,true)")
    uploads = await db.rows('SELECT * FROM import_uploads')
    with pytest.raises(RuntimeError, match='separate archived database'):
        await db.upgrade()
    assert await db.rows('SELECT version FROM practiq_schema') == [{'version': 4}]
    assert await db.rows('SELECT * FROM import_uploads') == uploads


@pytest.mark.usefixtures('disposable_databases')
@pytest.mark.parametrize('version', [3, 4])
@pytest.mark.parametrize('status', ['pending', 'unknown'])
async def test_upgrade_refuses_unsettled_calls_without_tasks_and_retains_evidence(version, status):
    db = await legacy_database(version)
    thread_id = str(uuid4())
    async with db.transaction() as conn:
        await conn.execute("INSERT INTO import_calls(call_key,account_id,thread_id,result_key,rates,status,dispatched) VALUES ('call','customer',%s,'result','{}',%s,true)", (thread_id, status))
    for kind, key in (('calls', 'call'), ('model_results', 'result')):
        await db.store.aput(namespace(thread_id, kind), key, {'evidence': kind}, index=False)
    calls = await db.rows('SELECT * FROM import_calls')
    with pytest.raises(RuntimeError, match='separate archived database'):
        await db.upgrade()
    assert await db.rows('SELECT version FROM practiq_schema') == [{'version': version}]
    assert await db.rows('SELECT * FROM import_calls') == calls
    for kind, key in (('calls', 'call'), ('model_results', 'result')):
        item = await db.store.aget(namespace(thread_id, kind), key, refresh_ttl=False)
        assert item and item.value == {'evidence': kind}


@pytest.mark.usefixtures('disposable_databases')
@pytest.mark.parametrize('version', [3, 4])
@pytest.mark.parametrize('status', ['settled', 'rejected'])
async def test_upgrade_preserves_resolved_account_call_archives(version, status):
    db = await legacy_database(version)
    async with db.transaction() as conn:
        await conn.execute("INSERT INTO import_calls(call_key,account_id,thread_id,rates,status) VALUES ('call','customer','deleted-task','{}',%s)", (status,))
    calls = await db.rows('SELECT * FROM import_calls')
    ledger = await db.rows('SELECT * FROM import_ledger')
    accounts = await db.rows('SELECT * FROM import_accounts')
    await db.upgrade()
    await db.check_schema()
    assert await db.rows('SELECT * FROM import_calls') == calls
    assert await db.rows('SELECT * FROM import_ledger') == ledger
    assert await db.rows('SELECT * FROM import_accounts') == accounts


@pytest.mark.usefixtures('disposable_databases')
@pytest.mark.parametrize('version', [3, 4])
@pytest.mark.parametrize('missing', ['import_accounts', 'import_products', 'import_ledger', 'import_uploads', 'import_calls', 'credential'])
async def test_upgrade_refuses_incomplete_account_archives_without_mutation(version, missing):
    db = await legacy_database(version)
    table = ('import_cards' if version == 3 else 'import_account_tokens') if missing == 'credential' else missing
    async with db.transaction() as conn:
        await conn.execute(sql.SQL('DROP TABLE {} CASCADE').format(sql.Identifier(table)))
    tables = await db.tables()
    with pytest.raises(RuntimeError, match='complete service schema'):
        await db.upgrade()
    assert await db.rows('SELECT version FROM practiq_schema') == [{'version': version}]
    assert await db.tables() == tables


@pytest.mark.usefixtures('disposable_databases')
@pytest.mark.parametrize('version', [1, 2])
async def test_upgrade_refuses_account_tables_in_pre_account_schemas(version):
    db = await legacy_database(version)
    tables = await db.tables()
    with pytest.raises(RuntimeError, match='complete service schema'):
        await db.upgrade()
    assert await db.rows('SELECT version FROM practiq_schema') == [{'version': version}]
    assert await db.tables() == tables


@pytest.mark.usefixtures('disposable_databases')
async def test_upgrade_refuses_schema_three_with_new_account_tokens():
    db = await legacy_database()
    async with db.transaction() as conn:
        await conn.execute('CREATE TABLE import_cards(digest text PRIMARY KEY)')
        await conn.execute('UPDATE practiq_schema SET version=3')
    with pytest.raises(RuntimeError, match='complete service schema'):
        await db.upgrade()
    assert await db.rows('SELECT version FROM practiq_schema') == [{'version': 3}]


@pytest.mark.usefixtures('disposable_databases')
@pytest.mark.parametrize('version', [1, 2])
async def test_upgrade_accepts_pre_account_schemas_without_adding_account_tables(version):
    db = await new_database()
    async with db.transaction() as conn:
        if version == 1:
            await conn.execute('DROP TABLE document_outbox')
        await conn.execute('UPDATE practiq_schema SET version=%s', (version,))
    await db.upgrade()
    await db.check_schema()
    assert not any(name.startswith(('import_', 'payment_')) for name in await db.tables())
