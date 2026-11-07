"""Same-origin account payment controls and signed provider notifications."""
from pathlib import Path
from typing import Annotated
from urllib.parse import parse_qsl

from fastapi import APIRouter, HTTPException, Request
from fastapi import Path as Parameter
from starlette.responses import FileResponse, HTMLResponse, PlainTextResponse

from . import identity as auth
from . import payments
from .account_api import confirm
from .contracts import (
    PaymentCreate,
    PaymentForm,
    PaymentOffer,
    PaymentOrder,
    PaymentRefund,
    PaymentRefundRequest,
)
from .payment_config import cents, load, money

router = APIRouter()
ASSETS = Path(__file__).parent / 'payment_assets'
OrderId = Annotated[str, Parameter(pattern=r'^[a-f0-9]{32}$')]


async def query_limit() -> None:
    user = auth.actor.get()
    assert user is not None
    await auth.rate('payment-query:' + user['id'], 120, 3600)


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


@router.post('/api/me/payments', response_model=PaymentForm)
async def create(value: PaymentCreate):
    user = auth.actor.get()
    assert user is not None
    await auth.rate('payment:' + user['id'], 30, 3600)
    return await payments.create(str(value.requestId))


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


@router.get('/payments', response_class=HTMLResponse)
@router.get('/payments/return', response_class=HTMLResponse)
async def payment_page():
    return HTMLResponse((ASSETS / 'index.html').read_text(), headers={'Cache-Control': 'no-store'})


@router.get('/payments/client.js')
async def payment_script():
    return FileResponse(ASSETS / 'client.js', media_type='text/javascript')


@router.get('/payments/style.css')
async def payment_style():
    return FileResponse(ASSETS / 'style.css', media_type='text/css')


@router.get('/payments/octopus.png')
async def payment_logo():
    return FileResponse(ASSETS / 'octopus.png', media_type='image/png')
