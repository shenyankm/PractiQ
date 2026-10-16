"""Real PostgreSQL checkout recovery with real RSA signatures; no live payments."""

import asyncio
import base64
import json
from argparse import Namespace
from dataclasses import replace
from typing import Any, cast
from urllib.parse import parse_qsl, urlencode, urlsplit
from uuid import uuid4

import httpx
import pytest
from alipay.aop.api.util import SignatureUtils

from practiq_ai import payment_webapp, payments, payments_manage, saas
from practiq_ai.contracts import PaymentOrderCreate
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.manage import exclusive
from tests.db_support import new_database, seed_account


@pytest.fixture(scope='module')
def keys():
    public, private = SignatureUtils.rsa.newkeys(2048)
    private_pem = private.save_pkcs1().decode().strip()
    # SDK expects SubjectPublicKeyInfo, while rsa emits PKCS1; wrap the DER exactly.
    from pyasn1.codec.der import encoder
    from pyasn1.type import namedtype, univ
    class SubjectPublicKeyInfo(univ.Sequence):
        componentType = namedtype.NamedTypes(namedtype.NamedType('algorithm', univ.Sequence()), namedtype.NamedType('key', univ.BitString()))
    info = SubjectPublicKeyInfo()
    info['algorithm'].setComponentByPosition(0, univ.ObjectIdentifier('1.2.840.113549.1.1.1'))
    info['algorithm'].setComponentByPosition(1, univ.Null(''))
    info['key'] = univ.BitString.fromOctetString(public.save_pkcs1(format='DER'))
    public_pem = '-----BEGIN PUBLIC KEY-----\n' + base64.b64encode(encoder.encode(info)).decode() + '\n-----END PUBLIC KEY-----'
    return private_pem, public_pem


@pytest.fixture
def settings(keys):
    return payments.Settings('2026101400000001', '2088000000000001', keys[0], keys[1],
                             'https://checkout.example/api/payments/notify', 'https://checkout.example/purchase', payments.GATEWAYS['sandbox'])


async def setup(settings):
    db = await new_database()
    await payments.initialize(db, settings)
    async with db.transaction() as conn:
        await conn.execute("INSERT INTO import_products VALUES('pack','Import points',1000000,'https://checkout.example/purchase?product=pack',true)")
        await conn.execute("INSERT INTO payment_products VALUES('pack',900,true)")
    credential = await seed_account(db, balance=0)
    other = await seed_account(db, '13900139000', 0)
    checkout = cast(Any, payments.Checkout(db, settings))
    checkout.account = await saas.identity('13800138000', credential, database=db)
    checkout.credential, checkout.other = credential, other
    return checkout


@pytest.mark.usefixtures('disposable_databases')
async def test_payment_monitoring_reads_durable_evidence_without_crediting_or_exposing_accounts(settings, monkeypatch):
    from practiq_ai import runtime, webapp
    from tests.db_support import SERVICES

    checkout = await setup(settings)
    paid = await checkout.create(PaymentOrderCreate(requestId=uuid4(), productId='pack'), checkout.account)
    refund = await checkout.create(PaymentOrderCreate(requestId=uuid4(), productId='pack'), checkout.account)
    async with checkout.db.transaction() as conn:
        await conn.execute("UPDATE payment_orders SET status='paid',paid_at=now()-interval '15 minutes' WHERE order_id=%s", (paid['orderId'],))
        await conn.execute('UPDATE payment_orders SET refund_evidence=%s::jsonb WHERE order_id=%s', (json.dumps({'refund_fee': '1.00'}), refund['orderId']))
    monitor = runtime.Service(checkout.db)
    await monitor.start()
    SERVICES.append(monitor)
    monkeypatch.setattr(runtime, 'current', monitor)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url='http://test') as client:
        assert (await client.get('/api/metrics')).status_code == 401
        response = await client.get('/api/metrics', headers={'Authorization': 'Bearer test-token'})
        assert response.status_code == 200
        assert 'practiq_payment_uncredited_orders 1\n' in response.text
        assert 'practiq_payment_refund_evidence_orders 1\n' in response.text
        assert all(value not in response.text for value in (checkout.credential, checkout.account, paid['orderId'], refund['orderId']))
        assert await checkout.db.rows("SELECT * FROM import_ledger WHERE kind='purchase'") == []
        await checkout.fulfill(paid['orderId'])
        response = await client.get('/api/metrics', headers={'Authorization': 'Bearer test-token'})
        assert 'practiq_payment_uncredited_orders 0\n' in response.text
        assert 'practiq_payment_uncredited_oldest_seconds 0\n' in response.text
        assert 'practiq_payment_refund_evidence_orders 1\n' in response.text


def result(order, **changes):
    return {'out_trade_no': order['orderId'], 'total_amount': '9.00', 'trade_no': '20261014000000001', 'trade_status': 'TRADE_SUCCESS', **changes}


def notification(settings, order, **changes):
    params = {**result(order), 'app_id': settings.app_id, 'seller_id': settings.seller_id, 'sign_type': 'RSA2', **changes}
    params['sign'] = SignatureUtils.sign_with_rsa2(settings.private_key, SignatureUtils.get_sign_content({k: v for k, v in params.items() if k != 'sign_type'}), 'utf-8')
    return params


