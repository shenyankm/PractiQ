"""Server-owned catalog and transactional page grants; no recurring charges."""
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from . import identity as auth
from .contracts import PlanProduct
from .payment_config import cents

PRODUCTS = (
    PlanProduct(id='free', name='Free', amount='0.00', pages=50, durationDays=None, activeTasks=1, priority=False),
    PlanProduct(id='plus', name='Plus', amount='39.00', pages=100, durationDays=30, activeTasks=2, priority=False),
    PlanProduct(id='pro', name='Pro', amount='99.00', pages=300, durationDays=30, activeTasks=3, priority=True),
    PlanProduct(id='pages50', name='50 页加量包', amount='19.90', pages=50, durationDays=365, activeTasks=1, priority=False),
)


def product(sku: str) -> PlanProduct:
    for item in PRODUCTS:
        if item.id == sku and sku != 'free':
            return item
    raise HTTPException(422, {'code': 'PLAN_PRODUCT_INVALID'})


async def balance(conn, user: dict, defaults: dict | None = None) -> dict:
    if defaults is None:
        defaults = (await (await conn.execute('SELECT value FROM auth_settings WHERE id=1')).fetchone())['value']
    assert defaults is not None
    now = datetime.now(UTC)
    rows = await (await conn.execute(
        'SELECT g.*,coalesce(sum(a.pages),0) AS used FROM page_grants g '
        'LEFT JOIN page_allocations a USING(order_id) WHERE g.owner_id=%s '
        'GROUP BY g.order_id ORDER BY g.expires_at,g.order_id', (user['id'],))).fetchall()
    grants = []
    plan, until = 'free', None
    for row in rows:
        item = PlanProduct.model_validate(row['product'])
        state = 'expired' if row['state'] == 'active' and row['expires_at'] <= now else row['state']
        grants.append({'orderId': row['order_id'], 'productId': item.id, 'totalPages': item.pages,
                       'usedPages': row['used'], 'remainingPages': max(0, item.pages - row['used']) if state == 'active' else 0,
                       'expiresAt': row['expires_at'], 'state': state})
        if state == 'active' and item.id in {'plus', 'pro'} and (plan != 'pro' or item.id == 'pro'):
            plan, until = item.id, row['expires_at']
    free = user['limits'].get('freePages', defaults.get('freePages', 50))
    used = max(0, await auth.page_usage(conn, user['id']) - sum(row['used'] for row in rows))
    remaining = max(0, free - used)
    tasks = user['limits'].get('activeTasks', defaults['activeTasks'] if plan == 'free' else product(plan).activeTasks)
    return {'plan': plan, 'expiresAt': until, 'activeTasks': tasks, 'freePages': free, 'freeUsedPages': used,
            'freeRemainingPages': remaining, 'remainingPages': remaining + sum(row['remainingPages'] for row in grants), 'grants': grants}


async def check_purchase(conn, user: dict, item: PlanProduct):
    if item.id in {'plus', 'pro'} and (await balance(conn, user))['plan'] != 'free':
        raise HTTPException(409, {'code': 'PLAN_ALREADY_ACTIVE', 'message': '当前套餐尚未到期，可购买加量包；到期后再选择套餐。'})


async def fulfill(conn, order: dict):
    # Historical and sandbox receipts never grant production entitlements.
    if order['state'] != 'PAID' or order.get('provider_closed') or order['environment'] != 'production' or not order.get('product'):
        return
    item = PlanProduct.model_validate(order['product'])
    if item.id == 'free' or order['amount'] != cents(item.amount) or item.durationDays is None:
        raise HTTPException(409, {'code': 'PLAN_ORDER_MISMATCH'})
    now = datetime.now(UTC)
    inserted = await (await conn.execute(
        'INSERT INTO page_grants(order_id,owner_id,product,starts_at,expires_at) VALUES(%s,%s,%s,%s,%s) '
        'ON CONFLICT DO NOTHING RETURNING order_id',
        (order['id'], order['owner_id'], Jsonb(order['product']), now, now + timedelta(days=item.durationDays)))).fetchone()
    if inserted:
        await auth.audit('plan_grant', order['id'], {'productId': item.id, 'pages': item.pages}, conn=conn)


async def allocate(conn, key: str, state: dict, pages: int):
    # Earliest expiry first; lifetime free pages are consumed only after paid grants.
    for grant in state['grants']:
        count = min(pages, grant['remainingPages'])
        if count:
            await conn.execute('INSERT INTO page_allocations VALUES(%s,%s,%s)', (key, grant['orderId'], count))
            pages -= count
        if not pages:
            break


async def settle(conn, key: str, pages: int):
    rows = await (await conn.execute(
        'SELECT a.*,g.expires_at FROM page_allocations a JOIN page_grants g USING(order_id) '
        'WHERE a.call_key=%s ORDER BY g.expires_at DESC,g.order_id DESC', (key,))).fetchall()
    release = max(0, sum(row['pages'] for row in rows) - pages)
    for row in rows:
        count = min(release, row['pages'])
        if count == row['pages']:
            await conn.execute('DELETE FROM page_allocations WHERE call_key=%s AND order_id=%s', (key, row['order_id']))
        elif count:
            await conn.execute('UPDATE page_allocations SET pages=pages-%s WHERE call_key=%s AND order_id=%s', (count, key, row['order_id']))
        release -= count
        if not release:
            break


async def freeze_refund(conn, order: dict, amount: int):
    if not order.get('product') or order['environment'] != 'production':
        return
    grant = await (await conn.execute('SELECT * FROM page_grants WHERE order_id=%s', (order['id'],))).fetchone()
    used = await (await conn.execute('SELECT 1 FROM page_allocations WHERE order_id=%s LIMIT 1', (order['id'],))).fetchone()
    if grant is None or grant['state'] != 'active' or used or amount != order['paid_amount']:
        raise HTTPException(409, {'code': 'PLAN_REFUND_REQUIRES_UNUSED_FULL_ORDER'})
    # An uncertain refund must not leave the same entitlement spendable.
    await conn.execute("UPDATE page_grants SET state='refund_pending' WHERE order_id=%s", (order['id'],))


async def finish_refund(conn, order_id: str):
    await conn.execute("UPDATE page_grants SET state='refunded' WHERE order_id=%s", (order_id,))


async def provider_closed(conn, order: dict):
    # Persist closure even before settlement: late PAID notifications cannot restore rights.
    await conn.execute("UPDATE payment_orders SET provider_closed=true,state=CASE WHEN state='PAID' THEN state ELSE 'CLOSED' END WHERE id=%s", (order['id'],))
    changed = await (await conn.execute("UPDATE page_grants SET state='refunded' WHERE order_id=%s AND state!='refunded' RETURNING order_id", (order['id'],))).fetchone()
    if changed:
        await auth.audit('plan_provider_closed', order['id'], conn=conn)
