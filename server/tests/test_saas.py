"""Phone/card isolation, durable points and paid checkpoint recovery."""

import asyncio
import hashlib
import json
import os
from argparse import Namespace
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import AsyncMock
from uuid import uuid4
from zipfile import ZipFile

import httpx
import pytest

from practiq_ai import execution, saas, saas_manage, storage, task_api, webapp
from practiq_ai.contracts import (
    CardRedeem,
    DocumentReference,
    DocumentTaskControl,
    DocumentTaskCreate,
    DocumentTaskReparse,
    DocumentUploadRequest,
    ImportAccount,
    PointLedger,
    TaskBilling,
)
from practiq_ai.database import Database
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.graphs import document
from tests.db_support import remove_saas_schema, setup_api
from tests.support import make_image, object_store, parsed, upload


async def issue(database, count=1, amount=1_000_000):
    product = uuid4().hex
    cards = [saas.new_card() for _ in range(count)]
    async with database.transaction() as conn:
        await conn.execute('INSERT INTO import_products VALUES(%s,%s,%s,%s,true)', (product, 'Import points', amount, 'https://shop.example/product'))
        for card in cards:
            await conn.execute('INSERT INTO import_cards(digest,product_id,points) VALUES(%s,%s,%s)', (saas.digest(card), product, amount))
    return cards


@pytest.mark.parametrize('number,normalized', [('13800138000', '+8613800138000'), ('+6512345678', '+6512345678')])
def test_phone_normalization(number, normalized):
    assert saas.phone(number) == normalized


@pytest.mark.parametrize('value', ['abc', '0000000', '+0123456', '13800138000\nmalicious', '+8613800138000 extra'])
def test_phone_rejects_invalid_identity(value):
    with pytest.raises(DocumentProcessingError):
        saas.phone(value)


@pytest.mark.parametrize('value', ['0', '-1', 'NaN', 'Infinity', '0.0000001', '10000000000'])
def test_point_rates_reject_invalid_precision_and_bounds(value):
    with pytest.raises(ValueError):
        saas.points(value)


def test_integer_point_weighting_rounds_only_to_micropoints():
    assert saas.points('0.000001') == 1
    assert saas.charge({'inputTokens': 10, 'outputTokens': 5}, {'inputMicropointsPer1k': 1_000_000, 'outputMicropointsPer1k': 3_000_000}) == 25_000
    assert saas.charge({'inputTokens': 1, 'outputTokens': 0}, {'inputMicropointsPer1k': 1, 'outputMicropointsPer1k': 1}) == 1


def test_wire_micropoints_are_exact_decimal_strings_for_all_accounting_fields():
    amount = 2**53 + 1
    value = TaskBilling.model_validate({'phone': '+8613800138000', 'balanceMicropoints': -amount, 'usageUnknown': False,
                                       'chargedMicropoints': amount, 'rates': {'inputMicropointsPer1k': amount, 'outputMicropointsPer1k': 1}})
    assert value.balanceMicropoints == -amount
    data = json.loads(value.model_dump_json())
    assert data['balanceMicropoints'] == str(-amount) and data['chargedMicropoints'] == str(amount)
    assert data['rates']['inputMicropointsPer1k'] == str(amount)
    assert ImportAccount.model_json_schema(mode='serialization')['properties']['balanceMicropoints']['type'] == 'string'
    ledger = PointLedger.model_validate({'items': [{'id': 1, 'amountMicropoints': -amount, 'kind': 'model', 'createdAt': '2026-10-13'}], 'nextBefore': None})
    assert json.loads(ledger.model_dump_json())['items'][0]['amountMicropoints'] == str(-amount)


@pytest.mark.usefixtures('disposable_databases')
async def test_card_redemption_http_preserves_balances_beyond_javascript_safe_integer(monkeypatch):
    service, _, _ = await setup_api(monkeypatch)
    cards = await issue(service.db, 10, amount=10**15)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url='http://test') as http:
        for card in cards:
            request = {'phone': '13800138000', 'card': card}
            if card != cards[0]:
                request['boundCard'] = cards[0]
            result = await http.post('/api/cards/redeem', json=request)
            assert result.status_code == 200
        headers = {'Authorization': 'Card ' + cards[0], 'X-Practiq-Phone': '13800138000'}
        assert (await http.get('/api/account', headers=headers)).json()['balanceMicropoints'] == '10000000000000000'
        account = await saas.identity('13800138000', cards[0])
        async with service.db.transaction() as conn:
            await saas.credit(conn, account, -1, 'model', 'precision-check')
        assert (await http.get('/api/account', headers=headers)).json()['balanceMicropoints'] == '9999999999999999'
        ledger = (await http.get('/api/account/ledger', headers=headers)).json()
        assert ledger['items'][0]['amountMicropoints'] == '-1'
        assert (await http.get('/api/products')).json()['items'][0]['pointsMicropoints'] == '1000000000000000'


@pytest.mark.usefixtures('disposable_databases')
async def test_upload_quota_is_atomic_counts_uncertain_writes_and_never_grants_hash_ownership(monkeypatch, tmp_path):
    monkeypatch.setenv('AI_ACCOUNT_UPLOAD_MAX_BYTES', '8')
    monkeypatch.setenv('AI_ACCOUNT_UPLOAD_MAX_FILES', '2')
    service, _, _ = await setup_api(monkeypatch)
    card = (await issue(service.db))[0]
    await saas.redeem(CardRedeem(phone='13800138000', card=card))
    account = await saas.identity('13800138000', card)
    store = object_store(tmp_path)
    async with service.db.transaction() as conn:
        await saas.credit(conn, account, -1_000_000, 'model', 'spent-before-upload')
    def metadata(payload):
        return DocumentUploadRequest(sourceType='text', fileName='q.txt', mediaType='text/plain', sizeBytes=len(payload), sha256=hashlib.sha256(payload).hexdigest())
    first, second = b'first', b'other'
    token = saas.ACCOUNT.set(account)
    try:
        outcomes = await asyncio.gather(saas.store_upload(store, first, metadata(first)), saas.store_upload(store, second, metadata(second)), return_exceptions=True)
        assert sum(isinstance(item, DocumentReference) for item in outcomes) == 1
        assert any(isinstance(item, DocumentProcessingError) and item.code == 'ACCOUNT_UPLOAD_QUOTA' for item in outcomes)
        rows = await service.db.rows('SELECT * FROM import_uploads WHERE account_id=%s', (account,))
        assert len(rows) == 1 and rows[0]['verified']
        actual = first if rows[0]['sha256'] == metadata(first).sha256 else second
        assert await saas.store_upload(store, actual, metadata(actual))
        # A shared physical file plus an uncertain reservation is not upload proof.
        shared = b'new'
        reference = await store.put_document(shared, metadata(shared))
        original = store.put_document
        async def uncertain(*args):
            raise OSError('Unknown storage outcome')
        monkeypatch.setattr(store, 'put_document', uncertain)
        with pytest.raises(OSError):
            await saas.store_upload(store, shared, metadata(shared))
        assert not await saas.owns_upload(reference)
        assert (await saas.prepare_upload(metadata(shared))).upload is not None
        with pytest.raises(DocumentProcessingError, match='Account upload quota'):
            await saas.store_upload(store, b'x', metadata(b'x'))
        monkeypatch.setattr(store, 'put_document', original)
        assert await saas.store_upload(store, shared, metadata(shared)) == reference
        assert await saas.owns_upload(reference)
        monkeypatch.setattr(storage, 'get_object_store', lambda: store)
        (store.root / reference.objectKey).unlink()
        assert (await saas.prepare_upload(metadata(shared))).upload is not None
        assert await saas.store_upload(store, shared, metadata(shared)) == reference
    finally:
        saas.ACCOUNT.reset(token)