def test_settings_are_explicit_fixed_https_and_do_not_expose_keys(settings, monkeypatch):
    values = {'PAYMENT_APP_ID': settings.app_id, 'PAYMENT_SELLER_ID': settings.seller_id, 'PAYMENT_PRIVATE_KEY': settings.private_key,
              'PAYMENT_ALIPAY_PUBLIC_KEY': settings.public_key, 'PAYMENT_NOTIFY_URL': settings.notify_url,
              'PAYMENT_RETURN_URL': settings.return_url, 'PAYMENT_ENVIRONMENT': 'sandbox'}
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    monkeypatch.delenv('PAYMENT_SELLER_EMAIL', raising=False)
    assert payments.Settings.load() == settings
    with monkeypatch.context() as context:
        context.setenv('PAYMENT_SELLER_EMAIL', 'merchant@example.com')
        assert payments.Settings.load().seller_email == 'merchant@example.com'
    assert settings.private_key not in repr(settings)
    for key, value in [('PAYMENT_APP_ID', 'bad'), ('PAYMENT_SELLER_ID', 'bad'), ('PAYMENT_PRIVATE_KEY', ''),
                       ('PAYMENT_ENVIRONMENT', 'unknown'), ('PAYMENT_NOTIFY_URL', 'http://checkout.example'), ('PAYMENT_RETURN_URL', 'https://u:p@checkout.example'),
                       ('PAYMENT_RETURN_URL', 'https://checkout.example?credential=private'),
                       ('PAYMENT_RETURN_URL', 'https://checkout.example/other'),
                       ('PAYMENT_NOTIFY_URL', 'https://checkout.example/api/payments/notify/'),
                       ('PAYMENT_SELLER_EMAIL', ''), ('PAYMENT_SELLER_EMAIL', 'bad\naccount'), ('PAYMENT_SELLER_EMAIL', 'x'*101)]:
        with monkeypatch.context() as context:
            context.setenv(key, value)
            with pytest.raises(ValueError):
                payments.Settings.load()


@pytest.mark.parametrize('value', ['9', '9.001', '-9.00', 'NaN', 9, None, '09.00'])
def test_payment_amounts_reject_noncanonical_values(value):
    with pytest.raises(DocumentProcessingError):
        payments.amount_cents(value)


@pytest.mark.usefixtures('disposable_databases')
async def test_orders_freeze_price_entitlement_and_retries_never_duplicate_credits(settings, monkeypatch):
    service = await setup(settings)
    token = service.account
    request = PaymentOrderCreate(requestId=uuid4(), productId='pack')
    created = await asyncio.gather(*(service.create(request, token) for _ in range(6)))
    assert len({o['orderId'] for o in created}) == 1
    order = created[0]
    async with service.db.transaction() as conn:
        await conn.execute("UPDATE import_products SET points=2000000,name='Changed',enabled=false")
        await conn.execute('UPDATE payment_products SET price_cents=1900,enabled=false')
    assert (await service.create(request, token))['priceCents'] == 900
    await asyncio.gather(*(service.confirm(result(order)) for _ in range(6)))
    fulfilled = service.view(await service.owned(order['orderId'], token))
    assert fulfilled['status'] == 'credited' and fulfilled['creditedMicropoints'] == 1_000_000
    assert len(await service.db.rows("SELECT * FROM import_ledger WHERE kind='purchase'")) == 1
    assert (await service.db.rows('SELECT balance FROM import_accounts WHERE account_id=%s', (token,)))[0]['balance'] == 1_000_000
    assert 'import_cards' not in await service.db.tables()
    fresh = payments.Checkout(service.db, settings)
    assert (await fresh.read(order['orderId'], token))['creditedMicropoints'] == 1_000_000
    await service.confirm(result(order, trade_status='WAIT_BUYER_PAY'))
    await service.confirm(result(order, trade_status='TRADE_CLOSED'))
    assert (await fresh.read(order['orderId'], token))['status'] == 'credited'


@pytest.mark.usefixtures('disposable_databases')
async def test_paid_evidence_survives_failed_fulfillment_and_recovers_after_restart(settings, monkeypatch):
    service = await setup(settings)
    token = service.account
    order = await service.create(PaymentOrderCreate(requestId=uuid4(), productId='pack'), token)
    original = service.fulfill
    async def fail(_):
        raise OSError('simulated fulfillment crash')
    monkeypatch.setattr(service, 'fulfill', fail)
    with pytest.raises(OSError):
        await service.confirm(result(order))
    assert (await service.owned(order['orderId'], token))['status'] == 'paid'
    assert not await service.db.rows("SELECT * FROM import_ledger WHERE kind='purchase'")
    monkeypatch.setattr(service, 'fulfill', original)
    recovered = await payments.Checkout(service.db, settings).read(order['orderId'], token)
    assert recovered['status'] == 'credited'
    assert len(await service.db.rows("SELECT * FROM import_ledger WHERE kind='purchase'")) == 1


