"""Durable Alipay orders and refunds; uncertain writes are never replayed."""
import asyncio
import json
import logging
import os
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from alipay.aop.api.AlipayClientConfig import AlipayClientConfig
from alipay.aop.api.DefaultAlipayClient import DefaultAlipayClient
from alipay.aop.api.request.AlipayTradeCloseRequest import AlipayTradeCloseRequest
from alipay.aop.api.request.AlipayTradeFastpayRefundQueryRequest import (
    AlipayTradeFastpayRefundQueryRequest,
)
from alipay.aop.api.request.AlipayTradePagePayRequest import AlipayTradePagePayRequest
from alipay.aop.api.request.AlipayTradeQueryRequest import AlipayTradeQueryRequest
from alipay.aop.api.request.AlipayTradeRefundRequest import AlipayTradeRefundRequest
from alipay.aop.api.util.SignatureUtils import get_sign_content, verify_with_rsa
from fastapi import HTTPException
from psycopg.types.json import Jsonb

from . import billing
from . import identity as auth
from .payment_config import PaymentConfig, cents, load, money

SDK_SLOTS = asyncio.Semaphore(4)
PAID = {'TRADE_SUCCESS', 'TRADE_FINISHED'}
STATES = {'TRADE_SUCCESS': 'PAID', 'TRADE_FINISHED': 'PAID', 'WAIT_BUYER_PAY': 'PENDING_PAYMENT', 'TRADE_CLOSED': 'CLOSED'}


def writable() -> None:
    if os.environ.get('AI_READ_ONLY') == '1':
        raise HTTPException(409, {'code': 'SERVICE_READ_ONLY'})


def client(config: PaymentConfig) -> DefaultAlipayClient:
    sdk = AlipayClientConfig()
    sdk.app_id = config.app_id
    sdk.app_private_key = config.private_key
    sdk.alipay_public_key = config.public_key
    sdk.server_url = config.gateway
    sdk.sign_type, sdk.charset, sdk.timeout, sdk.skip_sign = 'RSA2', 'utf-8', 15, False
    # SDK debug logging includes complete request/response bodies: leave logger unset.
    return DefaultAlipayClient(alipay_client_config=sdk)


async def execute(config: PaymentConfig, request: Any) -> dict:
    try:
        async with SDK_SLOTS:
            # execute verifies the response signature and returns the unwrapped business JSON.
            value = json.loads(await asyncio.to_thread(client(config).execute, request))
        if not isinstance(value, dict):
            raise TypeError('Invalid response')
        return value
    except Exception:  # noqa: BLE001 - SDK failures may contain secrets; retain unknown receipts
        raise HTTPException(503, {'code': 'PAYMENT_RESULT_UNKNOWN', 'message': '结果待查询确认，请勿重复付款或使用新退款号重试。'}) from None


def bound(config: PaymentConfig, order: dict) -> None:
    if (order['environment'], order['app_id'], order['seller_id']) != (config.mode, config.app_id, config.seller_id):
        raise HTTPException(409, {'code': 'PAYMENT_APPLICATION_CHANGED'})


def trade_matches(order: dict, result: dict) -> bool:
    try:
        return (result.get('out_trade_no') == order['id'] and bool(result.get('trade_no'))
                and (not order['trade_no'] or order['trade_no'] == result['trade_no'])
                and cents(str(result.get('total_amount', ''))) == order['amount'])
    except ValueError:
        return False


def amount_matches(value: Any, expected: int) -> bool:
    try:
        return cents(str(value)) == expected
    except ValueError:
        return False


async def order_for(order_id: str, *, admin: bool = False) -> dict:
    user = auth.actor.get()
    if user is None:
        raise HTTPException(401, {'code': 'LOGIN_REQUIRED'})
    rows = await auth.db().rows('SELECT * FROM payment_orders WHERE id=%s AND (owner_id=%s OR %s)', (order_id, user['id'], admin and user['role'] == 'admin'))
    if not rows:
        raise HTTPException(404, {'code': 'PAYMENT_NOT_FOUND'})
    return rows[0]


async def snapshot(order: dict) -> dict:
    refunds = await auth.db().rows('SELECT id,amount,state FROM payment_refunds WHERE order_id=%s ORDER BY created_at', (order['id'],))
    return {'id': order['id'], 'requestId': order['request_id'], 'state': order['state'], 'amount': money(order['amount']), 'subject': order['subject'],
            'environment': order['environment'], 'productId': order['product']['id'] if order.get('product') else None, 'providerClosed': order.get('provider_closed', False), 'refunds': [{'id': r['id'], 'amount': money(r['amount']), 'state': r['state']} for r in refunds]}