@pytest.mark.usefixtures('disposable_databases')
async def test_old_schema_three_upload_proofs_upgrade_explicitly_without_data_loss(monkeypatch):
    service, reference, _ = await setup_api(monkeypatch)
    card = (await issue(service.db))[0]
    await saas.redeem(CardRedeem(phone='13800138000', card=card))
    account = await saas.identity('13800138000', card)
    token = saas.ACCOUNT.set(account)
    try:
        await saas.register_upload(DocumentReference.model_validate(reference))
        async with service.db.transaction() as conn:
            await conn.execute('ALTER TABLE import_uploads DROP COLUMN verified')
        with pytest.raises(RuntimeError, match='offline upgrade-db'):
            await service.db.check_schema()
        await service.db.upgrade()
        await service.db.upgrade()
        assert await saas.owns_upload(DocumentReference.model_validate(reference))
    finally:
        saas.ACCOUNT.reset(token)


async def test_unsettled_accounting_evidence_has_no_task_expiry():
    store = SimpleNamespace(supports_ttl=True, aput=AsyncMock())
    runtime = SimpleNamespace(store=store, execution_info=SimpleNamespace(thread_id=str(uuid4())))
    token = execution.CURRENT_EXECUTION.set({'accountId': str(uuid4())})
    try:
        for kind in ('calls', 'model_results'):
            await execution.store_put(cast(Any, runtime), kind, 'receipt', {'usage': {}})
            assert store.aput.call_args.kwargs['ttl'] is None
    finally:
        execution.CURRENT_EXECUTION.reset(token)


@pytest.mark.usefixtures('disposable_databases')
async def test_card_binding_is_atomic_replay_safe_and_prevents_phone_takeover(monkeypatch):
    service, _, _ = await setup_api(monkeypatch)
    first, second, third = await issue(service.db, 3)
    request = CardRedeem(phone='13800138000', card=first)
    a, b = await asyncio.gather(saas.redeem(request), saas.redeem(request))
    assert a == b and a['balanceMicropoints'] == 1_000_000
    with pytest.raises(DocumentProcessingError):
        await saas.redeem(CardRedeem(phone='13900139000', card=first))
    with pytest.raises(DocumentProcessingError):
        await saas.redeem(CardRedeem(phone=request.phone, card=second))
    charged = await saas.redeem(CardRedeem(phone=request.phone, card=second, boundCard=first))
    assert charged['balanceMicropoints'] == 2_000_000
    assert await saas.redeem(CardRedeem(phone=request.phone, card=second)) == charged
    account = await saas.identity(request.phone, second)
    async with service.db.transaction() as conn:
        await conn.execute('UPDATE import_cards SET revoked=true WHERE digest=%s', (saas.digest(first),))
    with pytest.raises(DocumentProcessingError):
        await saas.identity(request.phone, first)
    assert await saas.identity(request.phone, second) == account
    assert len((await saas.ledger(account, 1, None))['items']) == 1
    assert (await saas.products())['items'][0]['purchaseUrl'].startswith('https:')
    assert saas.digest(third) != third


@pytest.mark.usefixtures('disposable_databases')
async def test_customer_http_owns_tasks_uploads_and_artifact_reads(monkeypatch, tmp_path):
    monkeypatch.setenv('AI_INPUT_POINTS_PER_1K', '1')
    monkeypatch.setenv('AI_OUTPUT_POINTS_PER_1K', '3')
    service, _, _ = await setup_api(monkeypatch, [parsed(), parsed()])
    store = object_store(tmp_path)
    for module in (task_api, execution, document, storage, webapp):
        monkeypatch.setattr(module, 'get_object_store', lambda: store)
    first, second = await issue(service.db, 2)
    await saas.redeem(CardRedeem(phone='13800138000', card=first))
    await saas.redeem(CardRedeem(phone='13900139000', card=second))
    a = {'Authorization': 'Card ' + first, 'X-Practiq-Phone': '13800138000'}
    b = {'Authorization': 'Card ' + second, 'X-Practiq-Phone': '13900139000'}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url='http://test') as http:
        assert (await http.get('/api/products')).status_code == 200
        assert (await http.post('/api/document-tasks', json={}, headers={'Authorization': 'Bearer test-token'})).status_code == 401
        prepared = await http.post('/api/uploads', json=upload().model_dump(), headers=a)
        assert prepared.status_code == 201, prepared.text
        assert prepared.json()['upload']
        reference = prepared.json()['document']
        request = {'requestId': str(uuid4()), 'document': reference}
        assert (await http.post('/api/document-tasks', json=request, headers=a)).status_code == 404
        assert (await http.put(prepared.json()['upload']['url'], content=b'quiz', headers=a)).status_code == 200
        created = await http.post('/api/document-tasks', json=request, headers=a)
        assert created.status_code == 202, created.text
        assert (await http.post('/api/document-tasks', json=request, headers=a)).json() == created.json()
        await service.wait_idle()
        tid = created.json()['threadId']
        for suffix in ('', '/head', '/preview', '/export'):
            assert (await http.get('/api/document-tasks/' + tid + suffix, headers=b)).status_code == 404
        assert (await http.delete('/api/document-tasks/' + tid, headers=b)).status_code == 404
        control = {'requestId': str(uuid4()), 'action': 'resume', 'checkpointId': 'checkpoint-one'}
        assert (await http.post('/api/document-tasks/' + tid + '/control', json=control, headers=b)).status_code == 404
        assert (await http.post('/api/document-tasks/' + tid + '/reparse', json=DocumentTaskReparse(requestId=uuid4()).model_dump(mode='json'), headers=b)).status_code == 404
        assert (await http.post('/api/document-tasks/' + tid + '/reparse', json={'requestId': str(uuid4())}, headers={'Authorization': 'Bearer test-token'})).status_code == 404
        assert (await http.post('/api/artifacts/read?thread_id=' + tid, json={k: reference[k] for k in ('objectKey', 'sha256', 'sizeBytes', 'mediaType')}, headers=b)).status_code == 404
        assert not (await http.get('/api/document-tasks', headers=b)).json()['items']
        assert (await http.post('/api/document-tasks', json=request, headers=b)).status_code == 404
        other = await http.post('/api/uploads', json=upload().model_dump(), headers=b)
        assert other.json()['upload'], 'A shared physical file must not disclose customer deduplication'
        assert (await http.put(other.json()['upload']['url'], content=b'quiz', headers=b)).status_code == 200
        assert (await http.post('/api/document-tasks', json={**request, 'parentThreadId': tid}, headers=b)).status_code == 404
        child = await http.post('/api/document-tasks', json={**request, 'requestId': str(uuid4()), 'parentThreadId': tid}, headers=a)
        assert child.status_code == 202
        await service.wait_idle()
        page = (await http.get('/api/document-tasks?limit=1', headers=a)).json()
        assert page['nextCursor']
        assert (await http.get('/api/document-tasks', params={'limit': 1, 'cursor': page['nextCursor']}, headers=b)).status_code == 400
        assert (await http.post('/api/artifacts/read', json={k: reference[k] for k in ('objectKey', 'sha256', 'sizeBytes', 'mediaType')}, headers=a)).status_code == 404
        detail = (await http.get('/api/document-tasks/' + tid, headers=a)).json()
        assert detail['billing']['chargedMicropoints'] == '25000'
        before = (await http.get('/api/account', headers=a)).json()
        assert (await http.get('/api/document-tasks/' + tid + '/export', headers=a)).status_code == 200
        assert (await http.get('/api/account', headers=a)).json() == before
        image = make_image()
        own_image = await store.put_artifact(image, source_sha256=reference['sha256'], kind='visual', index=0, media_type='image/png')
        foreign_image = await store.put_artifact(image, source_sha256='b' * 64, kind='visual', index=0, media_type='image/png')
        with monkeypatch.context() as patches:
            # Model-provided references are not proof of asset ownership.
            patches.setattr(task_api, 'review_task', AsyncMock(return_value={'references': [own_image.model_dump(), foreign_image.model_dump()]}))
            endpoint = '/api/artifacts/read?thread_id=' + tid
            assert (await http.post(endpoint, json=foreign_image.model_dump(), headers=a)).status_code == 404
            accepted = await http.post(endpoint, json=own_image.model_dump(), headers=a)
            assert accepted.status_code == 200 and accepted.content == image