@pytest.mark.usefixtures('disposable_databases')
async def test_payment_http_rejects_forged_duplicate_and_other_accounts(settings, monkeypatch):
    service = await setup(settings)
    payment_webapp.app.state.checkout = service
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=payment_webapp.app), base_url='http://test') as http:
        headers = {'Authorization': 'Account ' + service.credential, 'X-Practiq-Phone':'13800138000'}
        request = {'requestId':str(uuid4()),'productId':'pack'}
        assert (await http.post('/api/payments/orders', json=request)).status_code == 401
        assert (await http.post('/api/payments/orders', headers={'Authorization': 'Bearer admin'}, json=request)).status_code == 401
        assert (await http.post('/api/payments/orders', headers=headers, json={**request,'priceCents':1})).status_code == 422
        assert (await http.post('/api/payments/orders', headers=headers, content=b'x'*16385)).status_code == 413
        order = (await http.post('/api/payments/orders', headers=headers, json=request)).json()
        assert (await http.get('/api/payments/products')).json()['items'][0]['pointsMicropoints'] == '1000000'
        assert (await http.get('/api/payments/orders/' + order['orderId'], headers={'Authorization':'Account '+service.other,'X-Practiq-Phone':'13900139000'})).status_code == 404
        link = (await http.post('/api/payments/orders/'+order['orderId']+'/pay', headers=headers)).json()['url']
        params = dict(parse_qsl(urlsplit(link).query))
        assert params['method'] == 'alipay.trade.page.pay'
        assert json.loads(params['biz_content'])['total_amount'] == '9.00'
        assert json.loads(params['biz_content'])['product_code'] == 'FAST_INSTANT_TRADE_PAY'
        unsigned = {key: value for key, value in params.items() if key != 'sign'}
        assert SignatureUtils.verify_with_rsa(settings.public_key, SignatureUtils.get_sign_content(unsigned).encode(), params['sign'])
        valid = notification(settings, order)
        for changes in ({'sign': 'forged'}, {'total_amount': '0.01'}, {'app_id': '2026101400000002'}, {'seller_id': '2088000000000002'}, {'sign_type': 'RSA'}, {'trade_status': 'UNRECOGNIZED'}):
            signed = notification(settings, order, **changes) if 'sign' not in changes else {**valid, **changes}
            assert (await http.post('/api/payments/notify', data=signed)).status_code == 400
        assert (await http.post('/api/payments/notify', content=urlencode(valid)+'&total_amount=0.01', headers={'Content-Type': 'application/x-www-form-urlencoded'})).status_code == 400
        assert (await http.post('/api/payments/notify', json=valid)).status_code == 415
        assert (await http.post('/api/payments/notify', data=valid)).text == 'success'
        assert (await http.post('/api/payments/notify', data=valid)).text == 'success'
        recovered = await http.get('/api/payments/orders/'+order['orderId'], headers=headers)
        assert recovered.json()['status'] == 'credited' and recovered.json()['creditedMicropoints']=='1000000'
        assert recovered.headers['cache-control'] == 'no-store'
        assert (await http.post('/api/payments/orders/'+order['orderId']+'/pay', headers=headers)).status_code == 409
        assert len(await service.db.rows("SELECT * FROM import_ledger WHERE kind='purchase'")) == 1


@pytest.mark.usefixtures('disposable_databases')
async def test_signed_active_query_recovers_lost_notify_and_rejects_tampered_response(settings, monkeypatch):
    service = await setup(settings)
    token = service.account
    order = await service.create(PaymentOrderCreate(requestId=uuid4(), productId='pack'), token)
    body = json.dumps({'code': '10000', **result(order)}, separators=(',', ':'))
    signature = SignatureUtils.sign_with_rsa2(settings.private_key, body, 'utf-8')
    raw = '{"alipay_trade_query_response":'+body+',"sign":'+json.dumps(signature)+'}'
    original_client = httpx.AsyncClient
    def transport(request):
        params = dict(parse_qsl(request.content.decode()))
        assert params['method'] == 'alipay.trade.query'
        return httpx.Response(200, content=raw.encode())
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kwargs: original_client(transport=httpx.MockTransport(transport), **kwargs))
    raw = raw.replace('9.00', '0.01')
    with pytest.raises(DocumentProcessingError, match='Payment query unknown'):
        await service.read(order['orderId'], token)
    assert (await service.owned(order['orderId'], token))['status'] == 'pending'
    async with service.db.transaction() as conn:
        await conn.execute('UPDATE payment_orders SET next_query_at=NULL')
    raw = raw.replace('0.01', '9.00')
    assert (await service.read(order['orderId'], token))['status'] == 'credited'
    with pytest.raises(DocumentProcessingError):
        await service.confirm(result(order, trade_no='20261014000000002'))


@pytest.mark.usefixtures('disposable_databases')
async def test_schema_init_is_explicit_idempotent_identity_bound_and_blocks_live_checkout(settings, monkeypatch):
    service = await setup(settings)
    await payments.initialize(service.db, settings)
    assert await service.db.rows('SELECT version FROM practiq_schema') == [{'version': 4}]
    with pytest.raises(RuntimeError, match='identity mismatch'):
        await payments.initialize(service.db, replace(settings, seller_id='2088000000000002'))
    lease = await service.db.acquire(slot=3)
    try:
        await lease.check()
        with pytest.raises(RuntimeError, match='Stop the payment service'):
            async with exclusive(service.db):
                pytest.fail('Maintenance cannot take payment ownership')
    finally:
        await lease.close()
    monkeypatch.setattr(payments_manage, 'Database', lambda: service.db)
    monkeypatch.setattr(payments.Settings, 'load', lambda: settings)
    await payments_manage.run(Namespace(action='product', product='pack', price_cents=1000, disabled=False))
    assert (await service.db.rows('SELECT price_cents FROM payment_products'))[0]['price_cents'] == 1000

