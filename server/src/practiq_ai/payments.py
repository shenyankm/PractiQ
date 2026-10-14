"""Independent Vibe Pay checkout; paid orders credit existing accounts, never model work."""

import asyncio
import hashlib
import json
import os
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qsl, urlsplit
from zoneinfo import ZoneInfo

import httpx
from alipay.aop.api.AlipayClientConfig import AlipayClientConfig
from alipay.aop.api.DefaultAlipayClient import DefaultAlipayClient
from alipay.aop.api.request.AlipayTradePagePayRequest import AlipayTradePagePayRequest
from alipay.aop.api.request.AlipayTradeQueryRequest import AlipayTradeQueryRequest
from alipay.aop.api.util.SignatureUtils import (
    fill_private_key_marker,
    fill_public_key_marker,
    get_sign_content,
    rsa,
    sign_with_rsa2,
    verify_with_rsa,
)

from .contracts import PaymentOrderCreate
from .database import Database
from .saas import credit, failure

GATEWAYS = {'production': 'https://openapi.alipay.com/gateway.do',
            'sandbox': 'https://openapi-sandbox.dl.alipaydev.com/gateway.do'}
DDL = """
CREATE TABLE payment_schema (
 version integer PRIMARY KEY CHECK(version=3), identity text NOT NULL
);
CREATE TABLE payment_products (
 product_id text PRIMARY KEY REFERENCES import_products(product_id),
 price_cents bigint NOT NULL CHECK(price_cents BETWEEN 1 AND 10000000000),
 enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE payment_orders (
 order_id text PRIMARY KEY, account_id text REFERENCES import_accounts(account_id), request_id text, allocation_note text NOT NULL DEFAULT '', refund_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
 product_id text NOT NULL REFERENCES import_products(product_id), name text NOT NULL,
 price_cents bigint NOT NULL CHECK(price_cents BETWEEN 1 AND 10000000000),
 points bigint NOT NULL CHECK(points>0),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','credited','closed','fulfilled')),
 trade_no text UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 paid_at timestamptz, credited_at timestamptz, next_query_at timestamptz,
 UNIQUE(account_id,request_id),
 CHECK((status IN ('paid','credited','fulfilled'))=(paid_at IS NOT NULL)),
 CHECK(status!='credited' OR (account_id IS NOT NULL AND request_id IS NOT NULL AND credited_at IS NOT NULL)),
 CHECK(status!='fulfilled' OR account_id IS NULL)
);
CREATE INDEX payment_order_time ON payment_orders(created_at);
CREATE INDEX payment_unfulfilled ON payment_orders(created_at) WHERE status='paid';
"""
TABLES = {'payment_schema', 'payment_products', 'payment_orders'}


def https_url(value: str) -> str:
    parts = urlsplit(value)
    if (parts.scheme != 'https' or not parts.hostname or parts.username or parts.password
            or parts.query or parts.fragment or len(value) > 256):
        raise ValueError('A fixed HTTPS payment URL without credentials or query is required')
    return value