@pytest.mark.usefixtures('disposable_databases')
async def test_bearer_is_scoped_to_legacy_tasks_and_cannot_spend_customer_points(monkeypatch):
    monkeypatch.setenv('AI_INPUT_POINTS_PER_1K', '1')
    monkeypatch.setenv('AI_OUTPUT_POINTS_PER_1K', '3')
    service, reference, model = await setup_api(monkeypatch, [parsed(), parsed(), parsed()])
    card = (await issue(service.db))[0]
    await saas.redeem(CardRedeem(phone='13800138000', card=card))
    account = await saas.identity('13800138000', card)
    token = saas.ACCOUNT.set(account)
    try:
        await saas.register_upload(DocumentReference.model_validate(reference))
        owned = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    finally:
        saas.ACCOUNT.reset(token)
    legacy = [await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference))) for _ in range(2)]
    await service.wait_idle()
    before = await saas.account_summary(account)
    calls_before = len(model.calls)
    headers = {'Authorization': 'Bearer test-token'}
    customer = {'Authorization': 'Card ' + card, 'X-Practiq-Phone': '13800138000'}
    tid = owned['threadId']
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url='http://test') as http:
        for suffix in ('', '/head', '/preview', '/export', '/export?scope=completed'):
            assert (await http.get('/api/document-tasks/' + tid + suffix, headers=headers)).status_code == 404
        assert (await http.delete('/api/document-tasks/' + tid, headers=headers)).status_code == 404
        assert (await http.post('/api/document-tasks/' + tid + '/reparse', json={'requestId': str(uuid4())}, headers=headers)).status_code == 404
        for action in ('resume', 'retry_failed', 'pause', 'interrupt'):
            control = {'requestId': str(uuid4()), 'action': action, **({'runId': owned['runId']} if action in {'pause', 'interrupt'} else {'checkpointId': 'current'})}
            assert (await http.post('/api/document-tasks/' + tid + '/control', json=control, headers=headers)).status_code == 404
        artifact = {key: reference[key] for key in ('objectKey', 'sha256', 'sizeBytes', 'mediaType')}
        for endpoint in ('/api/artifacts/read', '/api/artifacts/read?thread_id=' + tid):
            assert (await http.post(endpoint, json=artifact, headers=headers)).status_code == 404
        page = (await http.get('/api/document-tasks?limit=1', headers=headers)).json()
        assert page['nextCursor'] and page['items'][0]['threadId'] in {item['threadId'] for item in legacy}
        assert (await http.get('/api/document-tasks', params={'cursor': page['nextCursor']}, headers=customer)).status_code == 400
        customer_page = (await http.get('/api/document-tasks', headers=customer)).json()
        assert [item['threadId'] for item in customer_page['items']] == [tid]
        for query in ('', '?state_filter=completed', '?sha256=' + reference['sha256']):
            page = (await http.get('/api/document-tasks' + query, headers=headers)).json()
            assert {item['threadId'] for item in page['items']} == {item['threadId'] for item in legacy}
        for item in legacy:
            for suffix in ('', '/head', '/preview', '/export'):
                assert (await http.get('/api/document-tasks/' + item['threadId'] + suffix, headers=headers)).status_code == 200
            assert (await http.get('/api/document-tasks/' + item['threadId'], headers=customer)).status_code == 404
        assert (await http.get('/api/document-tasks/' + tid, headers=customer)).status_code == 200
        assert (await http.delete('/api/document-tasks/' + legacy[0]['threadId'], headers=headers)).status_code == 200
        assert await saas.account_summary(account) == before and len(model.calls) == calls_before
        model.responses.append(parsed('Legacy reparse'))
        request = {'requestId': str(uuid4())}
        endpoint = '/api/document-tasks/' + legacy[1]['threadId'] + '/reparse'
        reparsed = await http.post(endpoint, json=request, headers=headers)
        assert reparsed.status_code == 202, reparsed.text
        assert (await http.post(endpoint, json=request, headers=headers)).json() == reparsed.json()
        await service.wait_idle()
        child_url = '/api/document-tasks/' + reparsed.json()['threadId']
        child = (await http.get(child_url, headers=headers)).json()
        assert child['state'] == 'COMPLETED' and child['billing'] is None
        assert child['parentThreadId'] == legacy[1]['threadId']
        assert (await http.get(child_url, headers=customer)).status_code == 404
    assert await saas.account_summary(account) == before
    assert len(model.calls) == calls_before + 1


@pytest.mark.usefixtures('disposable_databases')
async def test_task_charge_poll_uses_account_index_with_retained_cross_account_history(monkeypatch):
    monkeypatch.setenv('AI_INPUT_POINTS_PER_1K', '1')
    monkeypatch.setenv('AI_OUTPUT_POINTS_PER_1K', '3')
    service, reference, _ = await setup_api(monkeypatch)
    cards = await issue(service.db, 2)
    accounts = []
    for number, card in zip(('13800138000', '13900139000'), cards, strict=True):
        await saas.redeem(CardRedeem(phone=number, card=card))
        accounts.append(await saas.identity(number, card))
    token = saas.ACCOUNT.set(accounts[0])
    try:
        await saas.register_upload(DocumentReference.model_validate(reference))
        receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
        await service.wait_idle()
        async with service.db.transaction() as conn:
            await conn.execute("INSERT INTO import_ledger(account_id,amount,kind,reference) SELECT %s,-1,'model','retained-'||g FROM generate_series(1,20000) g", (accounts[1],))
            await conn.execute('ANALYZE import_ledger')
            await conn.execute('ANALYZE import_calls')
        original = service.db.rows
        plans = []
        async def rows(query, params=()):
            if query.startswith('SELECT coalesce(sum(-l.amount)'):
                plans.extend(await original('EXPLAIN (FORMAT JSON) ' + query, params))
            return await original(query, params)
        monkeypatch.setattr(service.db, 'rows', rows)
        detail = await task_api.get_task(receipt['threadId'])
        assert detail['billing']['chargedMicropoints'] == '25000'
        assert 'import_ledger_account_id_kind_reference_key' in json.dumps(plans)
    finally:
        saas.ACCOUNT.reset(token)


