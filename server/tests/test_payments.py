"""Payment security and durable recovery with a substitute gateway, never real funds."""
import base64
import json
from types import SimpleNamespace
from urllib.parse import quote_plus
from uuid import uuid4

import httpx
import pytest
from alipay.aop.api.util.SignatureUtils import get_sign_content, sign_with_rsa2
from Crypto.PublicKey import RSA
from fastapi import HTTPException

from practiq_ai import identity, payment_config, payments, runtime, webapp
from tests.db_support import new_database

PASSWORD = 'payment-integration-test-password'


@pytest.fixture
def config(monkeypatch, tmp_path):
    key = RSA.generate(2048)
    app = {'appId': '2026000000000001', 'pid': '2088000000000001',
           'appPrivatePkcsKey': base64.b64encode(key.export_key(format='DER', pkcs=1)).decode(),
           'alipayPublicKey': base64.b64encode(key.public_key().export_key(format='DER')).decode()}
    path = tmp_path / '.alipay-sandbox.json'
    path.write_text(json.dumps({'appIds': [app]}))
    path.chmod(0o600)
    monkeypatch.setattr(payment_config, 'ROOT', tmp_path)
    monkeypatch.setenv('ALIPAY_ENABLED', 'true')
    monkeypatch.setenv('ALIPAY_MODE', 'sandbox')
    monkeypatch.setenv('ALIPAY_BASE_URL', 'http://127.0.0.1:8090')
    monkeypatch.setenv('ALIPAY_AMOUNT', '1.00')
    monkeypatch.delenv('ALIPAY_NOTIFY_URL', raising=False)
    return payment_config.load()


def test_configuration_is_stable_protected_and_separate_from_production(config, monkeypatch):
    monkeypatch.chdir('/')
    assert payment_config.load() == config
    sdk = vars(payments.client(config))['_DefaultAlipayClient__config']
    assert sdk.app_private_key == config.private_key
    assert sdk.alipay_public_key == config.public_key and sdk.app_id == config.app_id
    assert sdk.server_url == payment_config.SANDBOX_GATEWAY and sdk.skip_sign is False
    path = payment_config.ROOT / '.alipay-sandbox.json'
    path.chmod(0o644)
    with pytest.raises(HTTPException, match='PAYMENT_CONFIGURATION_INVALID'):
        payment_config.load()
    path.chmod(0o600)
    monkeypatch.setenv('ALIPAY_MODE', 'production')
    monkeypatch.delenv('ALIPAY_PRODUCTION_CONFIG', raising=False)
    with pytest.raises(HTTPException, match='PAYMENT_CONFIGURATION_INVALID'):
        payment_config.load()


async def test_read_only_deployment_does_not_create_payment_intents(monkeypatch):
    monkeypatch.setenv('AI_READ_ONLY', '1')
    with pytest.raises(HTTPException, match='SERVICE_READ_ONLY'):
        await payments.create(str(uuid4()))


@pytest.mark.parametrize('amount', ['NaN', '1e2', '-1', '0', '1.001', '100000000.01', ' 1', '1\n'])
def test_decimal_amount_rejects_unsafe_values(amount):
    with pytest.raises(ValueError):
        payment_config.cents(amount)


def signed(config, params):
    return {**params, 'sign_type': 'RSA2', 'sign': sign_with_rsa2(config.private_key, get_sign_content(params), 'utf-8')}


def test_actual_sdk_notification_signature_rejects_tampering(config):
    params = signed(config, {'app_id': config.app_id, 'total_amount': '1.00'})
    assert payments.verify_notification(params, config)
    assert not payments.verify_notification({**params, 'total_amount': '0.01'}, config)
    assert not payments.verify_notification({**params, 'sign_type': 'RSA'}, config)