@pytest.mark.usefixtures('disposable_databases')
async def test_invalid_orders_capacity_expiry_closed_recovery_(settings, monkeypatch):
    from datetime import UTC, datetime, timedelta
    from unittest.mock import AsyncMock
    service = await setup(settings)
    token = service.account
    with pytest.raises(DocumentProcessingError, match='Account required'):
        await service.create(PaymentOrderCreate(requestId=uuid4(), productId='pack'), 'bad')
    with pytest.raises(DocumentProcessingError, match='Payment product unavailable'):
        await service.create(PaymentOrderCreate(requestId=uuid4(), productId='missing'), token)
    request = PaymentOrderCreate(requestId=uuid4(), productId='pack')
    order = await service.create(request, token)
    with pytest.raises(DocumentProcessingError, match='Order request conflict'):
        await service.create(PaymentOrderCreate(requestId=request.requestId, productId='other'), token)
    row = await service.owned(order['orderId'], token)
    row['expires_at'] = datetime.now(UTC)-timedelta(seconds=1)
    with pytest.raises(DocumentProcessingError, match='Order not payable'):
        service.pay_url(row)
    for changes in ({'trade_status': 'INVALID'}, {'out_trade_no': None}, {'trade_no': 'bad'}, {'out_trade_no': 'missing'}, {'total_amount': '0.01'}):
        with pytest.raises(DocumentProcessingError):
            await service.confirm(result(order, **changes))
    await service.confirm(result(order, trade_status='TRADE_CLOSED'))
    assert (await service.owned(order['orderId'], token))['status'] == 'closed'
    query = AsyncMock(return_value={'code': '10000', **result(order)})
    monkeypatch.setattr(service, 'query', query)
    assert (await service.read(order['orderId'], token))['status'] == 'credited'
    await service.fulfill('missing')
    async with service.db.transaction() as conn:
        await conn.execute("INSERT INTO payment_orders(order_id,account_id,request_id,product_id,name,price_cents,points,expires_at) SELECT 'capacity_'||n,%s,'request_'||n,'pack','pack',900,1000000,now() FROM generate_series(1,9999) AS n", (service.account,))
    with pytest.raises(DocumentProcessingError, match='Payment order capacity'):
        await service.create(PaymentOrderCreate(requestId=uuid4(), productId='pack'), service.account)


@pytest.mark.usefixtures('disposable_databases')
async def test_query_unknown_not_found_and_throttling_never_credits_points(settings, monkeypatch):
    from unittest.mock import AsyncMock
    service = await setup(settings)
    token = service.account
    order = await service.create(PaymentOrderCreate(requestId=uuid4(), productId='pack'), token)
    query = AsyncMock(return_value={'code': '40004', 'sub_code': 'ACQ.TRADE_NOT_EXIST'})
    monkeypatch.setattr(service, 'query', query)
    assert (await service.read(order['orderId'], token))['status'] == 'pending'
    assert (await service.read(order['orderId'], token))['status'] == 'pending'
    assert query.await_count == 1
    for outcome in ({'code': '40004', 'sub_code': 'UNKNOWN'}, {'code': '10000', **result(order, out_trade_no='other')}):
        async with service.db.transaction() as conn:
            await conn.execute('UPDATE payment_orders SET next_query_at=NULL')
        query.return_value = outcome
        with pytest.raises(DocumentProcessingError, match='Payment query unknown'):
            await service.read(order['orderId'], token)
    assert not await service.db.rows("SELECT * FROM import_ledger WHERE kind='purchase'")


@pytest.mark.parametrize('variant', ['oversize', 'unsigned', 'wrong-envelope', 'extra-field', 'redirect', 'invalid-shape'])
async def test_query_transport_rejects_untrusted_provider_responses(settings, monkeypatch, variant):
    service = payments.Checkout(cast(Any, None), settings)
    body = json.dumps({'code': '10000', 'out_trade_no': 'order'})
    signature = SignatureUtils.sign_with_rsa2(settings.private_key, body, 'utf-8')
    raw = '{"alipay_trade_query_response":'+body+',"sign":'+json.dumps(signature)+'}'
    if variant == 'oversize':
        raw = 'x'*65537
    elif variant == 'unsigned':
        assert isinstance(signature, str)
        raw = raw.replace(signature, 'bad')
    elif variant == 'wrong-envelope':
        raw = raw.replace('alipay_trade_query_response', 'other_response')
    elif variant == 'extra-field':
        raw = raw[:-1]+',"other":"untrusted"}'
    elif variant == 'invalid-shape':
        raw = '{"alipay_trade_query_response":[],"sign":"bad"}'
    original = httpx.AsyncClient
    transport = httpx.MockTransport(lambda _: httpx.Response(302 if variant == 'redirect' else 200, content=raw.encode()))
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kwargs: original(transport=transport, **kwargs))
    with pytest.raises((ValueError, httpx.HTTPStatusError, SignatureUtils.rsa.VerificationError)):
        await service.query('order')


@pytest.mark.usefixtures('disposable_databases')
async def test_checkout_lifespan_has_no_ai_runtime_and_requires_explicit_complete_schema(settings, monkeypatch):
    service = await setup(settings)
    db = service.db
    monkeypatch.setattr(payment_webapp, 'Database', lambda: db)
    monkeypatch.setattr(payments.Settings, 'load', lambda: settings)
    async with payment_webapp.lifespan(payment_webapp.app):
        assert payment_webapp.app.state.checkout.db is db
        with pytest.raises(RuntimeError, match='Another checkout'):
            await db.acquire('Another checkout', slot=3)
        ai_owner = await db.acquire()
        await ai_owner.close()
    await db.open()
    await db.check_schema()
    async with db.transaction() as conn:
        await conn.execute('DROP TABLE payment_orders')
    with pytest.raises(RuntimeError, match='Incomplete payment schema'):
        await payments.initialize(db, settings)