@pytest.mark.usefixtures('disposable_databases')
async def test_points_pause_partial_download_top_up_and_explicit_resume_reuse_paid_units(monkeypatch):
    monkeypatch.setenv('AI_INPUT_POINTS_PER_1K', '1')
    monkeypatch.setenv('AI_OUTPUT_POINTS_PER_1K', '3')
    service, reference, model = await setup_api(monkeypatch, [parsed('First'), parsed('Second')], parts=['1. First\n', '2. Second'])
    first, topup = await issue(service.db, 2, amount=20_000)
    await saas.redeem(CardRedeem(phone='13800138000', card=first))
    account = await saas.identity('13800138000', first)
    token = saas.ACCOUNT.set(account)
    try:
        await saas.register_upload(DocumentReference.model_validate(reference))
        receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
        await service.wait_idle()
        detail = await task_api.get_task(receipt['threadId'])
        assert detail['state'] == 'PAUSED', json.dumps(detail)
        assert detail['canExportCompleted'] and len(model.calls) == 1
        assert detail['billing']['balanceMicropoints'] == '-5000'
        await task_api.control_task(receipt['threadId'], DocumentTaskControl(requestId=uuid4(), action='resume', checkpointId=detail['checkpointId']))
        await service.wait_idle()
        detail = await task_api.get_task(receipt['threadId'])
        assert detail['state'] == 'PAUSED' and len(model.calls) == 1, json.dumps(detail)
        bank = await task_api.export_task(receipt['threadId'], detail['checkpointId'], completed=True)
        fixture = Path(__file__).parents[2] / 'app/fixtures/saas-export/partial-bank.zip'
        payload_bytes = bank.read()
        bank.seek(0)
        if os.environ.get('PRACTIQ_UPDATE_SAAS_FIXTURE') == '1':
            fixture.parent.mkdir(parents=True, exist_ok=True)
            fixture.write_bytes(payload_bytes)
        assert fixture.read_bytes() == payload_bytes
        with bank, ZipFile(bank) as archive:
            payload = json.loads(archive.read('questions.json'))
        assert payload['status'] == 'PARTIAL' and len(payload['result']['questions']) == 1
        monkeypatch.setenv('AI_INPUT_POINTS_PER_1K', '9')
        monkeypatch.setenv('AI_OUTPUT_POINTS_PER_1K', '9')
        await saas.redeem(CardRedeem(phone='13800138000', card=topup, boundCard=first))
        await asyncio.sleep(.05)
        assert len(model.calls) == 1
        await task_api.control_task(receipt['threadId'], DocumentTaskControl(requestId=uuid4(), action='resume', checkpointId=detail['checkpointId']))
        await service.wait_idle()
        complete = await task_api.get_task(receipt['threadId'])
        assert complete['state'] == 'COMPLETED', complete
        assert len(model.calls) == 2 and len(complete['result']['questions']) == 2
        assert complete['billing']['chargedMicropoints'] == '50000'
        assert complete['billing']['rates'] == {'inputMicropointsPer1k': '1000000', 'outputMicropointsPer1k': '3000000'}
        await task_api.delete_task(receipt['threadId'])
        assert len((await saas.ledger(account, 100, None))['items']) == 4
        with pytest.raises(DocumentProcessingError, match='new requestId') as retired:
            await task_api.create_task(DocumentTaskCreate(requestId=receipt['requestId'], document=DocumentReference.model_validate(reference)))
        assert retired.value.code == 'TASK_ID_RETIRED'
    finally:
        saas.ACCOUNT.reset(token)


@pytest.mark.usefixtures('disposable_databases')
async def test_invalid_model_output_is_charged_and_correction_pauses_without_losing_paid_attempt(monkeypatch):
    monkeypatch.setenv('AI_INPUT_POINTS_PER_1K', '1')
    monkeypatch.setenv('AI_OUTPUT_POINTS_PER_1K', '3')
    service, reference, model = await setup_api(monkeypatch, [{'questions': 'invalid array'}, parsed()])
    first, recharge = await issue(service.db, 2, amount=20_000)
    await saas.redeem(CardRedeem(phone='13800138000', card=first))
    account = await saas.identity('13800138000', first)
    token = saas.ACCOUNT.set(account)
    try:
        await saas.register_upload(DocumentReference.model_validate(reference))
        receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
        await service.wait_idle()
        detail = await task_api.get_task(receipt['threadId'])
        assert detail['state'] == 'PAUSED' and detail['billing']['chargedMicropoints'] == '25000'
        assert not detail['failures'] and not detail['canExportCompleted'] and len(model.calls) == 1
        await saas.redeem(CardRedeem(phone='13800138000', card=recharge, boundCard=first))
        await task_api.control_task(receipt['threadId'], DocumentTaskControl(requestId=uuid4(), action='resume', checkpointId=detail['checkpointId']))
        await service.wait_idle()
        complete = await task_api.get_task(receipt['threadId'])
        assert complete['state'] == 'COMPLETED' and len(model.calls) == 2
        assert complete['billing']['chargedMicropoints'] == '50000'
    finally:
        saas.ACCOUNT.reset(token)


@pytest.mark.usefixtures('disposable_databases')
async def test_unknown_usage_blocks_account_and_manual_settlement_is_idempotent(monkeypatch):
    service, _reference, _ = await setup_api(monkeypatch)
    card = (await issue(service.db))[0]
    await saas.redeem(CardRedeem(phone='13800138000', card=card))
    account = await saas.identity('13800138000', card)
    key = str(uuid4())
    async with service.db.transaction() as conn:
        await conn.execute("INSERT INTO import_calls(call_key,account_id,thread_id,rates,status,dispatched) VALUES(%s,%s,%s,%s,'pending',true)",
                           (key, account, str(uuid4()), json.dumps({'inputMicropointsPer1k': 1_000_000, 'outputMicropointsPer1k': 3_000_000})))
    await saas.reconcile(service.db)
    assert (await saas.account_summary(account))['usageUnknown']
    usage = {'inputTokens': 10, 'outputTokens': 5}
    await saas.settle(key, usage, note='Verified provider usage')
    await saas.settle(key, usage)
    assert (await saas.account_summary(account)) == {'phone': '+8613800138000', 'balanceMicropoints': 975_000, 'usageUnknown': False}
    assert len((await saas.ledger(account, 100, None))['items']) == 2