async def test_actual_sdk_checks_response_signature_and_unwraps_business_json(config, monkeypatch):
    import importlib

    from alipay.aop.api.request.AlipayTradeQueryRequest import AlipayTradeQueryRequest
    module = importlib.import_module('alipay.aop.api.DefaultAlipayClient')
    payload = '{"code":"10000","out_trade_no":"test"}'
    signature = sign_with_rsa2(config.private_key, payload, 'utf-8')
    def response(*args):
        return ('{"alipay_trade_query_response":' + payload + ',"sign":' + json.dumps(signature) + '}').encode()
    monkeypatch.setattr(module, 'do_post', response)
    request = AlipayTradeQueryRequest()
    request.biz_content = {'out_trade_no': 'test'}
    assert (await payments.execute(config, request))['out_trade_no'] == 'test'
    payload = '{"code":"10000","out_trade_no":"tampered"}'
    with pytest.raises(HTTPException, match='PAYMENT_RESULT_UNKNOWN'):
        await payments.execute(config, request)


@pytest.fixture
async def account(disposable_databases, monkeypatch, config):
    database = await new_database()
    monkeypatch.setattr(runtime, 'current', SimpleNamespace(db=database))
    password_hash = await identity.password_hash(PASSWORD)
    async with database.transaction() as conn:
        for user, role in [('alice', 'admin'), ('bob', 'user')]:
            await conn.execute('INSERT INTO auth_users(id,email,password_hash,role) VALUES(%s,%s,%s,%s)', (user, user + '@example.test', password_hash, role))
            await conn.execute("INSERT INTO auth_sessions(digest,user_id,expires_at) VALUES(%s,%s,now()+interval '1 day')", (identity.digest(user), user))
    real_client = payments.client(config)
    class Gateway:
        state = 'WAIT_BUYER_PAY'
        amount = '1.00'
        refund_calls = 0
        uncertain = False
        refund_success = False
        buyer_amount = '1.00'
        def page_execute(self, request, method):
            return real_client.page_execute(request, method)
        def execute(self, request):
            params = request.get_params()
            body = json.loads(params['biz_content'])
            order = body['out_trade_no']
            result = {'code': '10000', 'out_trade_no': order, 'trade_no': 'trade-' + order, 'total_amount': self.amount, 'trade_status': self.state}
            result['buyer_pay_amount'] = self.buyer_amount
            if params['method'] == 'alipay.trade.refund':
                self.refund_calls += 1
                if self.uncertain:
                    raise TimeoutError('substitute provider timeout')
                result['fund_change'] = 'N'
            if params['method'] == 'alipay.trade.fastpay.refund.query':
                result.update(out_request_no=body['out_request_no'], refund_amount='0.40', refund_status='REFUND_SUCCESS' if self.refund_success else 'REFUND_PROCESSING')
            if params['method'] == 'alipay.trade.close':
                self.state = 'TRADE_CLOSED'
            return json.dumps(result)
    gateway = Gateway()
    monkeypatch.setattr(payments, 'client', lambda config: gateway)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url='http://test', cookies={'practiq_session': 'alice'}, headers={'X-CSRF-Token': identity.csrf('alice')}) as client:
        yield database, client, gateway


async def create(client):
    request_id = str(uuid4())
    response = await client.post('/api/me/payments', json={'requestId': request_id})
    assert response.status_code == 200, response.text
    return response.json(), request_id


async def test_order_ownership_csrf_idempotency_and_server_price(account, config):
    database, client, _ = account
    assert (await client.post('/api/me/payments', json={'requestId': str(uuid4()), 'amount': '0.01'})).status_code == 422
    result, request_id = await create(client)
    assert result['order']['requestId'] == request_id
    assert (await client.get('/api/me/payments')).json()[0]['requestId'] == request_id
    assert result['order']['amount'] == '1.00' and config.private_key not in result['paymentHtml']
    assert '<form' in result['paymentHtml'] and quote_plus(config.return_url) in result['paymentHtml']
    assert 'notify_url' not in result['paymentHtml']
    repeated = await client.post('/api/me/payments', json={'requestId': request_id})
    assert repeated.json()['order']['id'] == result['order']['id']
    assert (await client.post('/api/me/payments', json={'requestId': str(uuid4())})).status_code == 409
    assert (await client.post('/api/me/payments', json={'requestId': request_id}, headers={'X-CSRF-Token': ''})).status_code == 403
    client.cookies.set('practiq_session', 'bob')
    client.headers['X-CSRF-Token'] = identity.csrf('bob')
    path = '/api/me/payments/' + result['order']['id']
    assert (await client.get(path)).status_code == 404
    assert (await client.post(path + '/query')).status_code == 404
    assert (await client.post('/api/admin/payments/' + result['order']['id'] + '/refunds', json={})).status_code == 403
    assert await database.rows('SELECT count(*) AS n FROM payment_orders') == [{'n': 1}]