@pytest.mark.usefixtures('disposable_databases')
async def test_operator_reconciliation_recovers_paid_orders_without_printing_credentials(settings, monkeypatch, capsys):
    from unittest.mock import AsyncMock
    service = await setup(settings)
    order = await service.create(PaymentOrderCreate(requestId=uuid4(), productId='pack'), service.account)
    second = await service.create(PaymentOrderCreate(requestId=uuid4(), productId='pack'), service.account)
    async with service.db.transaction() as conn:
        await conn.execute("UPDATE payment_orders SET status='paid',paid_at=now(),trade_no='20261014000000001' WHERE order_id=%s", (order['orderId'],))
    monkeypatch.setattr(payments_manage, 'Database', lambda: service.db)
    monkeypatch.setattr(payments.Settings, 'load', lambda: settings)
    monkeypatch.setattr(payments.Checkout, 'query', AsyncMock(return_value={'code': '10000', **result(second, trade_no='20261014000000002')}))
    await payments_manage.run(Namespace(action='reconcile'))
    await service.db.open()
    assert len(await service.db.rows("SELECT * FROM import_ledger WHERE kind='purchase'")) == 2
    assert service.credential not in capsys.readouterr().out
    for price, product in [(0, 'pack'), (900, 'missing')]:
        with pytest.raises(ValueError):
            await payments_manage.run(Namespace(action='product', product=product, price_cents=price, disabled=False))
        await service.db.open()

async def test_checkout_web_mount_serves_purchase_and_redirects_home_with_security_headers(tmp_path):
    from fastapi import FastAPI

    from practiq_ai.middleware import SecurityHeadersMiddleware
    app = FastAPI()
    app.add_middleware(SecurityHeadersMiddleware)
    app.middleware('http')(payment_webapp.payment_errors)
    payment_webapp.mount_checkout_web(app, tmp_path)
    assert not any(getattr(route, 'path', None) == '/purchase' for route in app.routes)
    (tmp_path / 'index.html').write_text('<html><body>Checkout fixture</body></html>')
    payment_webapp.mount_checkout_web(app, tmp_path)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        root = await client.get('/')
        assert root.status_code == 303 and root.headers['location'] == '/purchase'
        page = await client.get('/purchase')
        assert page.status_code == 200 and 'Checkout fixture' in page.text
        assert page.headers['cache-control'] == 'no-store'
        assert "script-src 'self'" in page.headers['content-security-policy']
        assert (await client.post('/api/document-tasks')).status_code in {404, 405}

@pytest.mark.usefixtures('disposable_databases')
async def test_mid_fulfillment_database_failure_rolls_back_credit_and_preserves_paid_evidence(settings):
    from psycopg.errors import RaiseException
    service = await setup(settings)
    order = await service.create(PaymentOrderCreate(requestId=uuid4(), productId='pack'), service.account)
    async with service.db.transaction() as conn:
        await conn.execute("CREATE FUNCTION fail_fulfillment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='credited' THEN RAISE EXCEPTION 'test fulfillment failure'; END IF; RETURN NEW; END $$")
        await conn.execute('CREATE TRIGGER fail_fulfillment BEFORE UPDATE ON payment_orders FOR EACH ROW EXECUTE FUNCTION fail_fulfillment()')
    with pytest.raises(RaiseException):
        await service.confirm(result(order))
    assert (await service.owned(order['orderId'], service.account))['status'] == 'paid'
    assert not await service.db.rows("SELECT * FROM import_ledger WHERE kind='purchase'")
    async with service.db.transaction() as conn:
        await conn.execute('DROP TRIGGER fail_fulfillment ON payment_orders')
        await conn.execute('DROP FUNCTION fail_fulfillment()')
    restored = await payments.Checkout(service.db, settings).read(order['orderId'], service.account)
    assert restored['status'] == 'credited'
    assert len(await service.db.rows("SELECT * FROM import_ledger WHERE kind='purchase'")) == 1

@pytest.mark.usefixtures('disposable_databases')
async def test_legacy_payment_upgrade_preserves_archive_requires_verified_allocation_and_allows_new_orders(settings, monkeypatch):
    import hashlib
    from pathlib import Path
    service = await setup(settings)
    old_key = '78'*32
    old_identity = hashlib.sha256((settings.app_id+':'+settings.seller_id+':'+settings.gateway).encode()+bytes.fromhex(old_key)).hexdigest()
    async with service.db.transaction() as conn:
        await conn.execute('DROP TABLE payment_orders,payment_products,payment_schema')
        await conn.execute('CREATE TABLE import_cards(digest text PRIMARY KEY)')
        await conn.execute("INSERT INTO import_cards VALUES('archived-card-digest')")
        await conn.execute((Path(__file__).parent/'fixtures/payment-schema-v1.sql').read_text(), prepare=False)
        await conn.execute('INSERT INTO payment_schema VALUES(1,%s)', (old_identity,))
        await conn.execute("INSERT INTO payment_products VALUES('pack',900,true)")
        await conn.execute("INSERT INTO payment_orders(order_id,access_digest,product_id,name,price_cents,points,status,trade_no,expires_at,paid_at,card_digest,fulfilled_at) VALUES('legacy-paid','old-private-digest','pack','pack',900,1000000,'paid','20261014000000001',now(),now(),NULL,NULL), ('legacy-delivered','old-delivery-digest','pack','pack',900,1000000,'fulfilled','20261014000000002',now(),now(),'archived-card-digest',now())")
    monkeypatch.delenv('PAYMENT_CARD_KEY', raising=False)
    with pytest.raises(RuntimeError, match='original PAYMENT_CARD_KEY'):
        await payments.initialize(service.db, settings)
    monkeypatch.setenv('PAYMENT_CARD_KEY', '79'*32)
    with pytest.raises(RuntimeError, match='merchant identity mismatch'):
        await payments.initialize(service.db, settings)
    assert (await service.db.rows('SELECT version FROM payment_schema')) == [{'version':1}]
    monkeypatch.setenv('PAYMENT_CARD_KEY', old_key)
    await payments.initialize(service.db, settings)
    monkeypatch.delenv('PAYMENT_CARD_KEY')
    await payments.initialize(service.db, settings)
    with pytest.raises(DocumentProcessingError, match='Payment account required'):
        await service.fulfill('legacy-paid')
    assert not await service.db.rows("SELECT 1 FROM import_ledger WHERE kind='purchase'")
    monkeypatch.setattr(payments_manage, 'Database', lambda: service.db)
    monkeypatch.setattr(payments.Settings, 'load', lambda: settings)
    for order, note in [('legacy-delivered','Verified owner'),('legacy-paid','')]:
        with pytest.raises(ValueError):
            await payments_manage.run(Namespace(action='bind-legacy',order_id=order,phone='13800138000',note=note))
        await service.db.open()
    await payments_manage.run(Namespace(action='bind-legacy',order_id='legacy-paid',phone='13800138000',note='Verified provider receipt and existing owner'))
    await service.db.open()
    await service.fulfill('legacy-paid')
    await service.fulfill('legacy-paid')
    assert (await service.db.rows('SELECT balance FROM import_accounts WHERE account_id=%s',(service.account,)))[0]['balance']==1_000_000
    assert (await service.db.rows("SELECT status,account_id FROM payment_orders WHERE order_id='legacy-delivered'"))[0]=={'status':'fulfilled','account_id':None}
    assert (await service.db.rows("SELECT allocation_note FROM payment_orders WHERE order_id='legacy-paid'"))[0]['allocation_note'].startswith('Verified provider receipt')
    order = await service.create(PaymentOrderCreate(requestId=uuid4(),productId='pack'),service.account)
    assert order['status']=='pending'
    assert len(await service.db.rows('SELECT * FROM import_cards'))==1