@pytest.mark.usefixtures('disposable_databases')
async def test_schema_two_upgrade_keeps_legacy_records_and_rejects_unknown_schema(monkeypatch):
    service, reference, _ = await setup_api(monkeypatch)
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await service.wait_idle()
    db = service.db
    async with db.transaction() as conn:
        await remove_saas_schema(conn)
        await conn.execute('UPDATE practiq_schema SET version=2')
    await db.upgrade()
    await db.upgrade()
    assert (await db.rows('SELECT account_id FROM document_tasks WHERE thread_id=%s', (receipt['threadId'],))) == [{'account_id': None}]
    await db.check_schema()


@pytest.mark.usefixtures('disposable_databases')
async def test_operator_card_export_is_private_and_snapshots_product_points(monkeypatch, tmp_path, capsys):
    service, _, _ = await setup_api(monkeypatch)
    monkeypatch.setattr(saas_manage, 'Database', lambda: Database(service.db.uri))
    product = Namespace(action='product', id='test', name='Example', points='2.125', purchase_url='https://shop.example/item', disabled=False)
    await saas_manage.run(product)
    destination = tmp_path / 'cards.txt'
    generate = Namespace(action='generate', product='test', count=2, output=destination)
    await saas_manage.run(generate)
    assert destination.stat().st_mode & 0o777 == 0o600
    codes = destination.read_text().splitlines()
    assert len(set(codes)) == 2 and all(saas.digest(code) for code in codes)
    output = capsys.readouterr().out
    assert all(code not in output for code in codes)
    with pytest.raises(FileExistsError):
        await saas_manage.run(generate)
    product.points = '3'
    await saas_manage.run(product)
    assert (await saas.redeem(CardRedeem(phone='13800138000', card=codes[0])))['balanceMicropoints'] == 2_125_000
    await saas_manage.run(Namespace(action='revoke', digest=saas.digest(codes[0])))
    with pytest.raises(DocumentProcessingError):
        await saas.identity('13800138000', codes[0])
    for changes in ({'id': '../escape'}, {'points': '-1'}, {'purchase_url': 'http://shop.example'}, {'name': ''}):
        with pytest.raises(ValueError):
            await saas_manage.run(Namespace(**{**vars(product), **changes}))


@pytest.mark.usefixtures('disposable_databases')
async def test_reconcile_settles_saved_model_usage_once_without_changing_results(monkeypatch):
    service, _, _ = await setup_api(monkeypatch)
    card = (await issue(service.db))[0]
    await saas.redeem(CardRedeem(phone='13800138000', card=card))
    account = await saas.identity('13800138000', card)
    thread, key = str(uuid4()), str(uuid4())
    saved = {'usage': {'inputTokens': 10, 'outputTokens': 5, 'callKey': key, 'modelId': 'test', 'callKind': 'parse'}, 'parsed': parsed()}
    await service.db.store.aput(execution.namespace(thread, 'model_results'), 'saved', saved, index=False)
    async with service.db.transaction() as conn:
        await conn.execute("INSERT INTO import_calls(call_key,account_id,thread_id,result_key,rates,status,dispatched) VALUES(%s,%s,%s,'saved',%s,'pending',true)",
                           (key, account, thread, json.dumps({'inputMicropointsPer1k': 1_000_000, 'outputMicropointsPer1k': 3_000_000})))
    await saas.reconcile(service.db)
    await saas.reconcile(service.db)
    monkeypatch.setattr(saas_manage, 'Database', lambda: Database(service.db.uri))
    await saas_manage.run(Namespace(action='resolve', call_key=key, input_tokens=10, output_tokens=5, note='Verified same receipt'))
    assert (await saas.account_summary(account))['balanceMicropoints'] == 975_000
    assert (await service.db.store.aget(execution.namespace(thread, 'model_results'), 'saved')).value == saved


@pytest.mark.usefixtures('disposable_databases')
@pytest.mark.parametrize('offline', [False, True])
async def test_task_cleanup_preserves_unsettled_usage_and_result_for_reconciliation(monkeypatch, offline):
    from practiq_ai.manage import cleanup
    service, reference, _ = await setup_api(monkeypatch)
    card = (await issue(service.db))[0]
    await saas.redeem(CardRedeem(phone='13800138000', card=card))
    account = await saas.identity('13800138000', card)
    receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await service.wait_idle()
    thread, key = receipt['threadId'], str(uuid4())
    saved = {'usage': {'inputTokens': 10, 'outputTokens': 5}, 'parsed': parsed()}
    runtime = SimpleNamespace(store=service.db.store, execution_info=SimpleNamespace(thread_id=thread))
    token = execution.CURRENT_EXECUTION.set({'accountId': account})
    try:
        await execution.store_put(cast(Any, runtime), 'model_results', 'unsettled', saved)
    finally:
        execution.CURRENT_EXECUTION.reset(token)
    for index in range(105):
        await service.db.store.aput(execution.namespace(thread, 'temporary'), str(index), {}, index=False)
    async with service.db.transaction() as conn:
        await conn.execute("INSERT INTO import_calls(call_key,account_id,thread_id,result_key,rates,status,dispatched) VALUES(%s,%s,%s,'unsettled',%s,'unknown',true)",
                           (key, account, thread, json.dumps({'inputMicropointsPer1k': 1_000_000, 'outputMicropointsPer1k': 3_000_000})))
        await conn.execute("UPDATE document_tasks SET expires_at=now()-interval '1 day' WHERE thread_id=%s", (thread,))
    if offline:
        await service.stop()
        await service.db.open()
        monkeypatch.setenv('AI_MAINTENANCE_MODE', 'true')
        await cleanup(service.db)
    else:
        await task_api.delete_task(thread)
    assert not await service.db.rows('SELECT 1 FROM document_tasks WHERE thread_id=%s', (thread,))
    assert (await service.db.store.aget(execution.namespace(thread, 'model_results'), 'unsettled')).value == saved
    await saas.reconcile(service.db)
    await saas.reconcile(service.db)
    assert (await service.db.rows('SELECT balance FROM import_accounts WHERE account_id=%s', (account,)))[0]['balance'] == 975_000
    assert len(await service.db.rows("SELECT 1 FROM import_ledger WHERE reference=%s", (key,))) == 1
    await saas.cleanup_task_store(service.db, thread)
    assert not await service.db.store.asearch(execution.namespace(thread, '')[:2])


@pytest.mark.usefixtures('disposable_databases')
async def test_saved_model_result_survives_settlement_failure_and_explicit_resume(monkeypatch):
    monkeypatch.setenv('AI_INPUT_POINTS_PER_1K', '1')
    monkeypatch.setenv('AI_OUTPUT_POINTS_PER_1K', '3')
    service, reference, model = await setup_api(monkeypatch)
    card = (await issue(service.db))[0]
    await saas.redeem(CardRedeem(phone='13800138000', card=card))
    account = await saas.identity('13800138000', card)
    settle = saas.settle
    failures = 0
    async def fail_twice(call_key, usage, **kwargs):
        nonlocal failures
        if usage is not None and failures < 2:
            failures += 1
            raise OSError('Transient settlement failure')
        await settle(call_key, usage, **kwargs)
    monkeypatch.setattr(saas, 'settle', fail_twice)
    token = saas.ACCOUNT.set(account)
    try:
        await saas.register_upload(DocumentReference.model_validate(reference))
        receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
        await service.wait_idle()
        detail = await task_api.get_task(receipt['threadId'])
        assert detail['state'] == 'PAUSED' and not detail['failures'], detail
        await task_api.control_task(receipt['threadId'], DocumentTaskControl(requestId=uuid4(), action='resume', checkpointId=detail['checkpointId']))
        await service.wait_idle()
        again = await task_api.get_task(receipt['threadId'])
        assert again['state'] == 'PAUSED' and not again['failures'] and len(model.calls) == 1, again
        await task_api.control_task(receipt['threadId'], DocumentTaskControl(requestId=uuid4(), action='resume', checkpointId=again['checkpointId']))
        await service.wait_idle()
        complete = await task_api.get_task(receipt['threadId'])
        assert complete['state'] == 'COMPLETED' and len(model.calls) == 1, complete
        assert complete['billing']['chargedMicropoints'] == '25000'
    finally:
        saas.ACCOUNT.reset(token)


