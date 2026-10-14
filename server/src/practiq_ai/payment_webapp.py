"""Separately deployed loopback Vibe Pay entry point; no AI-service routes."""

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated
from urllib.parse import parse_qsl

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles
from psycopg import Error as DatabaseError

from . import saas
from .config import SERVER_ROOT
from .contracts import (
    ImportAccount,
    PaymentLink,
    PaymentOrder,
    PaymentOrderCreate,
    PaymentOrders,
    PaymentProducts,
)
from .database import Database, watch_ownership
from .errors import DocumentProcessingError
from .middleware import SecurityHeadersMiddleware
from .payments import Checkout, Settings, check_schema


@asynccontextmanager
async def lifespan(application: FastAPI):
    load_dotenv(SERVER_ROOT.parent / '.env.payments', override=False)
    settings, db = Settings.load(), Database()
    owner = monitor = None
    try:
        await db.open()
        owner = await db.acquire('Another checkout owns this database', slot=3)
        await db.check_schema()
        await check_schema(db, settings)
        monitor = asyncio.create_task(watch_ownership(owner, lambda: os._exit(70)))
        application.state.checkout = Checkout(db, settings)
        yield
    finally:
        if monitor:
            monitor.cancel()
            await asyncio.gather(monitor, return_exceptions=True)
        await db.close()
        if owner:
            await owner.close()


app = FastAPI(lifespan=lifespan)
app.add_middleware(SecurityHeadersMiddleware)


@app.middleware('http')
async def payment_errors(request: Request, call_next):
    from fastapi.responses import JSONResponse
    try:
        response = await call_next(request)
    except DocumentProcessingError as exc:
        response = JSONResponse({'detail': {'code': exc.code}}, exc.status_code)
    except DatabaseError:
        response = JSONResponse({'detail': {'code': 'PAYMENT_DATABASE_UNAVAILABLE'}}, 503)
    except Exception:  # noqa: BLE001 — provider failures may include sensitive signed payloads
        # Provider exceptions can contain signed payloads; expose no diagnostics to browsers/logs.
        response = JSONResponse({'detail': {'code': 'PAYMENT_UNCONFIRMED'}}, 503)
    response.headers['Cache-Control'] = 'no-store'
    return response


def checkout(request: Request) -> Checkout:
    return request.app.state.checkout


async def account_access(service: Annotated[Checkout, Depends(checkout)], authorization: str | None = Header(default=None),
                         x_practiq_phone: str | None = Header(default=None)) -> str:
    scheme, _, credential = (authorization or '').partition(' ')
    if scheme.lower() != 'account':
        raise HTTPException(401, {'code': 'ACCOUNT_REQUIRED'})
    return await saas.identity(x_practiq_phone or '', credential, database=service.db)


async def bounded_body(request: Request) -> bytes:
    body = bytearray()
    try:
        async with asyncio.timeout(10):
            async for part in request.stream():
                if len(body) + len(part) > 16 * 1024:
                    raise HTTPException(413, {'code': 'PAYMENT_BODY_TOO_LARGE'})
                body.extend(part)
    except TimeoutError as exc:
        raise HTTPException(408, {'code': 'PAYMENT_BODY_TIMEOUT'}) from exc
    return bytes(body)


@app.get('/ok')
async def health():
    return {'status': 'ok'}


@app.get('/api/payments/products', response_model=PaymentProducts)
async def products(service: Annotated[Checkout, Depends(checkout)]):
    return await service.products()


@app.post('/api/payments/orders', response_model=PaymentOrder)
async def create(request: Request, service: Annotated[Checkout, Depends(checkout)], account: Annotated[str, Depends(account_access)]):
    from pydantic import ValidationError
    try:
        data = PaymentOrderCreate.model_validate_json(await bounded_body(request))
    except ValidationError as exc:
        raise HTTPException(422, {'code': 'PAYMENT_REQUEST_INVALID'}) from exc
    return await service.create(data, account)


@app.get('/api/payments/account', response_model=ImportAccount)
async def account_summary(service: Annotated[Checkout, Depends(checkout)], account: Annotated[str, Depends(account_access)]):
    return await saas.account_summary(account, database=service.db)


@app.get('/api/payments/orders', response_model=PaymentOrders)
async def orders(service: Annotated[Checkout, Depends(checkout)], account: Annotated[str, Depends(account_access)],
                 offset: int = Query(default=0, ge=0, le=10000)):
    return await service.orders(account, offset)


@app.get('/api/payments/orders/{order_id}', response_model=PaymentOrder)
async def read(order_id: str, service: Annotated[Checkout, Depends(checkout)], account: Annotated[str, Depends(account_access)]):
    return await service.read(order_id, account)


@app.post('/api/payments/orders/{order_id}/pay', response_model=PaymentLink)
async def pay(order_id: str, service: Annotated[Checkout, Depends(checkout)], account: Annotated[str, Depends(account_access)]):
    row = await service.owned(order_id, account)
    return {'url': service.pay_url(row)}


@app.post('/api/payments/notify', response_class=PlainTextResponse)
async def notify(request: Request, service: Annotated[Checkout, Depends(checkout)]):
    if request.headers.get('content-type', '').split(';')[0].strip() != 'application/x-www-form-urlencoded':
        raise HTTPException(415, 'failure')
    try:
        fields = parse_qsl((await bounded_body(request)).decode('utf-8'), keep_blank_values=True, strict_parsing=True, max_num_fields=100)
    except (UnicodeDecodeError, ValueError) as exc:
        raise HTTPException(400, 'failure') from exc
    if len(dict(fields)) != len(fields):
        raise HTTPException(400, 'failure')
    params = dict(fields)
    service.verify_notify(params)
    await service.confirm(params)
    return 'success'


# Shared Web build selects the checkout using this public, credential-free path.
web_dir = Path(os.environ.get('AI_WEB_DIR', str(Path(__file__).resolve().parents[3] / 'web/dist')))
def mount_checkout_web(application: FastAPI, directory: Path):
    if not (directory / 'index.html').is_file():
        return

    @application.get('/', include_in_schema=False)
    async def checkout_home():
        from fastapi.responses import RedirectResponse
        return RedirectResponse('/purchase', status_code=303)

    @application.get('/purchase', include_in_schema=False)
    async def purchase():
        from fastapi.responses import FileResponse
        return FileResponse(directory / 'index.html')
    application.mount('/', StaticFiles(directory=directory, html=True), name='checkout-web')


mount_checkout_web(app, web_dir)