async def create(request_id: str, product_id: str | None = None) -> dict:
    writable()
    config = load()
    async with auth.db().transaction() as conn:
        user = await auth.current_actor(conn)
        order = await (await conn.execute('SELECT * FROM payment_orders WHERE owner_id=%s AND request_id=%s', (user['id'], request_id))).fetchone()
        if order is not None and (order['product']['id'] if order.get('product') else None) != product_id:
            raise HTTPException(409, {'code': 'PAYMENT_PRODUCT_CHANGED'})
        if order is None:
            if config.mode == 'production' and product_id is None:
                raise HTTPException(422, {'code': 'PLAN_PRODUCT_REQUIRED'})
            item = billing.product(product_id) if product_id else None
            if item and config.mode == 'production':
                await billing.check_purchase(conn, user, item)
            amount = cents(item.amount) if item and config.mode == 'production' else config.amount
            subject = f'PractiQ {item.name} · {item.pages} 页 / {item.durationDays} 天' if item else config.subject
            pending = await (await conn.execute("SELECT 1 FROM payment_orders WHERE owner_id=%s AND environment=%s AND state IN ('UNKNOWN','PENDING_PAYMENT') LIMIT 1", (user['id'], config.mode))).fetchone()
            if pending:
                raise HTTPException(409, {'code': 'PAYMENT_PENDING_EXISTS'})
            order = await (await conn.execute('INSERT INTO payment_orders(id,owner_id,request_id,environment,app_id,seller_id,amount,subject,return_url,product) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *',
                           (uuid4().hex, user['id'], request_id, config.mode, config.app_id, config.seller_id, amount, subject, config.return_url, Jsonb(item.model_dump()) if item else None))).fetchone()
            assert order is not None
            await auth.audit('payment_create', order['id'], {'environment': config.mode, 'amount': money(amount), 'productId': product_id}, conn=conn)
    assert order is not None
    return await payment_form(order, config)


async def payment_form(order: dict, config: PaymentConfig) -> dict:
    writable()
    bound(config, order)
    if order['state'] in {'PAID', 'CLOSED'} or order.get('provider_closed'):
        raise HTTPException(409, {'code': 'PAYMENT_ALREADY_SETTLED'})
    request = AlipayTradePagePayRequest()
    request.biz_content = {'out_trade_no': order['id'], 'total_amount': money(order['amount']), 'subject': order['subject'],
                           'product_code': 'FAST_INSTANT_TRADE_PAY', 'timeout_express': '15m'}
    request.return_url = order['return_url']
    if config.notify_url:
        request.notify_url = config.notify_url
    try:
        async with SDK_SLOTS:
            form = await asyncio.to_thread(client(config).page_execute, request, 'POST')
    except Exception:  # noqa: BLE001 - SDK failures may contain secrets; retain unknown receipts
        raise HTTPException(503, {'code': 'PAYMENT_FORM_UNAVAILABLE'}) from None
    return {'order': await snapshot(order), 'paymentHtml': form}


async def query(order: dict, config: PaymentConfig | None = None) -> dict:
    config = config or load()
    bound(config, order)
    request = AlipayTradeQueryRequest()
    request.biz_content = {'out_trade_no': order['id']}
    result = await execute(config, request)
    if result.get('code') != '10000':
        return order  # Including not-yet-created provider trades: never infer failed payment.
    # Query responses do not contain seller_id. The SDK-authenticated application,
    # immutable local seller binding, order, amount and trade ID establish ownership.
    if not trade_matches(order, result):
        raise HTTPException(409, {'code': 'PAYMENT_RESPONSE_MISMATCH'})
    state = STATES.get(str(result.get('trade_status')), 'UNKNOWN')
    paid_amount = None
    if state == 'PAID':
        buyer_amount = str(result.get('buyer_pay_amount', money(order['amount'])))
        if buyer_amount in {'0', '0.0', '0.00'}:
            paid_amount = 0
        elif amount_matches(buyer_amount, order['amount']):
            paid_amount = order['amount']
        else:
            try:
                paid_amount = cents(buyer_amount)
            except ValueError:
                raise HTTPException(409, {'code': 'PAYMENT_RESPONSE_MISMATCH'}) from None
            if paid_amount > order['amount']:
                raise HTTPException(409, {'code': 'PAYMENT_RESPONSE_MISMATCH'})
    async with auth.db().transaction() as conn:
        updated = await (await conn.execute("UPDATE payment_orders SET state=CASE WHEN state='PAID' OR (state='CLOSED' AND %s!='PAID') THEN state ELSE %s END,paid_amount=coalesce(%s,paid_amount),trade_no=coalesce(trade_no,%s) WHERE id=%s AND (trade_no IS NULL OR trade_no=%s) RETURNING *", (state, state, paid_amount, result['trade_no'], order['id'], result['trade_no']))).fetchone()
        if updated is None:
            raise HTTPException(409, {'code': 'PAYMENT_RESPONSE_MISMATCH'})
        if state == 'CLOSED':
            await billing.provider_closed(conn, updated)
            updated['provider_closed'] = True
        else:
            await billing.fulfill(conn, updated)
    return updated