@pytest.mark.usefixtures('disposable_databases')
async def test_account_serializes_calls_but_other_accounts_can_dispatch(monkeypatch):
    service, _, _ = await setup_api(monkeypatch)
    cards = await issue(service.db, 2)
    accounts = []
    for number, card in zip(('13800138000', '13900139000'), cards, strict=True):
        await saas.redeem(CardRedeem(phone=number, card=card))
        accounts.append(await saas.identity(number, card))
    threads = [str(uuid4()) for _ in range(3)]
    async with service.db.transaction() as conn:
        for thread, account in zip(threads, [accounts[0], accounts[0], accounts[1]], strict=True):
            await conn.execute("INSERT INTO document_tasks(thread_id,request_hash,graph_id,document,failure_policy,expires_at,account_id,billing_rates) VALUES(%s,'test','document_parser','{}','return_partial',now()+interval '1 day',%s,%s)",
                               (thread, account, json.dumps({'inputMicropointsPer1k': 1_000_000, 'outputMicropointsPer1k': 3_000_000})))
    token = execution.CURRENT_EXECUTION.set({'accountId': accounts[0]})
    calls = [str(uuid4()) for _ in threads]
    runtimes = [SimpleNamespace(execution_info=SimpleNamespace(thread_id=thread)) for thread in threads]
    pending = None
    try:
        assert await saas.begin_call(runtimes[0], calls[0], None)
        pending = asyncio.create_task(saas.begin_call(runtimes[1], calls[1], None))
        await asyncio.sleep(.1)
        assert not pending.done()
        assert await asyncio.wait_for(saas.begin_call(runtimes[2], calls[2], None), 1)
        await saas.settle(calls[0], {'inputTokens': 10, 'outputTokens': 5})
        assert await asyncio.wait_for(pending, 1)
        await saas.settle(calls[1], {'inputTokens': 10, 'outputTokens': 5})
        await saas.settle(calls[2], {'inputTokens': 10, 'outputTokens': 5})
        assert (await saas.account_summary(accounts[0]))['balanceMicropoints'] == 950_000
    finally:
        if pending and not pending.done():
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
        execution.CURRENT_EXECUTION.reset(token)


@pytest.mark.usefixtures('disposable_databases')
async def test_one_account_backlog_does_not_occupy_other_accounts_worker_or_broker_slots(monkeypatch):
    from langchain_core.runnables import RunnableLambda
    monkeypatch.setenv('N_JOBS_PER_WORKER', '2')
    monkeypatch.setenv('AI_INPUT_POINTS_PER_1K', '1')
    monkeypatch.setenv('AI_OUTPUT_POINTS_PER_1K', '3')
    service, reference, model = await setup_api(monkeypatch, [parsed()] * 5)
    cards = await issue(service.db, 2)
    accounts = []
    for number, card in zip(('13800138000', '13900139000'), cards, strict=True):
        await saas.redeem(CardRedeem(phone=number, card=card))
        accounts.append(await saas.identity(number, card))
    entered, release = asyncio.Event(), asyncio.Event()
    original = type(model).with_structured_output
    def output(self, schema, **kwargs):
        target = original(self, schema, **kwargs)
        async def invoke(messages, config):
            if (execution.CURRENT_EXECUTION.get() or {}).get('accountId') == accounts[0] and not entered.is_set():
                entered.set()
                await release.wait()
            return await target.ainvoke(messages, config=config)
        return RunnableLambda(invoke)
    monkeypatch.setattr(type(model), 'with_structured_output', output)
    token = saas.ACCOUNT.set(accounts[0])
    try:
        await saas.register_upload(DocumentReference.model_validate(reference))
        first = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
        await asyncio.wait_for(entered.wait(), 10)
        backlog = [await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference))) for _ in range(3)]
        # An already published backlog message is safely returned to the outbox too.
        assert await service.deliver(backlog[0]['runId'])
        assert backlog[0]['runId'] not in service.active
        saas.ACCOUNT.set(accounts[1])
        await saas.register_upload(DocumentReference.model_validate(reference))
        other = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
        async with asyncio.timeout(5):
            while (await task_api.get_task(other['threadId']))['state'] != 'COMPLETED':
                await asyncio.sleep(.02)
        assert first['runId'] in service.active and not release.is_set()
        assert not any(item['runId'] in service.active for item in backlog)
        release.set()
        await service.wait_idle()
        assert len(model.calls) == 5 and not service.account_runs
        for account in accounts:
            saas.ACCOUNT.set(account)
            assert all(item['state'] == 'COMPLETED' for item in (await task_api.list_tasks())['items'])
    finally:
        release.set()
        saas.ACCOUNT.reset(token)


@pytest.mark.usefixtures('disposable_databases')
async def test_account_deferral_survives_publication_confirm_after_its_delivery(monkeypatch):
    from practiq_ai import messaging, runtime
    monkeypatch.setenv('AI_INPUT_POINTS_PER_1K', '1')
    monkeypatch.setenv('AI_OUTPUT_POINTS_PER_1K', '3')
    completed, cleanup = asyncio.Event(), asyncio.Event()
    deferred, confirmed = asyncio.Event(), asyncio.Event()
    original_execute = runtime.Service.execute
    async def execute(self, run):
        await original_execute(self, run)
        if not completed.is_set():
            completed.set()
            await cleanup.wait()
    monkeypatch.setattr(runtime.Service, 'execute', execute)
    service, reference, model = await setup_api(monkeypatch, [parsed(), parsed()])
    card = (await issue(service.db))[0]
    await saas.redeem(CardRedeem(phone='13800138000', card=card))
    account = await saas.identity('13800138000', card)
    token = saas.ACCOUNT.set(account)
    second = None
    original_deliver, original_publish, original_wait = service.deliver, messaging.publish, service.delivery.wait
    async def deliver(run_id):
        result = await original_deliver(run_id)
        if second and run_id == second['runId'] and result and not cleanup.is_set():
            deferred.set()
        return result
    async def publish(channel, run_id):
        await original_publish(channel, run_id)
        if second and run_id == second['runId'] and not cleanup.is_set():
            await asyncio.wait_for(deferred.wait(), 5)
    async def wait(seconds):
        if deferred.is_set():
            confirmed.set()
        await original_wait(seconds)
    monkeypatch.setattr(service, 'deliver', deliver)
    monkeypatch.setattr(messaging, 'publish', publish)
    monkeypatch.setattr(service.delivery, 'wait', wait)
    try:
        await saas.register_upload(DocumentReference.model_validate(reference))
        await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
        await asyncio.wait_for(completed.wait(), 10)
        second = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
        await asyncio.wait_for(confirmed.wait(), 10)
        assert (await service.db.rows('SELECT published_at FROM document_outbox WHERE run_id=%s', (second['runId'],)))[0]['published_at'] is None
        cleanup.set()
        await service.wait_idle()
        assert (await task_api.get_task(second['threadId']))['state'] == 'COMPLETED'
        assert len(model.calls) == 2 and not service.account_runs
    finally:
        cleanup.set()
        saas.ACCOUNT.reset(token)