async def test_signed_notifications_are_atomic_and_non_payment_events_do_not_deliver(account, config):
    database, client, _ = account
    result, _ = await create(client)
    order = result['order']['id']
    fields = {'app_id': config.app_id, 'seller_id': config.seller_id, 'out_trade_no': order, 'trade_no': 'trade-' + order, 'total_amount': '1.00', 'trade_status': 'TRADE_SUCCESS', 'notify_type': 'trade_status_sync', 'notify_id': 'notice-one'}
    assert (await client.post('/payments/notify', data=signed(config, {**fields, 'seller_id': '2088000000000002'}))).text == 'fail'
    assert (await client.post('/payments/notify', data=signed(config, {**fields, 'out_biz_no': 'refund'}))).text == 'success'
    assert (await client.get('/api/me/payments/' + order)).json()['state'] == 'UNKNOWN'
    payload = signed(config, {**fields, 'notify_id': 'notice-two'})
    for _ in range(2):
        assert (await client.post('/payments/notify', data=payload)).text == 'success'
    assert (await client.get('/api/me/payments/' + order)).json()['state'] == 'PAID'
    assert await database.rows('SELECT count(*) AS n FROM payment_notifications') == [{'n': 2}]
    assert (await client.post('/payments/notify', data={**payload, 'total_amount': '0.01'})).text == 'fail'
    assert (await client.post('/payments/notify', content=b'x' * 65537)).status_code == 413


async def test_query_validates_amount_and_background_restores_unresolved_orders(account):
    database, client, gateway = account
    result, _ = await create(client)
    order = result['order']['id']
    path = '/api/me/payments/' + order
    gateway.amount = '0.01'
    assert (await client.post(path + '/query')).status_code == 409
    assert (await client.get(path)).json()['state'] == 'UNKNOWN'
    gateway.amount, gateway.state = '1.00', 'TRADE_SUCCESS'
    await payments.reconcile_once()
    assert (await client.get(path)).json()['state'] == 'PAID'
    gateway.state = 'WAIT_BUYER_PAY'
    assert (await client.post(path + '/query')).json()['state'] == 'PAID'
    assert not await database.rows('SELECT 1 FROM auth_calls')


async def test_refund_unknown_replay_and_cumulative_reservation(account):
    database, client, gateway = account
    result, _ = await create(client)
    order = result['order']['id']
    gateway.state = 'TRADE_SUCCESS'
    gateway.uncertain = True
    path = '/api/admin/payments/' + order + '/refunds'
    body = {'requestId': str(uuid4()), 'amount': '0.40', 'reason': 'test refund', 'currentPassword': PASSWORD}
    assert (await client.post(path, json=body)).status_code == 503
    assert (await client.post(path, json=body)).json()['state'] == 'UNKNOWN'
    assert gateway.refund_calls == 1


    assert (await client.post(path, json={**body, 'amount': '0.50'})).status_code == 409
    assert (await client.post(path, json={**body, 'requestId': str(uuid4()), 'amount': '0.70'})).status_code == 409
    gateway.refund_success = True
    async with database.transaction() as conn:
        await conn.execute("UPDATE payment_refunds SET next_check=now()-interval '1 second',created_at=now()-interval '11 seconds'")
    await payments.reconcile_once()
    assert (await client.post(path + '/' + body['requestId'] + '/query')).json()['state'] == 'SUCCESS'
    assert gateway.refund_calls == 1