def verify_notification(params: dict[str, str], config: PaymentConfig) -> bool:
    if params.get('app_id') != config.app_id or params.get('sign_type') != 'RSA2' or not params.get('sign'):
        return False
    unsigned = {key: value for key, value in params.items() if key not in {'sign', 'sign_type'} and value != ''}
    try:
        return verify_with_rsa(config.public_key, get_sign_content(unsigned).encode('utf-8'), params['sign'])
    except Exception:  # noqa: BLE001 - SDK failures may contain secrets; retain unknown receipts
        return False


async def notify(params: dict[str, str]) -> bool:
    config = load()
    if not await asyncio.to_thread(verify_notification, params, config):
        return False
    if not all(params.get(key) for key in ('notify_id', 'notify_type', 'out_trade_no', 'trade_no', 'trade_status')):
        return False
    async with auth.db().transaction() as conn:
        order = await (await conn.execute('SELECT * FROM payment_orders WHERE id=%s FOR UPDATE', (params['out_trade_no'],))).fetchone()
        if order is None:
            return False
        bound(config, order)
        if params.get('seller_id') != config.seller_id or not trade_matches(order, params):
            return False
        event = params['trade_status'] + (':other' if any(params.get(key) for key in ('out_biz_no', 'gmt_refund', 'refund_fee')) else ':payment')
        inserted = await (await conn.execute('INSERT INTO payment_notifications(app_id,notify_id,order_id,trade_no,event_type) VALUES(%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING RETURNING notify_id',
                         (config.app_id, params['notify_id'], order['id'], params['trade_no'], event))).fetchone()
        if inserted is None:
            previous = await (await conn.execute('SELECT order_id,trade_no,event_type FROM payment_notifications WHERE app_id=%s AND notify_id=%s', (config.app_id, params['notify_id']))).fetchone()
            return previous == {'order_id': order['id'], 'trade_no': params['trade_no'], 'event_type': event}
        if params['trade_status'] == 'TRADE_CLOSED' and params['notify_type'] == 'trade_status_sync':
            await billing.provider_closed(conn, order)
        if params['trade_status'] in PAID and event.endswith(':payment') and params['notify_type'] == 'trade_status_sync':
            await conn.execute("UPDATE payment_orders SET state='PAID',trade_no=coalesce(trade_no,%s) WHERE id=%s", (params['trade_no'], order['id']))
            await billing.fulfill(conn, {**order, 'state': 'PAID'})
    return True


async def close(order: dict) -> dict:
    writable()
    config = load()
    # Read before closing; unknown queries and mismatches cannot turn into a new charge.
    order = await query(order, config)
    if order['state'] != 'PENDING_PAYMENT':
        raise HTTPException(409, {'code': 'PAYMENT_NOT_PENDING'})
    async with auth.db().transaction() as conn:
        await auth.current_actor(conn)
        await auth.audit('payment_close', order['id'], conn=conn)
    request = AlipayTradeCloseRequest()
    request.biz_content = {'out_trade_no': order['id']}
    await execute(config, request)
    return await snapshot(await query(order, config))