@pytest.mark.usefixtures('disposable_databases')
async def test_orders_list_is_account_scoped_and_invalid_access_never_exposes_balance(settings):
    service = await setup(settings)
    payment_webapp.app.state.checkout = service
    await service.create(PaymentOrderCreate(requestId=uuid4(),productId='pack'),service.account)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=payment_webapp.app),base_url='http://test') as http:
        a={'Authorization':'Account '+service.credential,'X-Practiq-Phone':'13800138000'}
        b={'Authorization':'Account '+service.other,'X-Practiq-Phone':'13900139000'}
        assert len((await http.get('/api/payments/orders',headers=a)).json()['items'])==1
        assert not (await http.get('/api/payments/orders',headers=b)).json()['items']
        for headers in [{'Authorization':'Card '+service.credential,'X-Practiq-Phone':'13800138000'}, {**a,'X-Practiq-Phone':'13900139000'}, {**a,'Authorization':'Account bad'}]:
            assert (await http.get('/api/payments/account',headers=headers)).status_code==401
        assert (await http.get('/api/payments/orders?offset=-1',headers=a)).status_code==422

@pytest.mark.usefixtures('disposable_databases')
async def test_request_id_is_account_scoped_and_revocation_does_not_block_paid_credit(settings):
    service = await setup(settings)
    request=PaymentOrderCreate(requestId=uuid4(),productId='pack')
    other=await saas.identity('13900139000',service.other,database=service.db)
    first=await service.create(request,service.account)
    second=await service.create(request,other)
    assert first['orderId']!=second['orderId']
    async with service.db.transaction() as conn:
        await conn.execute('UPDATE import_account_tokens SET revoked=true WHERE digest=%s',(saas.token_digest(service.credential),))
    with pytest.raises(DocumentProcessingError):
        await saas.identity('13800138000',service.credential,database=service.db)
    await service.confirm(result(first))
    await service.confirm(result(first))
    assert (await saas.account_summary(service.account,database=service.db))['balanceMicropoints']==1_000_000
    assert (await saas.account_summary(other,database=service.db))['balanceMicropoints']==0
    assert len(await service.db.rows("SELECT * FROM import_ledger WHERE kind='purchase'"))==1

@pytest.mark.usefixtures('disposable_databases')
async def test_credit_overflow_retains_paid_evidence_and_recovers_without_repayment(settings):
    service=await setup(settings)
    order=await service.create(PaymentOrderCreate(requestId=uuid4(),productId='pack'),service.account)
    async with service.db.transaction() as conn:
        await saas.credit(conn,service.account,saas.BIGINT_MAX,'adjust','ceiling')
    with pytest.raises(DocumentProcessingError,match='Point balance limit'):
        await service.confirm(result(order))
    assert (await service.owned(order['orderId'],service.account))['status']=='paid'
    assert not await service.db.rows("SELECT 1 FROM import_ledger WHERE kind='purchase'")
    async with service.db.transaction() as conn:
        await saas.credit(conn,service.account,-saas.BIGINT_MAX,'adjust','capacity-correction')
    await service.fulfill(order['orderId'])
    await service.fulfill(order['orderId'])
    assert (await service.owned(order['orderId'],service.account))['status']=='credited'
    assert (await saas.account_summary(service.account,database=service.db))['balanceMicropoints']==1_000_000

@pytest.mark.usefixtures('disposable_databases')
@pytest.mark.parametrize('slot', [1, 3])
async def test_offline_maintenance_detects_loss_of_either_ownership_session(monkeypatch, slot):
    from practiq_ai import manage
    from practiq_ai.database import LOCK_NAMESPACE
    db = await new_database()
    stopped = asyncio.Event()
    monkeypatch.setattr(manage.os, '_exit', lambda status: stopped.set())
    async with exclusive(db):
        rows = await db.rows("SELECT pg_terminate_backend(pid) AS terminated FROM pg_locks WHERE locktype='advisory' AND classid=%s AND objid=%s AND objsubid=2 AND granted", (LOCK_NAMESPACE, slot))
        assert rows == [{'terminated': True}]
        async with asyncio.timeout(3):
            await stopped.wait()
    for released in (1, 3):
        owner = await db.acquire(slot=released)
        await owner.close()