async def test_refund_cannot_exceed_actual_buyer_payment(account):
    _, client, gateway = account
    result, _ = await create(client)
    gateway.state, gateway.buyer_amount = 'TRADE_SUCCESS', '0.50'
    path = '/api/admin/payments/' + result['order']['id'] + '/refunds'
    body = {'requestId': str(uuid4()), 'amount': '0.60', 'reason': 'test refund', 'currentPassword': PASSWORD}
    assert (await client.post(path, json=body)).status_code == 409
    assert gateway.refund_calls == 0


async def test_close_requires_pending_query_and_return_shell_never_accepts_success_parameters(account):
    _, client, _ = account
    result, _ = await create(client)
    path = '/api/me/payments/' + result['order']['id']
    assert (await client.post(path + '/close')).json()['state'] == 'CLOSED'
    page = await client.get('/payments/return?trade_status=TRADE_SUCCESS')
    assert page.status_code == 200 and '正在确认支付结果' in page.text
    assert 'form-action https://openapi-sandbox' in page.headers['Content-Security-Policy']
    assert (await client.get(path)).json()['state'] == 'CLOSED'


async def test_offline_schema_six_upgrade_preserves_users_and_requires_complete_tables(account):
    database, _, _ = account
    users = await database.rows('SELECT * FROM auth_users ORDER BY id')
    async with database.transaction() as conn:
        await conn.execute('DROP TABLE page_allocations,page_grants')
        await conn.execute('DROP TABLE payment_notifications,payment_refunds,payment_orders')
        await conn.execute('UPDATE practiq_schema SET version=6')
    with pytest.raises(RuntimeError, match='Unsupported service schema'):
        await database.check_schema()
    await database.upgrade()
    await database.check_schema()
    assert await database.rows('SELECT * FROM auth_users ORDER BY id') == users
    assert not await database.rows('SELECT * FROM payment_orders')


@pytest.fixture
async def production(account, config, monkeypatch):
    from dataclasses import replace

    from practiq_ai import payment_api
    configured = replace(config, mode='production')
    monkeypatch.setattr(payments, 'load', lambda: configured)
    monkeypatch.setattr(payment_api, 'load', lambda: configured)
    return account


async def purchase(client, product_id):
    response = await client.post('/api/me/payments', json={'requestId': str(uuid4()), 'productId': product_id})
    assert response.status_code == 200, response.text
    return response.json()['order']


async def test_catalog_remains_visible_without_checkout_and_has_exact_agreed_prices(account, monkeypatch):
    _, client, _ = account
    monkeypatch.delenv('ALIPAY_ENABLED')
    result = (await client.get('/api/me/plans')).json()
    assert result['checkoutEnabled'] is False and result['environment'] is None
    assert [(p['id'], p['amount'], p['pages'], p['durationDays'], p['activeTasks']) for p in result['products']] == [
        ('free', '0.00', 50, None, 1), ('plus', '39.00', 100, 30, 2), ('pro', '99.00', 300, 30, 3), ('pages50', '19.90', 50, 365, 1)]
    assert result['balance']['remainingPages'] == 50
    assert (await client.post('/api/me/payments', json={'requestId': str(uuid4()), 'productId': 'plus'})).status_code == 503


@pytest.mark.parametrize(('sku', 'amount', 'pages', 'days'), [('plus', '39.00', 100, 30), ('pro', '99.00', 300, 30), ('pages50', '19.90', 50, 365)])
async def test_verified_production_query_grants_once_and_preserves_order_product(production, sku, amount, pages, days):
    database, client, gateway = production
    order = await purchase(client, sku)
    assert order['amount'] == amount and order['productId'] == sku
    assert not await database.rows('SELECT * FROM page_grants')
    gateway.amount = gateway.buyer_amount = amount
    gateway.state = 'TRADE_SUCCESS'
    for _ in range(2):
        assert (await client.post('/api/me/payments/' + order['id'] + '/query')).status_code == 200
    grants = await database.rows('SELECT * FROM page_grants')
    assert len(grants) == 1 and (grants[0]['expires_at'] - grants[0]['starts_at']).days == days
    result = (await client.get('/api/me/plans')).json()['balance']
    assert result['remainingPages'] == 50 + pages and result['freeRemainingPages'] == 50
    assert result['plan'] == (sku if sku != 'pages50' else 'free')
    replay = await client.post('/api/me/payments', json={'requestId': order['requestId'], 'productId': 'pro' if sku != 'pro' else 'plus'})
    assert replay.status_code == 409
    assert (await client.get('/api/me/usage')).json()['remainingPages'] == 50 + pages
    assert not await database.rows('SELECT * FROM auth_calls')