async def refund(order: dict, request_id: str, amount: int, reason: str) -> dict:
    writable()
    config = load()
    order = await query(order, config)
    if order['state'] != 'PAID':
        raise HTTPException(409, {'code': 'PAYMENT_NOT_PAID'})
    async with auth.db().transaction() as conn:
        user = await auth.current_actor(conn)
        if user['role'] != 'admin':
            raise HTTPException(403, {'code': 'ADMIN_REQUIRED'})
        previous = await (await conn.execute('SELECT * FROM payment_refunds WHERE id=%s', (request_id,))).fetchone()
        if previous:
            if (previous['order_id'], previous['amount'], previous['reason']) != (order['id'], amount, reason):
                raise HTTPException(409, {'code': 'REFUND_REQUEST_CONFLICT'})
            return {'id': previous['id'], 'amount': money(previous['amount']), 'state': previous['state']}
        used = await (await conn.execute('SELECT coalesce(sum(amount),0) AS amount FROM payment_refunds WHERE order_id=%s', (order['id'],))).fetchone()
        assert used is not None
        if order['paid_amount'] is None or used['amount'] + amount > order['paid_amount']:
            raise HTTPException(409, {'code': 'REFUND_LIMIT_EXCEEDED'})
        await billing.freeze_refund(conn, order, amount)
        # Reserve unknown outcomes before sending. Replay returns this receipt, never resends.
        await conn.execute('INSERT INTO payment_refunds(id,order_id,amount,reason) VALUES(%s,%s,%s,%s)', (request_id, order['id'], amount, reason))
        await auth.audit('payment_refund', order['id'], {'requestId': request_id, 'amount': money(amount)}, conn=conn)
    request = AlipayTradeRefundRequest()
    request.biz_content = {'out_trade_no': order['id'], 'out_request_no': request_id, 'refund_amount': money(amount), 'refund_reason': reason}
    result = await execute(config, request)
    # Even fund_change=Y is confirmed by a separate query, checking the refund identity.
    if result.get('code') == '10000' and result.get('fund_change') == 'Y':
        if (result.get('out_trade_no') != order['id'] or result.get('trade_no') != order['trade_no']
                or not amount_matches(result.get('refund_fee'), amount)):
            raise HTTPException(409, {'code': 'REFUND_RESPONSE_MISMATCH'})
        async with auth.db().transaction() as conn:
            await conn.execute("UPDATE payment_refunds SET state='SUCCESS' WHERE id=%s", (request_id,))
            await billing.finish_refund(conn, order['id'])
    rows = await auth.db().rows('SELECT id,amount,state FROM payment_refunds WHERE id=%s', (request_id,))
    return {'id': rows[0]['id'], 'amount': money(rows[0]['amount']), 'state': rows[0]['state']}


async def refund_query(order: dict, refund_id: str) -> dict:
    config = load()
    bound(config, order)
    rows = await auth.db().rows('SELECT * FROM payment_refunds WHERE id=%s AND order_id=%s', (refund_id, order['id']))
    if not rows:
        raise HTTPException(404, {'code': 'REFUND_NOT_FOUND'})
    receipt = rows[0]
    if receipt['state'] != 'SUCCESS' and datetime.now(UTC) >= receipt['created_at'] + timedelta(seconds=10):
        request = AlipayTradeFastpayRefundQueryRequest()
        request.biz_content = {'out_trade_no': order['id'], 'out_request_no': refund_id}
        result = await execute(config, request)
        if result.get('code') == '10000' and result.get('refund_status') == 'REFUND_SUCCESS':
            if (result.get('out_trade_no') != order['id'] or result.get('trade_no') != order['trade_no']
                    or result.get('out_request_no') != refund_id or not amount_matches(result.get('refund_amount'), receipt['amount'])):
                raise HTTPException(409, {'code': 'REFUND_RESPONSE_MISMATCH'})
            async with auth.db().transaction() as conn:
                await conn.execute("UPDATE payment_refunds SET state='SUCCESS' WHERE id=%s", (refund_id,))
                await billing.finish_refund(conn, order['id'])
            receipt['state'] = 'SUCCESS'
    return {'id': receipt['id'], 'amount': money(receipt['amount']), 'state': receipt['state']}


async def reconcile_once() -> None:
    config = load()
    async with auth.db().transaction() as conn:
        orders = await (await conn.execute("UPDATE payment_orders SET next_check=now()+least(3600,30*(checks+1))*interval '1 second',checks=checks+1 WHERE id IN (SELECT id FROM payment_orders WHERE environment=%s AND app_id=%s AND seller_id=%s AND state IN ('UNKNOWN','PENDING_PAYMENT') AND next_check<=now() ORDER BY next_check LIMIT 10) RETURNING *", (config.mode, config.app_id, config.seller_id))).fetchall()
        refunds = await (await conn.execute("UPDATE payment_refunds SET next_check=now()+interval '60 seconds' WHERE id IN (SELECT r.id FROM payment_refunds r JOIN payment_orders o ON o.id=r.order_id WHERE r.state='UNKNOWN' AND r.next_check<=now() AND o.environment=%s AND o.app_id=%s AND o.seller_id=%s ORDER BY r.next_check LIMIT 10) RETURNING *", (config.mode, config.app_id, config.seller_id))).fetchall()
    for order in orders:
        try:
            await query(order, config)
        except HTTPException:
            pass  # Retain evidence and retry reads after next_check, never replay a write.
    for receipt in refunds:
        try:
            order = (await auth.db().rows('SELECT * FROM payment_orders WHERE id=%s', (receipt['order_id'],)))[0]
            await refund_query(order, receipt['id'])
        except HTTPException:
            pass


async def reconcile_loop() -> None:
    while True:
        try:
            await reconcile_once()
        except Exception:  # noqa: BLE001 - SDK failures may contain secrets; retain unknown receipts
            logging.getLogger(__name__).warning('Payment reconciliation deferred; pending receipts retained')
        await asyncio.sleep(5)
