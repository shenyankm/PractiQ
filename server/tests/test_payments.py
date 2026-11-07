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
        await conn.execute('DROP TABLE payment_notifications,payment_refunds,payment_orders')
        await conn.execute('UPDATE practiq_schema SET version=6')
    with pytest.raises(RuntimeError, match='Unsupported service schema'):
        await database.check_schema()
    await database.upgrade()
    await database.check_schema()
    assert await database.rows('SELECT * FROM auth_users ORDER BY id') == users
    assert not await database.rows('SELECT * FROM payment_orders')