@pytest.mark.usefixtures('disposable_databases')
async def test_provider_failure_pauses_unknown_usage_and_manual_resolution_does_not_invent_output(monkeypatch):
    monkeypatch.setenv('AI_INPUT_POINTS_PER_1K', '1')
    monkeypatch.setenv('AI_OUTPUT_POINTS_PER_1K', '3')
    service, reference, model = await setup_api(monkeypatch, [RuntimeError('uncertain provider response'), parsed()])
    card = (await issue(service.db))[0]
    await saas.redeem(CardRedeem(phone='13800138000', card=card))
    account = await saas.identity('13800138000', card)
    token = saas.ACCOUNT.set(account)
    try:
        await saas.register_upload(DocumentReference.model_validate(reference))
        receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
        await service.wait_idle()
        detail = await task_api.get_task(receipt['threadId'])
        assert detail['state'] == 'PAUSED' and detail['billing']['usageUnknown']
        assert not detail['canExportCompleted'] and not detail['failures']
        key = (await service.db.rows("SELECT call_key FROM import_calls WHERE status='unknown'"))[0]['call_key']
        monkeypatch.setattr(saas_manage, 'Database', lambda: Database(service.db.uri))
        resolve = Namespace(action='resolve', call_key=key, input_tokens=10, output_tokens=5, note='Verified provider receipt')
        await saas_manage.run(resolve)
        await saas_manage.run(resolve)
        resolve.input_tokens = 11
        with pytest.raises(ValueError):
            await saas_manage.run(resolve)
        after = await task_api.get_task(receipt['threadId'])
        assert after['state'] == 'PAUSED' and after['result'] is None and len(model.calls) == 1
        await task_api.control_task(receipt['threadId'], DocumentTaskControl(requestId=uuid4(), action='resume', checkpointId=after['checkpointId']))
        await service.wait_idle()
        assert (await task_api.get_task(receipt['threadId']))['state'] == 'COMPLETED'
        assert len(model.calls) == 2 and (await saas.account_summary(account))['balanceMicropoints'] == 950_000
    finally:
        saas.ACCOUNT.reset(token)


@pytest.mark.usefixtures('disposable_databases')
async def test_account_queue_quota_is_atomic_replays_receipts_and_preserves_other_accounts(monkeypatch):
    from practiq_ai import messaging
    monkeypatch.setenv('AI_ACCOUNT_MAX_PENDING_RUNS', '2')
    monkeypatch.setenv('AI_MAX_BUSY_THREADS', '3')
    monkeypatch.setenv('AI_INPUT_POINTS_PER_1K', '1')
    monkeypatch.setenv('AI_OUTPUT_POINTS_PER_1K', '3')
    service, reference, _ = await setup_api(monkeypatch)
    release = asyncio.Event()
    original_publish = messaging.publish

    async def blocked_publish(channel, run_id):
        await release.wait()
        await original_publish(channel, run_id)

    monkeypatch.setattr(messaging, 'publish', blocked_publish)
    cards = await issue(service.db, 2)
    accounts = []
    for number, card in zip(('13800138000', '13900139000'), cards, strict=True):
        await saas.redeem(CardRedeem(phone=number, card=card))
        accounts.append(await saas.identity(number, card))
    async with service.db.transaction() as conn:
        await saas.credit(conn, accounts[0], -1_000_000, 'model', 'depleted')
    token = saas.ACCOUNT.set(accounts[0])
    try:
        await saas.register_upload(DocumentReference.model_validate(reference))
        requests = [DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)) for _ in range(4)]
        results = await asyncio.gather(*(task_api.create_task(r) for r in requests), return_exceptions=True)
        accepted = [(r, result) for r, result in zip(requests, results, strict=True) if isinstance(result, dict)]
        denied = [result for result in results if isinstance(result, DocumentProcessingError)]
        assert len(accepted) == len(denied) == 2
        assert all(error.code == 'ACCOUNT_QUEUE_FULL' and error.status_code == 429 for error in denied)
        assert await task_api.create_task(accepted[0][0]) == accepted[0][1]
        rows = await service.db.rows('SELECT count(*) AS n FROM document_tasks WHERE account_id=%s', (accounts[0],))
        assert rows[0]['n'] == 2
        saas.ACCOUNT.set(accounts[1])
        await saas.register_upload(DocumentReference.model_validate(reference))
        other = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
        assert other['accepted']
    finally:
        saas.ACCOUNT.reset(token)
        release.set()
    await service.wait_idle()


@pytest.mark.usefixtures('disposable_databases')
async def test_balance_bounds_reject_redemption_and_settlement_without_partial_accounting(monkeypatch):
    service, _, _ = await setup_api(monkeypatch)
    first, extra = await issue(service.db, 2, amount=1)
    await saas.redeem(CardRedeem(phone='13800138000', card=first))
    account = await saas.identity('13800138000', first)
    async with service.db.transaction() as conn:
        await saas.credit(conn, account, saas.BIGINT_MAX - 1, 'adjust', 'upper-bound')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url='http://test') as http:
        result = await http.post('/api/cards/redeem', json={'phone': '13800138000', 'card': extra, 'boundCard': first})
        assert result.status_code == 409 and result.json()['detail']['code'] == 'POINT_BALANCE_LIMIT'
    assert (await service.db.rows('SELECT account_id FROM import_cards WHERE digest=%s', (saas.digest(extra),)))[0]['account_id'] is None
    async with service.db.transaction() as conn:
        # Idempotent replay remains valid even at the balance ceiling.
        await saas.credit(conn, account, saas.BIGINT_MAX - 1, 'adjust', 'upper-bound')
        await saas.credit(conn, account, -saas.BIGINT_MAX, 'adjust', 'zero')
        await saas.credit(conn, account, saas.BIGINT_MIN, 'adjust', 'lower-bound')
        await conn.execute("INSERT INTO import_calls(call_key,account_id,thread_id,rates,status,dispatched) VALUES(%s,%s,%s,%s,'unknown',true)",
                           ('overflow-call', account, str(uuid4()), json.dumps({'inputMicropointsPer1k': 1000, 'outputMicropointsPer1k': 1000})))
    with pytest.raises(DocumentProcessingError, match='Point balance limit'):
        await saas.settle('overflow-call', {'inputTokens': 1, 'outputTokens': 0})
    assert (await saas.account_summary(account))['balanceMicropoints'] == saas.BIGINT_MIN
    assert (await saas.account_summary(account))['usageUnknown']
    assert not await service.db.rows("SELECT 1 FROM import_ledger WHERE reference='overflow-call'")
    with pytest.raises(DocumentProcessingError, match='Point balance limit'):
        async with service.db.transaction() as conn:
            await saas.credit(conn, account, saas.BIGINT_MAX + 1, 'adjust', 'oversized-amount')
    await saas.redeem(CardRedeem(phone='13800138000', card=extra, boundCard=first))
    await saas.settle('overflow-call', {'inputTokens': 1, 'outputTokens': 0})
    assert (await saas.account_summary(account))['balanceMicropoints'] == saas.BIGINT_MIN
    assert not (await saas.account_summary(account))['usageUnknown']
    assert len(await service.db.rows("SELECT 1 FROM import_ledger WHERE reference='overflow-call'")) == 1