@pytest.mark.parametrize('seconds,allowed', [(-1, False), (0, False), (59, False), (60, False), (61, True), (90, True)])
def test_payment_link_requires_one_minute_after_wire_timestamp_rounding(settings, monkeypatch, seconds, allowed):
    from datetime import UTC, datetime, timedelta
    from zoneinfo import ZoneInfo
    now = datetime.now(UTC).replace(microsecond=500_000)
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return now
    monkeypatch.setattr(payments, 'datetime', Clock)
    row = {'order_id': 'test_order', 'status': 'pending', 'price_cents': 900, 'expires_at': now+timedelta(seconds=seconds), 'refund_evidence': {}}
    service = payments.Checkout(cast(Any, None), settings)
    if not allowed:
        with pytest.raises(DocumentProcessingError, match='Order not payable'):
            service.pay_url(row)
    else:
        link = service.pay_url(row)
        biz = json.loads(dict(parse_qsl(urlsplit(link).query))['biz_content'])
        deadline = datetime.strptime(biz['time_expire'], '%Y-%m-%d %H:%M:%S').replace(tzinfo=ZoneInfo('Asia/Shanghai'))
        assert deadline - now >= timedelta(minutes=1)

@pytest.mark.usefixtures('disposable_databases')
@pytest.mark.parametrize('stage', ['pending', 'paid', 'credited'])
@pytest.mark.parametrize('field,value', [('refund_fee','2.00'),('gmt_refund','2026-10-14 12:00:00.00'),('out_biz_no','refund_1')])
async def test_signed_refund_evidence_blocks_later_credit_and_preserves_existing_ledger(settings, stage, field, value):
    service = await setup(settings)
    order = await service.create(PaymentOrderCreate(requestId=uuid4(),productId='pack'), service.account)
    if stage == 'credited':
        await service.confirm(result(order))
    elif stage == 'paid':
        async with service.db.transaction() as conn:
            await conn.execute("UPDATE payment_orders SET status='paid',paid_at=now(),trade_no='20261014000000001'")
    expected = 1_000_000 if stage == 'credited' else 0
    payment_webapp.app.state.checkout = service
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=payment_webapp.app),base_url='http://test') as http:
        refund = notification(settings,order,**{field:value})
        assert (await http.post('/api/payments/notify',data=refund)).text == 'success'
        assert (await http.post('/api/payments/notify',data=notification(settings,order))).text == 'success'
    # A replay of the original success must not clear the durable refund hold.
    await service.confirm(result(order))
    held = await service.read(order['orderId'],service.account)
    assert held['refundReviewRequired']
    if stage == 'paid':
        with pytest.raises(DocumentProcessingError,match='Payment refund review required'):
            await service.fulfill(order['orderId'])
    assert (await saas.account_summary(service.account,database=service.db))['balanceMicropoints'] == expected
    assert len(await service.db.rows("SELECT * FROM import_ledger WHERE kind='purchase'")) == (1 if expected else 0)
    restarted = payments.Checkout(service.db,settings)
    assert (await restarted.read(order['orderId'],service.account))['refundReviewRequired']

@pytest.mark.usefixtures('disposable_databases')
@pytest.mark.parametrize('stage', ['paid', 'credited'])
async def test_closed_after_verified_payment_holds_credit_without_refund_fields(settings, stage):
    service = await setup(settings)
    order = await service.create(PaymentOrderCreate(requestId=uuid4(), productId='pack'), service.account)
    if stage == 'credited':
        await service.confirm(result(order))
    else:
        async with service.db.transaction() as conn:
            await conn.execute("UPDATE payment_orders SET status='paid',paid_at=now(),trade_no='20261014000000001'")
    payment_webapp.app.state.checkout = service
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=payment_webapp.app), base_url='http://test') as http:
        assert (await http.post('/api/payments/notify', data=notification(settings, order, trade_status='TRADE_CLOSED'))).text == 'success'
    await service.confirm(result(order))
    assert (await service.read(order['orderId'], service.account))['refundReviewRequired']
    expected = 1_000_000 if stage == 'credited' else 0
    assert (await saas.account_summary(service.account, database=service.db))['balanceMicropoints'] == expected
    assert len(await service.db.rows("SELECT * FROM import_ledger WHERE kind='purchase'")) == (1 if expected else 0)

@pytest.mark.usefixtures('disposable_databases')
async def test_query_refund_evidence_never_credits_and_zero_refund_amount_is_payable(settings, monkeypatch):
    from unittest.mock import AsyncMock
    service=await setup(settings)
    order=await service.create(PaymentOrderCreate(requestId=uuid4(),productId='pack'),service.account)
    monkeypatch.setattr(service,'query',AsyncMock(return_value={'code':'10000',**result(order),'refund_amount':'1.00'}))
    assert (await service.read(order['orderId'],service.account))['refundReviewRequired']
    assert (await saas.account_summary(service.account,database=service.db))['balanceMicropoints']==0
    other=await service.create(PaymentOrderCreate(requestId=uuid4(),productId='pack'),service.account)
    await service.confirm(result(other,trade_no='20261014000000002',refund_fee='0.00'))
    assert (await service.read(other['orderId'],service.account))['status']=='credited'