async def test_signed_production_notify_is_atomic_and_sandbox_never_grants(account, production, config):
    database, client, gateway = production
    order = await purchase(client, 'plus')
    fields = {'app_id': config.app_id, 'seller_id': config.seller_id, 'out_trade_no': order['id'],
              'trade_no': 'trade-' + order['id'], 'total_amount': '39.00', 'trade_status': 'TRADE_SUCCESS',
              'notify_type': 'trade_status_sync', 'notify_id': 'plan-notice'}
    assert (await client.post('/payments/notify', data=signed(config, {**fields, 'total_amount': '0.01'}))).text == 'fail'
    for _ in range(2):
        assert (await client.post('/payments/notify', data=signed(config, fields))).text == 'success'
    assert len(await database.rows('SELECT * FROM page_grants')) == 1
    gateway.amount = gateway.buyer_amount = '39.00'
    gateway.state = 'TRADE_SUCCESS'
    await payments.reconcile_once()
    assert len(await database.rows('SELECT * FROM page_grants')) == 1
    client.cookies.set('practiq_session', 'bob')
    client.headers['X-CSRF-Token'] = identity.csrf('bob')
    assert (await client.get('/api/me/plans')).json()['balance']['remainingPages'] == 50
    assert (await client.get('/api/me/payments/' + order['id'])).status_code == 404


async def test_sandbox_paid_receipts_do_not_change_real_page_allowances(account):
    database, client, gateway = account
    order = await purchase(client, 'pro')
    assert order['amount'] == '1.00'
    gateway.state = 'TRADE_SUCCESS'
    await client.post('/api/me/payments/' + order['id'] + '/query')
    assert not await database.rows('SELECT * FROM page_grants')
    assert (await client.get('/api/me/plans')).json()['balance']['remainingPages'] == 50


async def task_scope(database):
    task = str(uuid4())
    async with database.transaction() as conn:
        await conn.execute("INSERT INTO document_tasks(thread_id,request_hash,graph_id,document,failure_policy,expires_at,owner_id) VALUES(%s,'x','document_parser','{}','return_partial',now()+interval '1 day','alice')", (task,))
    return 'task:' + task


async def paid_plan(client, gateway, sku='plus'):
    order = await purchase(client, sku)
    gateway.amount = gateway.buyer_amount = order['amount']
    gateway.state = 'TRADE_SUCCESS'
    assert (await client.post('/api/me/payments/' + order['id'] + '/query')).status_code == 200
    return order


async def test_expiring_paid_pages_are_used_before_free_and_unknown_reservations_are_retained(production):
    database, client, gateway = production
    order = await paid_plan(client, gateway)
    scope = await task_scope(database)
    receipt = {}
    await identity.reserve(scope, 'paid-reservation', 'tencentCalls', receipt, pages=120)
    state = (await client.get('/api/me/plans')).json()['balance']
    assert (state['freeUsedPages'], state['freeRemainingPages'], state['remainingPages']) == (20, 30, 30)
    assert state['grants'][0]['usedPages'] == 100
    await identity.record_call('paid-reservation', {**receipt, 'taskId': 'unknown-submission'})
    await identity.release('paid-reservation')
    assert (await client.get('/api/me/plans')).json()['balance']['remainingPages'] == 30
    # A terminal known page count releases excess reservations, including the free tail.
    await identity.record_call('paid-reservation', {**receipt, 'quotaPages': 40})
    state = (await client.get('/api/me/plans')).json()['balance']
    assert (state['freeUsedPages'], state['grants'][0]['usedPages'], state['remainingPages']) == (0, 40, 110)
    # An older response cannot enlarge a settled reservation.
    await identity.record_call('paid-reservation', receipt)
    assert (await client.get('/api/me/plans')).json()['balance']['remainingPages'] == 110
    async with database.transaction() as conn:
        await conn.execute("UPDATE page_grants SET expires_at=now()-interval '1 second' WHERE order_id=%s", (order['id'],))
    state = (await client.get('/api/me/plans')).json()['balance']
    assert state['plan'] == 'free' and state['remainingPages'] == 50 and state['grants'][0]['state'] == 'expired'