@dataclass(frozen=True)
class Settings:
    app_id: str
    seller_id: str
    private_key: str = field(repr=False)
    public_key: str = field(repr=False)
    notify_url: str
    return_url: str
    gateway: str
    seller_email: str | None = field(default=None, repr=False)

    @classmethod
    def load(cls):
        try:
            app_id, seller_id = os.environ['PAYMENT_APP_ID'], os.environ['PAYMENT_SELLER_ID']
            if not re.fullmatch(r'[0-9]{16,32}', app_id) or not re.fullmatch(r'[0-9]{16}', seller_id):
                raise ValueError('Invalid payment identity')
            email = os.environ.get('PAYMENT_SELLER_EMAIL')
            if email is not None and not re.fullmatch(r'\S{1,100}', email):
                raise ValueError('Invalid configured seller account')
            private = os.environ['PAYMENT_PRIVATE_KEY'].replace('\\n', '\n').strip()
            public = os.environ['PAYMENT_ALIPAY_PUBLIC_KEY'].replace('\\n', '\n').strip()
            if not private or not public:
                raise ValueError('Payment RSA keys are required')
            private_rsa = rsa.PrivateKey.load_pkcs1(fill_private_key_marker(private))
            public_rsa = rsa.PublicKey.load_pkcs1_openssl_pem(fill_public_key_marker(public))
            if min(private_rsa.n.bit_length(), public_rsa.n.bit_length()) < 2048:
                raise ValueError('Payment RSA keys must have at least 2048 bits')
            sign_with_rsa2(private, 'configuration-check', 'utf-8')
            notify_url = https_url(os.environ['PAYMENT_NOTIFY_URL'])
            return_url = https_url(os.environ['PAYMENT_RETURN_URL'])
            if urlsplit(notify_url).path != '/api/payments/notify' or urlsplit(return_url).path != '/purchase':
                raise ValueError('Payment URLs must match the checkout routes')
            return cls(app_id, seller_id, private, public, notify_url, return_url,
                       GATEWAYS[os.environ['PAYMENT_ENVIRONMENT']], email)
        except (KeyError, ValueError, TypeError) as exc:
            raise ValueError('Complete, valid server-side PAYMENT configuration is required') from exc

    @property
    def identity(self):
        return hashlib.sha256((self.app_id + ':' + self.seller_id + ':' + self.gateway).encode()).hexdigest()

    def client(self):
        config = AlipayClientConfig()
        config.app_id, config.server_url = self.app_id, self.gateway
        config.app_private_key, config.alipay_public_key = self.private_key, self.public_key
        config.charset, config.sign_type = 'utf-8', 'RSA2'
        return DefaultAlipayClient(config)  # No SDK logger: requests and responses contain payment data.



def amount(cents: int):
    return f'{cents // 100}.{cents % 100:02d}'


def amount_cents(value: object):
    if not isinstance(value, str) or not re.fullmatch(r'(?:0|[1-9][0-9]{0,8})\.[0-9]{2}', value):
        raise failure('PAYMENT_AMOUNT_INVALID', 400)
    whole, fraction = value.split('.')
    return int(whole) * 100 + int(fraction)


async def check_schema(db: Database, settings: Settings):
    if not TABLES <= await db.tables() or await db.rows('SELECT version,identity FROM payment_schema') != [{'version': 3, 'identity': settings.identity}]:
        raise RuntimeError('Payment schema or identity mismatch; use explicit offline payments_manage init-db')


async def initialize(db: Database, settings: Settings):
    await db.check_schema()
    if TABLES & await db.tables():
        if not TABLES <= await db.tables():
            raise RuntimeError('Incomplete payment schema; restore before upgrading')
        metadata = await db.rows('SELECT version,identity FROM payment_schema')
        if len(metadata)==1 and metadata[0]['version']==1:
            legacy_key = os.environ.get('PAYMENT_CARD_KEY', '')
            if not re.fullmatch(r'[a-fA-F0-9]{64}', legacy_key):
                raise RuntimeError('Version-1 payment upgrade requires its original PAYMENT_CARD_KEY for identity verification')
            old_identity = hashlib.sha256((settings.app_id+':'+settings.seller_id+':'+settings.gateway).encode()+bytes.fromhex(legacy_key)).hexdigest()
            if metadata[0]['identity'] != old_identity:
                raise RuntimeError('Payment merchant identity mismatch; old orders remain untouched')
            async with db.transaction() as conn:
                await conn.execute("ALTER TABLE payment_orders ADD COLUMN account_id text REFERENCES import_accounts(account_id), ADD COLUMN request_id text, ADD COLUMN credited_at timestamptz, ADD COLUMN allocation_note text NOT NULL DEFAULT ''")
                await conn.execute('ALTER TABLE payment_orders ALTER COLUMN access_digest DROP NOT NULL')
                await conn.execute('ALTER TABLE payment_orders DROP CONSTRAINT payment_orders_status_check, DROP CONSTRAINT payment_orders_check, DROP CONSTRAINT payment_orders_check1')
                await conn.execute("ALTER TABLE payment_orders ADD CONSTRAINT payment_orders_status_check CHECK(status IN ('pending','paid','credited','closed','fulfilled')), ADD CHECK((status IN ('paid','credited','fulfilled'))=(paid_at IS NOT NULL)), ADD CHECK(status!='credited' OR (account_id IS NOT NULL AND request_id IS NOT NULL AND credited_at IS NOT NULL)), ADD CHECK(status!='fulfilled' OR account_id IS NULL), ADD UNIQUE(account_id,request_id)")
                await conn.execute('ALTER TABLE payment_schema DROP CONSTRAINT payment_schema_version_check')
                await conn.execute('UPDATE payment_schema SET version=2,identity=%s', (settings.identity,))
                await conn.execute('ALTER TABLE payment_schema ADD CHECK(version=2)')
        metadata = await db.rows('SELECT version,identity FROM payment_schema')
        if metadata == [{'version': 2, 'identity': settings.identity}]:
            async with db.transaction() as conn:
                await conn.execute("ALTER TABLE payment_orders ADD COLUMN refund_evidence jsonb NOT NULL DEFAULT '{}'::jsonb")
                await conn.execute('ALTER TABLE payment_schema DROP CONSTRAINT payment_schema_version_check')
                await conn.execute('UPDATE payment_schema SET version=3')
                await conn.execute('ALTER TABLE payment_schema ADD CHECK(version=3)')
        await check_schema(db, settings)
        return
    async with db.transaction() as conn:
        await conn.execute(DDL, prepare=False)
        await conn.execute('INSERT INTO payment_schema VALUES(3,%s)', (settings.identity,))