@pytest.mark.parametrize('seller,email,configured,accepted', [(None,'merchant@example.com',True,True), ('','merchant@example.com',True,True), (None,'merchant@example.com',False,False), (None,'other@example.com',True,False), ('2088000000000002','merchant@example.com',True,False)])
def test_notify_email_fallback_is_trusted_and_cannot_override_conflicting_seller_id(settings,seller,email,configured,accepted):
    settings=replace(settings,seller_email='merchant@example.com' if configured else None)
    service=payments.Checkout(cast(Any,None),settings)
    params=notification(settings,{'orderId':'test'},seller_email=email)
    if seller is None:
        del params['seller_id']
    else:
        params['seller_id']=seller
    params['sign']=SignatureUtils.sign_with_rsa2(settings.private_key,SignatureUtils.get_sign_content({k:v for k,v in params.items() if k not in {'sign','sign_type'}}),'utf-8')
    if accepted:
        service.verify_notify(params)
    else:
        with pytest.raises(DocumentProcessingError,match='Payment notification invalid'):
            service.verify_notify(params)

@pytest.mark.usefixtures('disposable_databases')
async def test_schema_two_upgrade_retains_paid_orders_and_adds_refund_hold(settings):
    service=await setup(settings)
    order=await service.create(PaymentOrderCreate(requestId=uuid4(),productId='pack'),service.account)
    async with service.db.transaction() as conn:
        await conn.execute("UPDATE payment_orders SET status='paid',paid_at=now(),trade_no='20261014000000001'")
        await conn.execute('ALTER TABLE payment_orders DROP COLUMN refund_evidence')
        await conn.execute('ALTER TABLE payment_schema DROP CONSTRAINT payment_schema_version_check')
        await conn.execute('UPDATE payment_schema SET version=2')
        await conn.execute('ALTER TABLE payment_schema ADD CHECK(version=2)')
    with pytest.raises(RuntimeError,match='schema or identity mismatch'):
        await payments.check_schema(service.db,settings)
    await payments.initialize(service.db,settings)
    await payments.initialize(service.db,settings)
    assert (await service.read(order['orderId'],service.account))['status']=='credited'
    assert (await service.db.rows('SELECT version FROM payment_schema'))==[{'version':3}]

@pytest.fixture
def checkout_environment(monkeypatch,tmp_path):
    root=tmp_path/'server'
    root.mkdir()
    (tmp_path/'.env').write_text('AI_SERVICE_TOKEN=unrelated-ai-secret\nPAYMENT_PRIVATE_KEY=wrong-shared-secret\n')
    (tmp_path/'.env.payments').write_text('DATABASE_URI=checkout-database\nPAYMENT_PRIVATE_KEY=private-checkout-secret\n')
    monkeypatch.setattr(payment_webapp,'SERVER_ROOT',root)
    monkeypatch.setattr(payments_manage,'SERVER_ROOT',root)
    for key in ('AI_SERVICE_TOKEN','DATABASE_URI','PAYMENT_PRIVATE_KEY'):
        monkeypatch.delenv(key,raising=False)
    return root

def test_checkout_operator_loads_only_its_private_environment(monkeypatch,checkout_environment):
    import os
    import sys
    called=[]
    async def command(args):
        called.append(args.action)
        assert os.environ['DATABASE_URI']=='checkout-database'
        assert os.environ['PAYMENT_PRIVATE_KEY']=='private-checkout-secret'
        assert 'AI_SERVICE_TOKEN' not in os.environ
    monkeypatch.setattr(payments_manage,'run',command)
    monkeypatch.setattr(sys,'argv',['payments_manage','init-db'])
    payments_manage.main()
    assert called==['init-db']

@pytest.mark.usefixtures('disposable_databases')
async def test_checkout_startup_loads_only_its_private_environment(settings,monkeypatch,checkout_environment):
    import os
    service=await setup(settings)
    monkeypatch.setattr(payment_webapp,'Database',lambda:service.db)
    def load():
        assert os.environ['DATABASE_URI']=='checkout-database'
        assert os.environ['PAYMENT_PRIVATE_KEY']=='private-checkout-secret'
        assert 'AI_SERVICE_TOKEN' not in os.environ
        return settings
    monkeypatch.setattr(payments.Settings,'load',load)
    async with payment_webapp.lifespan(payment_webapp.app):
        assert payment_webapp.app.state.checkout.db is service.db

@pytest.mark.parametrize('enabled',[False,True])
def test_locked_payment_sdk_is_optional_in_production_exports(enabled):
    import subprocess
    from pathlib import Path
    args=['uv','export','--frozen','--no-dev','--no-emit-project','--no-hashes']
    if enabled:
        args.extend(['--extra','payments'])
    exported=subprocess.check_output(args,cwd=Path(__file__).parents[1],text=True)
    packages={line.split('==')[0] for line in exported.splitlines() if line and not line.startswith('#')}
    payment_packages={'alipay-sdk-python','rsa','pyasn1','pycryptodome'}
    assert (payment_packages <= packages) if enabled else not payment_packages & packages

def test_payment_notices_match_locked_versions_and_complete_files():
    import hashlib
    import tomllib
    from pathlib import Path
    root=Path(__file__).parents[1]
    items=json.loads((root/'licenses/payments/inventory.json').read_text())
    locked={item['name']:item['version'] for item in tomllib.loads((root/'uv.lock').read_text())['package']}
    assert {item['name'] for item in items}=={'alipay-sdk-python','rsa','pyasn1','pycryptodome'}
    for item in items:
        assert item['version']==locked[item['name']]
        assert item['source'].startswith('https:')
        for notice in item['notices']:
            data=(root/'licenses/payments'/notice['file']).read_bytes()
            assert hashlib.sha256(data).hexdigest()==notice['sha256']