async def test_atomic_concurrent_reservations_cannot_overdraw_paid_or_free_pages(production):
    import asyncio

    from practiq_ai.errors import DocumentProcessingError
    database, client, gateway = production
    await paid_plan(client, gateway)
    scope = await task_scope(database)
    result = await asyncio.gather(identity.reserve(scope, 'first-spend', 'tencentCalls', {}, pages=100), identity.reserve(scope, 'second-spend', 'tencentCalls', {}, pages=100), return_exceptions=True)
    assert sum(isinstance(item, DocumentProcessingError) for item in result) == 1
    assert (await client.get('/api/me/plans')).json()['balance']['remainingPages'] == 50
    await identity.release('first-spend')
    await identity.release('second-spend')
    assert (await client.get('/api/me/plans')).json()['balance']['remainingPages'] == 150


async def test_refund_freezes_unused_entitlement_before_unknown_provider_write(production):
    database, client, gateway = production
    order = await paid_plan(client, gateway)
    gateway.uncertain = True
    body = {'requestId': str(uuid4()), 'amount': '39.00', 'reason': 'unused plan', 'currentPassword': PASSWORD}
    path = '/api/admin/payments/' + order['id'] + '/refunds'
    assert (await client.post(path, json=body)).status_code == 503
    assert (await client.post(path, json=body)).json()['state'] == 'UNKNOWN'
    assert gateway.refund_calls == 1
    state = (await client.get('/api/me/plans')).json()['balance']
    assert state['plan'] == 'free' and state['remainingPages'] == 50 and state['grants'][0]['state'] == 'refund_pending'
    # A verified refund query revokes the frozen grant, without deleting practice data.
    async with database.transaction() as conn:
        await conn.execute("UPDATE payment_refunds SET created_at=now()-interval '11 seconds'")
    from unittest.mock import AsyncMock
    # Exercise the verified provider-response path, not a direct grant mutation.
    execute = AsyncMock(return_value={'code': '10000', 'refund_status': 'REFUND_SUCCESS', 'out_trade_no': order['id'], 'trade_no': 'trade-' + order['id'], 'out_request_no': body['requestId'], 'refund_amount': '39.00'})
    import unittest.mock
    with unittest.mock.patch.object(payments, 'execute', execute):
        assert (await client.post(path + '/' + body['requestId'] + '/query')).json()['state'] == 'SUCCESS'
    assert (await client.get('/api/me/plans')).json()['balance']['grants'][0]['state'] == 'refunded'


async def test_used_or_partially_refunded_plan_cannot_start_refund(production):
    database, client, gateway = production
    order = await paid_plan(client, gateway)
    body = {'requestId': str(uuid4()), 'amount': '1.00', 'reason': 'partial', 'currentPassword': PASSWORD}
    path = '/api/admin/payments/' + order['id'] + '/refunds'
    assert (await client.post(path, json=body)).status_code == 409
    await identity.reserve(await task_scope(database), 'used-plan', 'tencentCalls', {}, pages=1)
    assert (await client.post(path, json={**body, 'amount': '39.00'})).status_code == 409
    assert gateway.refund_calls == 0 and not await database.rows('SELECT * FROM payment_refunds')


async def test_plan_repurchase_is_blocked_but_topup_is_independent(production):
    _, client, gateway = production
    await paid_plan(client, gateway)
    response = await client.post('/api/me/payments', json={'requestId': str(uuid4()), 'productId': 'pro'})
    assert response.status_code == 409 and response.json()['detail']['code'] == 'PLAN_ALREADY_ACTIVE'
    await paid_plan(client, gateway, 'pages50')
    state = (await client.get('/api/me/plans')).json()['balance']
    assert state['plan'] == 'plus' and state['activeTasks'] == 2 and state['remainingPages'] == 200