@pytest.mark.usefixtures('disposable_databases')
@pytest.mark.parametrize('stage', ['checkpoint', 'store'])
async def test_customer_can_retry_failed_delete_without_losing_ownership(monkeypatch, stage):
    monkeypatch.setenv('AI_INPUT_POINTS_PER_1K', '1')
    monkeypatch.setenv('AI_OUTPUT_POINTS_PER_1K', '3')
    service, reference, _ = await setup_api(monkeypatch)
    card = (await issue(service.db))[0]
    await saas.redeem(CardRedeem(phone='13800138000', card=card))
    account = await saas.identity('13800138000', card)
    token = saas.ACCOUNT.set(account)
    try:
        await saas.register_upload(DocumentReference.model_validate(reference))
        receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
        await service.wait_idle()
        with monkeypatch.context() as patch:
            target = service.db.checkpointer if stage == 'checkpoint' else service.db.store
            method = 'adelete_thread' if stage == 'checkpoint' else 'adelete'
            patch.setattr(target, method, AsyncMock(side_effect=OSError('cleanup interrupted')))
            with pytest.raises(OSError, match='cleanup interrupted'):
                await task_api.delete_task(receipt['threadId'])
        assert (await service.db.rows('SELECT account_id FROM document_tasks WHERE thread_id=%s', (receipt['threadId'],)))[0]['account_id'] == account
        saas.ACCOUNT.set(str(uuid4()))
        with pytest.raises(DocumentProcessingError, match='Task not found'):
            await task_api.delete_task(receipt['threadId'])
        saas.ACCOUNT.set(account)
        assert await task_api.delete_task(receipt['threadId']) == {'deleted': True}
        assert not await service.db.store.asearch(execution.namespace(receipt['threadId'], '')[:2], refresh_ttl=False)
        assert await service.db.checkpointer.aget_tuple({'configurable': {'thread_id': receipt['threadId']}}) is None
        assert len(await service.db.rows("SELECT 1 FROM import_ledger WHERE account_id=%s AND kind='model'", (account,))) == 1
    finally:
        saas.ACCOUNT.reset(token)


@pytest.mark.usefixtures('disposable_databases')
async def test_cancellation_before_dispatch_persists_rejection_and_restarts_without_unknown_call(monkeypatch):
    from practiq_ai import runtime
    from tests.db_support import SERVICES
    monkeypatch.setenv('AI_INPUT_POINTS_PER_1K', '1')
    monkeypatch.setenv('AI_OUTPUT_POINTS_PER_1K', '3')
    service, reference, model = await setup_api(monkeypatch)
    card = (await issue(service.db))[0]
    await saas.redeem(CardRedeem(phone='13800138000', card=card))
    account = await saas.identity('13800138000', card)
    entered = asyncio.Event()
    original_dispatch = saas.dispatched

    async def blocked_dispatch(_key):
        entered.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(saas, 'dispatched', blocked_dispatch)
    token = saas.ACCOUNT.set(account)
    try:
        await saas.register_upload(DocumentReference.model_validate(reference))
        receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
        await asyncio.wait_for(entered.wait(), 10)
        await service.stop(timeout=0)
        await service.db.open()
        await saas.reconcile(service.db)
        calls = await service.db.store.asearch(execution.namespace(receipt['threadId'], 'calls'), refresh_ttl=False)
        assert calls
        run = (await service.db.rows('SELECT * FROM document_runs WHERE run_id=%s', (receipt['runId'],)))[0]
        assert not await service.unknown_calls(run) and not model.calls, (calls, await service.db.rows('SELECT * FROM import_calls'))
        assert (await service.db.rows('SELECT status FROM import_calls')) == [{'status': 'rejected'}]
        monkeypatch.setattr(saas, 'dispatched', original_dispatch)
        restarted = runtime.Service(service.db)
        SERVICES.append(restarted)
        monkeypatch.setattr(runtime, 'current', restarted)
        await restarted.start()
        async with asyncio.timeout(15):
            while (await service.db.rows('SELECT status FROM document_runs WHERE run_id=%s', (receipt['runId'],)))[0]['status'] in {'pending', 'running'}:
                await asyncio.sleep(.02)
        assert (await task_api.get_task(receipt['threadId']))['state'] == 'COMPLETED'
        assert len(model.calls) == 1
        assert len(await service.db.rows("SELECT 1 FROM import_ledger WHERE kind='model'")) == 1
    finally:
        saas.ACCOUNT.reset(token)


@pytest.mark.usefixtures('disposable_databases')
@pytest.mark.parametrize('stage', ['reservation', 'verification'])
async def test_customer_upload_database_outage_is_bounded_503_and_retry_verifies(monkeypatch, tmp_path, stage):
    from contextlib import asynccontextmanager

    from psycopg import OperationalError
    service, _, _ = await setup_api(monkeypatch)
    card = (await issue(service.db))[0]
    await saas.redeem(CardRedeem(phone='13800138000', card=card))
    account = await saas.identity('13800138000', card)
    store = object_store(tmp_path)
    monkeypatch.setattr(webapp, 'get_object_store', lambda: store)
    payload = b'quiz'
    metadata = DocumentUploadRequest(sourceType='text', fileName='quiz.txt', mediaType='text/plain', sizeBytes=len(payload), sha256=hashlib.sha256(payload).hexdigest())
    headers = {'Authorization': 'Card ' + card, 'X-Practiq-Phone': '13800138000', 'Content-Type': 'text/plain'}

    @asynccontextmanager
    async def unavailable():
        raise OperationalError('private connection details')
        yield

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url='http://test') as http:
        with monkeypatch.context() as patch:
            if stage == 'reservation':
                patch.setattr(service.db, 'transaction', unavailable)
            else:
                patch.setattr(saas, 'register_upload', AsyncMock(side_effect=OperationalError('private connection details')))
            response = await http.put('/api/uploads/content', params=metadata.model_dump(exclude_none=True), content=payload, headers=headers)
        assert response.status_code == 503
        assert response.json() == {'detail': {'code': 'TASK_SERVICE_UNAVAILABLE', 'message': 'Task database is unavailable'}}
        assert 'private' not in response.text
        rows = await service.db.rows('SELECT verified FROM import_uploads WHERE account_id=%s', (account,))
        assert rows == ([{'verified': False}] if stage == 'verification' else [])
        retry = await http.put('/api/uploads/content', params=metadata.model_dump(exclude_none=True), content=payload, headers=headers)
        assert retry.status_code == 200
        assert await service.db.rows('SELECT verified FROM import_uploads WHERE account_id=%s', (account,)) == [{'verified': True}]
