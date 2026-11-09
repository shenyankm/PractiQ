"""Same-origin account payment controls and signed provider notifications."""
from typing import Annotated
from urllib.parse import parse_qsl

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi import Path as Parameter
from starlette.responses import HTMLResponse, PlainTextResponse

from . import billing, payments
from . import identity as auth
from .account_api import confirm
from .contracts import (
    AccountPlan,
    AdministrationFilter,
    AdministrationPaymentOrder,
    PaymentCreate,
    PaymentForm,
    PaymentOffer,
    PaymentOrder,
    PaymentRefund,
    PaymentRefundRequest,
)
from .payment_config import cents, load, money

router = APIRouter()
OrderId = Annotated[str, Parameter(pattern=r'^[a-f0-9]{32}$')]


async def query_limit() -> None:
    user = auth.actor.get()
    assert user is not None
    await auth.rate('payment-query:' + user['id'], 120, 3600)


@router.get('/api/me/plans', response_model=AccountPlan)
async def plans():
    user = auth.actor.get()
    assert user is not None
    async with auth.db().connection() as conn:
        state = await billing.balance(conn, user)
    try:
        config = load()
    except HTTPException:
        config = None
    return {'products': billing.PRODUCTS, 'balance': state, 'checkoutEnabled': config is not None,
            'environment': config.mode if config else None,
            'sandboxAmount': money(config.amount) if config and config.mode == 'sandbox' else None}


@router.get('/api/me/payments/offer', response_model=PaymentOffer)
async def offer():
    config = load()
    return {'amount': money(config.amount), 'subject': config.subject, 'environment': config.mode}


@router.get('/api/me/payments', response_model=list[PaymentOrder])
async def orders():
    user = auth.actor.get()
    assert user is not None
    rows = await auth.db().rows('SELECT * FROM payment_orders WHERE owner_id=%s ORDER BY created_at DESC LIMIT 50', (user['id'],))
    return [await payments.snapshot(order) for order in rows]


async def admin_snapshot(order: dict) -> dict:
    async with auth.db().connection() as conn:
        user = await (await conn.execute('SELECT * FROM auth_users WHERE id=%s', (order['owner_id'],))).fetchone()
        assert user is not None
        grants = (await billing.balance(conn, user))['grants']
    return {**await payments.snapshot(order), 'ownerId': order['owner_id'], 'createdAt': order['created_at'],
            'grant': next((g for g in grants if g['orderId'] == order['id']), None)}


@router.get('/api/admin/payments', response_model=list[AdministrationPaymentOrder])
async def admin_orders(filters: Annotated[AdministrationFilter, Query()]):
    if filters.issue not in {None, 'refund', 'unknown'}:
        raise HTTPException(422, {'code': 'INVALID_PAYMENT_ISSUE'})
    from .admin_api import period
    where, args = period(filters, 'p.created_at')
    if filters.userId:
        where += ' AND p.owner_id=%s'
        args.append(filters.userId)
    if filters.q:
        where += ' AND (strpos(lower(u.email),lower(%s))>0 OR strpos(p.id,%s)>0 OR strpos(lower(p.subject),lower(%s))>0)'
        args += [filters.q] * 3
    if filters.state:
        if filters.state not in {'UNKNOWN', 'PENDING_PAYMENT', 'PAID', 'CLOSED'}:
            raise HTTPException(422, {'code': 'INVALID_PAYMENT_STATE'})
        where += ' AND p.state=%s'
        args.append(filters.state)
    if filters.environment:
        where += ' AND p.environment=%s'
        args.append(filters.environment)
    if filters.issue == 'refund':
        where += " AND (EXISTS (SELECT 1 FROM page_grants g WHERE g.order_id=p.id AND g.state='refund_pending') OR EXISTS (SELECT 1 FROM payment_refunds r WHERE r.order_id=p.id AND r.state='UNKNOWN'))"
    if filters.issue == 'unknown':
        where += " AND p.state='UNKNOWN'"
    rows = await auth.db().rows(f'SELECT p.* FROM payment_orders p JOIN auth_users u ON u.id=p.owner_id WHERE true {where} ORDER BY p.created_at DESC,p.id LIMIT 50 OFFSET %s', (*args, filters.offset))
    return [await admin_snapshot(order) for order in rows]


@router.get('/api/admin/payments/{order_id}', response_model=AdministrationPaymentOrder)
async def admin_order(order_id: OrderId):
    return await admin_snapshot(await payments.order_for(order_id, admin=True))


@router.post('/api/admin/payments/{order_id}/query', response_model=AdministrationPaymentOrder)
async def admin_order_query(order_id: OrderId):
    await query_limit()
    return await admin_snapshot(await payments.query(await payments.order_for(order_id, admin=True)))


@router.post('/api/me/payments', response_model=PaymentForm)
async def create(value: PaymentCreate):
    user = auth.actor.get()
    assert user is not None
    await auth.rate('payment:' + user['id'], 30, 3600)
    return await payments.create(str(value.requestId), value.productId)


@router.get('/api/me/payments/{order_id}', response_model=PaymentOrder)
async def order_read(order_id: OrderId):
    return await payments.snapshot(await payments.order_for(order_id))


@router.post('/api/me/payments/{order_id}/query', response_model=PaymentOrder)
async def order_query(order_id: OrderId):
    await query_limit()
    return await payments.snapshot(await payments.query(await payments.order_for(order_id)))


@router.post('/api/me/payments/{order_id}/form', response_model=PaymentForm)
async def order_form(order_id: OrderId):
    await query_limit()
    order = await payments.query(await payments.order_for(order_id))
    return await payments.payment_form(order, load())


@router.post('/api/me/payments/{order_id}/close', response_model=PaymentOrder)
async def order_close(order_id: OrderId):
    await query_limit()
    return await payments.close(await payments.order_for(order_id))


@router.post('/api/admin/payments/{order_id}/refunds', response_model=PaymentRefund)
async def refund(order_id: OrderId, value: PaymentRefundRequest):
    await confirm(value.currentPassword)
    try:
        amount = cents(value.amount)
    except ValueError:
        raise HTTPException(422, {'code': 'REFUND_AMOUNT_INVALID'}) from None
    return await payments.refund(await payments.order_for(order_id, admin=True), str(value.requestId), amount, value.reason)


@router.post('/api/admin/payments/{order_id}/refunds/{refund_id}/query', response_model=PaymentRefund)
async def refund_query(order_id: OrderId, refund_id: str):
    await query_limit()
    return await payments.refund_query(await payments.order_for(order_id, admin=True), refund_id)


@router.post('/payments/notify', response_class=PlainTextResponse)
async def notify(request: Request):
    try:
        if request.headers.get('content-type', '').split(';')[0].lower() != 'application/x-www-form-urlencoded':
            return PlainTextResponse('fail')
        pairs = parse_qsl((await request.body()).decode('utf-8'), keep_blank_values=True, strict_parsing=True, max_num_fields=100)
        params = dict(pairs)
        if len(pairs) != len(params):
            return PlainTextResponse('fail')
        return PlainTextResponse('success' if await payments.notify(params) else 'fail')
    except Exception:  # noqa: BLE001 - the provider must receive fail without leaking raw parameters
        return PlainTextResponse('fail')


@router.get('/payments/return', response_class=HTMLResponse)
async def payment_return():
    # Return parameters are never proof of payment; the native app queries its receipt.
    return HTMLResponse('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>返回 PractiQ</title><h1>请返回 PractiQ App</h1><p>正在确认支付结果。请在 App 的订单与付款中查询原订单；同步回跳不代表付款成功。</p></html>', headers={'Cache-Control': 'no-store'})