async def test_schema_seven_upgrade_preserves_old_calls_orders_and_free_balance(account):
    database, client, _ = account
    old, _ = await create(client)
    scope = await task_scope(database)
    await identity.reserve(scope, 'old-usage', 'tencentCalls', {}, pages=12)
    before = await database.rows('SELECT * FROM auth_calls')
    async with database.transaction() as conn:
        await conn.execute('DROP TABLE page_allocations,page_grants')
        await conn.execute('ALTER TABLE payment_orders DROP COLUMN product,DROP COLUMN provider_closed')
        await conn.execute('UPDATE practiq_schema SET version=7')
    with pytest.raises(RuntimeError, match='Unsupported service schema'):
        await database.check_schema()
    await database.upgrade()
    await database.check_schema()
    assert await database.rows('SELECT * FROM auth_calls') == before
    assert (await client.get('/api/me/plans')).json()['balance']['remainingPages'] == 38
    assert (await client.get('/api/me/payments/' + old['order']['id'])).json()['productId'] is None
    assert not await database.rows('SELECT * FROM page_grants')


@pytest.mark.parametrize(('sku', 'maximum'), [(None, 1), ('plus', 2), ('pro', 3)])
async def test_plan_concurrency_is_enforced_at_server_admission(production, sku, maximum):
    from practiq_ai.errors import DocumentProcessingError
    database, client, gateway = production
    if sku:
        await paid_plan(client, gateway, sku)
    for _ in range(maximum):
        scope = await task_scope(database)
        async with database.transaction() as conn:
            await identity.admit(conn, {'owner_id': 'alice'})
            await conn.execute("INSERT INTO document_runs(run_id,thread_id,request_id,context) VALUES(%s,%s,'start','{}')", (str(uuid4()), scope[5:]))
    async with database.transaction() as conn:
        with pytest.raises(DocumentProcessingError, match='concurrency limit'):
            await identity.admit(conn, {'owner_id': 'alice'})


async def test_pro_dispatch_has_bounded_priority_and_retained_receipts_do_not_block_new_work(production):
    from practiq_ai.messaging import DISPATCH_SQL
    database, client, gateway = production
    await paid_plan(client, gateway, 'pro')
    ids = []
    for premium in (False, True):
        scope = await task_scope(database)
        run_id = str(uuid4())
        ids.append(run_id)
        async with database.transaction() as conn:
            if not premium:
                await conn.execute("UPDATE document_tasks SET owner_id='bob' WHERE thread_id=%s", (scope[5:],))
            await conn.execute("INSERT INTO document_runs(run_id,thread_id,request_id,context) VALUES(%s,%s,'start','{}')", (run_id, scope[5:]))
            await conn.execute('INSERT INTO document_outbox(run_id) VALUES(%s)', (run_id,))
    assert [r['run_id'] for r in await database.rows(DISPATCH_SQL, (1,))] == [ids[1]]
    async with database.transaction() as conn:
        await conn.execute("UPDATE document_outbox SET created_at=now()-interval '3 minutes' WHERE run_id=%s", (ids[0],))
    assert [r['run_id'] for r in await database.rows(DISPATCH_SQL, (1,))] == [ids[0]]
    async with database.transaction() as conn:
        await conn.execute('UPDATE document_outbox SET published_at=now() WHERE run_id=%s', (ids[0],))
    # A published pending receipt may be dead-lettered; it must not consume a live dispatch slot.
    assert [r['run_id'] for r in await database.rows(DISPATCH_SQL, (1,))] == [ids[1]]
    assert not await database.rows(DISPATCH_SQL, (0,))
    async with database.transaction() as conn:
        await conn.execute("UPDATE document_runs SET status='success' WHERE run_id=%s", (ids[0],))
    assert [r['run_id'] for r in await database.rows(DISPATCH_SQL, (1,))] == [ids[1]]