class Checkout:
    def __init__(self, db: Database, settings: Settings):
        self.db, self.settings = db, settings
        self.query_slots = asyncio.Semaphore(4)

    async def products(self):
        rows = await self.db.rows('SELECT p.product_id,p.name,p.points,c.price_cents FROM payment_products c '
                                  'JOIN import_products p USING(product_id) WHERE c.enabled AND p.enabled ORDER BY p.product_id')
        return {'items': [{'productId': r['product_id'], 'name': r['name'], 'pointsMicropoints': r['points'], 'priceCents': r['price_cents']} for r in rows]}

    async def create(self, request: PaymentOrderCreate, account: str):
        async with self.db.transaction() as conn:
            owner = await (await conn.execute('SELECT account_id FROM import_accounts WHERE account_id=%s FOR UPDATE', (account,))).fetchone()
            if not owner:
                raise failure('ACCOUNT_REQUIRED', 401)
            row = await (await conn.execute('SELECT * FROM payment_orders WHERE account_id=%s AND request_id=%s FOR UPDATE', (account, str(request.requestId)))).fetchone()
            if row:
                if row['product_id'] != request.productId:
                    raise failure('ORDER_REQUEST_CONFLICT')
            else:
                count = await (await conn.execute("SELECT count(*) AS n FROM payment_orders WHERE created_at > now()-interval '24 hours'")).fetchone()
                if count and count['n'] >= 10_000:
                    raise failure('PAYMENT_ORDER_CAPACITY', 429)
                product = await (await conn.execute('SELECT p.*,c.price_cents FROM import_products p JOIN payment_products c USING(product_id) '
                                                    'WHERE p.product_id=%s AND p.enabled AND c.enabled FOR UPDATE', (request.productId,))).fetchone()
                if not product:
                    raise failure('PAYMENT_PRODUCT_UNAVAILABLE', 404)
                from uuid import uuid4
                row = await (await conn.execute('INSERT INTO payment_orders(order_id,account_id,request_id,product_id,name,price_cents,points,expires_at) '
                                                'VALUES(%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *',
                                                (uuid4().hex, account, str(request.requestId), request.productId, product['name'], product['price_cents'], product['points'], datetime.now(UTC) + timedelta(minutes=30)))).fetchone()
        assert row is not None
        return self.view(row)

    async def owned(self, order_id: str, account: str):
        rows = await self.db.rows('SELECT * FROM payment_orders WHERE order_id=%s AND account_id=%s', (order_id, account))
        if not rows:
            raise failure('ORDER_NOT_FOUND', 404)
        return rows[0]

    async def orders(self, account: str, offset: int):
        rows = await self.db.rows('SELECT * FROM payment_orders WHERE account_id=%s ORDER BY created_at DESC,order_id DESC LIMIT 21 OFFSET %s', (account, offset))
        return {'items': [self.view(row) for row in rows[:20]], 'hasMore': len(rows)>20}

    def view(self, row):
        return {'orderId': row['order_id'], 'productId': row['product_id'], 'name': row['name'], 'priceCents': row['price_cents'],
                'pointsMicropoints': row['points'], 'status': row['status'], 'createdAt': row['created_at'].isoformat(),
                'expiresAt': row['expires_at'].isoformat(), 'refundReviewRequired': bool(row['refund_evidence']), 'creditedMicropoints': row['points'] if row['status']=='credited' else 0}

    def pay_url(self, row):
        if row['status'] != 'pending' or row['refund_evidence'] or datetime.now(UTC) + timedelta(minutes=1) > row['expires_at'].replace(microsecond=0):
            raise failure('ORDER_NOT_PAYABLE')
        request = AlipayTradePagePayRequest()
        request.notify_url, request.return_url = self.settings.notify_url, self.settings.return_url
        request.biz_content = {'out_trade_no': row['order_id'], 'total_amount': amount(row['price_cents']),
                               'subject': 'PractiQ import points', 'product_code': 'FAST_INSTANT_TRADE_PAY',
                               'time_expire': row['expires_at'].astimezone(ZoneInfo('Asia/Shanghai')).strftime('%Y-%m-%d %H:%M:%S')}
        # GET page_execute produces a signed redirect; never inject provider HTML into React.
        return self.settings.client().page_execute(request, http_method='GET')

    def verify_notify(self, params: dict[str, str]):
        seller = params.get('seller_id')
        merchant_matches = seller == self.settings.seller_id if seller else bool(self.settings.seller_email and params.get('seller_email') == self.settings.seller_email)
        if params.get('sign_type') != 'RSA2' or params.get('app_id') != self.settings.app_id or not merchant_matches:
            raise failure('PAYMENT_NOTIFICATION_INVALID', 400)
        signed = {k: v for k, v in params.items() if k not in {'sign', 'sign_type'}}
        try:
            if not verify_with_rsa(self.settings.public_key, get_sign_content(signed).encode('utf-8'), params.get('sign', '')):
                raise ValueError('Invalid signature')
        except Exception as exc:
            raise failure('PAYMENT_SIGNATURE_INVALID', 400) from exc

    async def query(self, order_id: str):
        request = AlipayTradeQueryRequest()
        request.biz_content = {'out_trade_no': order_id}
        signed = self.settings.client().sdk_execute(request)
        async with asyncio.timeout(15), self.query_slots, httpx.AsyncClient(timeout=10, follow_redirects=False, trust_env=False) as client, client.stream('POST', self.settings.gateway, data=dict(parse_qsl(signed))) as response:
            response.raise_for_status()
            body = bytearray()
            async for part in response.aiter_bytes():
                if len(body) + len(part) > 64 * 1024:
                    raise ValueError('Payment query response exceeds limit')
                body.extend(part)
        raw = body.decode('utf-8')
        match = re.match(r'\s*\{\s*"alipay_trade_query_response"\s*:\s*', raw)
        if not match:
            raise ValueError('Invalid payment response envelope')
        result, length = json.JSONDecoder().raw_decode(raw[match.end():])
        envelope = json.loads(raw)
        if set(envelope) != {'alipay_trade_query_response', 'sign'} or not isinstance(result, dict):
            raise ValueError('Invalid payment response envelope')
        if not verify_with_rsa(self.settings.public_key, raw[match.end():match.end()+length].encode(), envelope['sign']):
            raise ValueError('Invalid payment query signature')
        return result

    async def confirm(self, result: dict):
        order_id, state = result.get('out_trade_no'), result.get('trade_status')
        if not isinstance(order_id, str) or state not in {'WAIT_BUYER_PAY', 'TRADE_SUCCESS', 'TRADE_FINISHED', 'TRADE_CLOSED'}:
            raise failure('PAYMENT_STATUS_INVALID', 400)
        if not isinstance(result.get('trade_no'), str) or not re.fullmatch(r'[0-9]{1,64}', result['trade_no']):
            raise failure('PAYMENT_TRADE_INVALID', 400)
        async with self.db.transaction() as conn:
            row = await (await conn.execute('SELECT * FROM payment_orders WHERE order_id=%s FOR UPDATE', (order_id,))).fetchone()
            if not row or amount_cents(result.get('total_amount')) != row['price_cents']:
                raise failure('PAYMENT_ORDER_MISMATCH', 400)
            if row['trade_no'] and row['trade_no'] != result['trade_no']:
                raise failure('PAYMENT_TRADE_MISMATCH', 400)
            refund = {key: value for key, value in result.items()
                      if (key in {'out_biz_no', 'gmt_refund', 'refund_detail_item_list'} and value not in (None, '', []))
                      or (key in {'refund_fee', 'send_back_fee', 'refund_amount'} and value not in (None, '', '0', '0.00', 0))}
            if state == 'TRADE_CLOSED' and row['status'] in {'paid', 'credited'}:
                refund['trade_status'] = state
            if refund:
                await conn.execute('UPDATE payment_orders SET trade_no=COALESCE(trade_no,%s),refund_evidence=refund_evidence || %s::jsonb WHERE order_id=%s', (result['trade_no'], json.dumps(refund), order_id))
                return
            if row['refund_evidence']:
                return
            if state in {'TRADE_SUCCESS', 'TRADE_FINISHED'} and row['status'] in {'pending', 'closed'}:
                await conn.execute("UPDATE payment_orders SET status='paid',trade_no=%s,paid_at=now() WHERE order_id=%s", (result['trade_no'], order_id))
            elif state == 'TRADE_CLOSED' and row['status'] == 'pending':
                await conn.execute("UPDATE payment_orders SET status='closed',trade_no=%s WHERE order_id=%s", (result['trade_no'], order_id))
        # Paid evidence survives a failed credit transaction and is retried by notify/query/operator.
        await self.fulfill(order_id)

    async def fulfill(self, order_id: str):
        async with self.db.transaction() as conn:
            row = await (await conn.execute('SELECT * FROM payment_orders WHERE order_id=%s FOR UPDATE', (order_id,))).fetchone()
            if not row or row['status'] != 'paid':
                return
            if row['refund_evidence']:
                raise failure('PAYMENT_REFUND_REVIEW_REQUIRED', 409)
            if not row['account_id']:
                raise failure('PAYMENT_ACCOUNT_REQUIRED', 409)
            await credit(conn, row['account_id'], row['points'], 'purchase', order_id)
            await conn.execute("UPDATE payment_orders SET status='credited',credited_at=now() WHERE order_id=%s", (order_id,))


    async def read(self, order_id: str, account: str):
        row = await self.owned(order_id, account)
        if row['refund_evidence']:
            return self.view(row)
        if row['status'] == 'paid':
            await self.fulfill(order_id)
        elif row['status'] in {'pending', 'closed'}:
            async with self.db.transaction() as conn:
                admitted = await (await conn.execute("UPDATE payment_orders SET next_query_at=now()+interval '3 seconds' WHERE order_id=%s AND (next_query_at IS NULL OR next_query_at<=now()) RETURNING order_id", (order_id,))).fetchone()
            if not admitted:
                return self.view(row)
            try:
                result = await self.query(order_id)
                if result.get('code') == '10000':
                    if result.get('out_trade_no') != order_id:
                        raise ValueError('Query returned another order')
                    await self.confirm(result)
                elif result.get('sub_code') != 'ACQ.TRADE_NOT_EXIST':
                    raise ValueError('Payment query failed')
            except Exception as exc:
                raise failure('PAYMENT_QUERY_UNKNOWN', 503) from exc
        return self.view(await self.owned(order_id, account))