@pytest.mark.parametrize('via', ['query', 'notification', 'close_before_paid'])
async def test_verified_provider_closure_revokes_grants_and_fences_late_paid_events(production, config, via):
    database, client, gateway = production
    order = await purchase(client, 'plus')
    path = '/api/me/payments/' + order['id']
    gateway.amount = gateway.buyer_amount = '39.00'
    if via != 'close_before_paid':
        gateway.state = 'TRADE_SUCCESS'
        assert (await client.post(path + '/query')).status_code == 200
        assert (await client.get('/api/me/plans')).json()['balance']['remainingPages'] == 150
    fields = {'app_id': config.app_id, 'seller_id': config.seller_id, 'out_trade_no': order['id'],
              'trade_no': 'trade-' + order['id'], 'total_amount': '39.00', 'trade_status': 'TRADE_CLOSED',
              'notify_type': 'trade_status_sync', 'notify_id': 'closed-plan-notice'}
    if via == 'query':
        gateway.state = 'TRADE_CLOSED'
        assert (await client.post(path + '/query')).status_code == 200
    else:
        for _ in range(2):
            assert (await client.post('/payments/notify', data=signed(config, fields))).text == 'success'
    assert (await client.get(path)).json()['providerClosed'] is True
    assert (await client.get('/api/me/plans')).json()['balance']['remainingPages'] == 50
    # Validly signed but late payment success cannot restore an already closed trade.
    assert (await client.post('/payments/notify', data=signed(config, {**fields, 'notify_id': 'late-paid-notice', 'trade_status': 'TRADE_SUCCESS'}))).text == 'success'
    assert (await client.get('/api/me/plans')).json()['balance']['remainingPages'] == 50
    assert (await client.post(path + '/form')).status_code == 409
    assert all(grant['state'] == 'refunded' for grant in await database.rows('SELECT * FROM page_grants'))


async def test_full_unused_plan_refund_uses_verified_buyer_payment_after_discount(production):
    _, client, gateway = production
    order = await purchase(client, 'plus')
    gateway.state, gateway.amount, gateway.buyer_amount, gateway.uncertain = 'TRADE_SUCCESS', '39.00', '0.50', True
    assert (await client.post('/api/me/payments/' + order['id'] + '/query')).status_code == 200
    body = {'requestId': str(uuid4()), 'amount': '0.50', 'reason': 'unused discounted order', 'currentPassword': PASSWORD}
    assert (await client.post('/api/admin/payments/' + order['id'] + '/refunds', json=body)).status_code == 503
    state = (await client.get('/api/me/plans')).json()['balance']
    assert state['remainingPages'] == 50 and state['grants'][0]['state'] == 'refund_pending'


async def test_new_production_orders_require_a_catalog_sku_and_reject_client_fulfillment_fields(production):
    database, client, _ = production
    assert (await client.post('/api/me/payments', json={'requestId': str(uuid4())})).status_code == 422
    assert (await client.post('/api/me/payments', json={'requestId': str(uuid4()), 'productId': 'plus', 'providerClosed': False})).status_code == 422
    assert (await client.post('/api/me/payments', json={'requestId': str(uuid4()), 'productId': 'free'})).status_code == 422
    assert not await database.rows('SELECT * FROM payment_orders')


async def test_admin_order_inspection_is_private_passive_and_retains_refunds(account):
    database, client, gateway = account
    result, _ = await create(client)
    order_id = result['order']['id']
    rows = (await client.get('/api/admin/payments?offset=0')).json()
    assert rows[0]['id'] == order_id and rows[0]['ownerId'] == 'alice'
    assert rows[0]['grant'] is None
    assert not any(key in str(rows) for key in ('password_hash', 'private_key', 'paymentHtml'))
    assert (await client.get('/api/admin/payments/' + order_id)).status_code == 200
    assert gateway.refund_calls == 0
    assert not await database.rows('SELECT * FROM auth_calls')
    client.cookies.set('practiq_session', 'bob')
    client.headers['X-CSRF-Token'] = identity.csrf('bob')
    for path in ('/api/admin/payments', '/api/admin/payments/' + order_id):
        assert (await client.get(path)).status_code == 403
    assert (await client.post('/api/admin/payments/' + order_id + '/query')).status_code == 403
