"""Explicit checkout schema/product setup and paid-order credit recovery; no models."""

import argparse
import asyncio

from dotenv import load_dotenv

from .config import SERVER_ROOT
from .database import Database
from .manage import exclusive
from .payments import Checkout, Settings, check_schema, initialize
from .saas import phone


async def run(args: argparse.Namespace):
    db, settings = Database(), Settings.load()
    await db.open()
    try:
        if args.action == 'init-db':
            async with exclusive(db):
                await initialize(db, settings)
            print('Initialized optional payment schema; retained accounts and historical records')
        else:
            await db.check_schema()
            await check_schema(db, settings)
            if args.action == 'product':
                if not 1 <= args.price_cents <= 10_000_000_000:
                    raise ValueError('Payment price must be between 1 and 10000000000 integer cents')
                async with db.transaction() as conn:
                    product = await (await conn.execute('SELECT product_id FROM import_products WHERE product_id=%s AND enabled', (args.product,))).fetchone()
                    if not product:
                        raise ValueError('Enabled import product not found')
                    await conn.execute('INSERT INTO payment_products VALUES(%s,%s,%s) ON CONFLICT(product_id) DO UPDATE SET price_cents=excluded.price_cents,enabled=excluded.enabled',
                                       (args.product, args.price_cents, not args.disabled))
                print('Checkout price saved; existing orders retain their frozen entitlements')
            elif args.action == 'bind-legacy':
                if not args.note.strip() or len(args.note)>1000:
                    raise ValueError('An operator ownership-verification note is required')
                async with exclusive(db), db.transaction() as conn:
                    account = await (await conn.execute('SELECT account_id FROM import_accounts WHERE phone=%s', (phone(args.phone),))).fetchone()
                    order = await (await conn.execute('SELECT * FROM payment_orders WHERE order_id=%s FOR UPDATE', (args.order_id,))).fetchone()
                    if not account or not order or order['account_id'] or order['status']=='fulfilled':
                        raise ValueError('Only an unallocated, unfulfilled legacy order may be assigned to a verified existing account')
                    await conn.execute('UPDATE payment_orders SET account_id=%s,request_id=%s,allocation_note=%s WHERE order_id=%s', (account['account_id'], args.order_id, args.note.strip(), args.order_id))
                print('Legacy order assigned; explicit reconciliation is required')
            elif args.action == 'reconcile':
                service = Checkout(db, settings)
                count, after = 0, ''
                while rows := await db.rows("SELECT order_id,status FROM payment_orders WHERE refund_evidence='{}'::jsonb AND status IN ('pending','paid','closed') AND order_id>%s ORDER BY order_id LIMIT 1000", (after,)):
                    for row in rows:
                        if row['status'] == 'paid':
                            await service.fulfill(row['order_id'])
                        else:
                            result = await service.query(row['order_id'])
                            if result.get('code') == '10000':
                                if result.get('out_trade_no') != row['order_id']:
                                    raise ValueError('Query returned another order')
                                await service.confirm(result)
                            elif result.get('sub_code') != 'ACQ.TRADE_NOT_EXIST':
                                raise ValueError('Payment query remains unknown; retry reconciliation')
                        count += 1
                    after = rows[-1]['order_id']
                print(f'Reconciled {count} orders; no credentials printed and no models started')
    finally:
        await db.close()


def main():
    load_dotenv(SERVER_ROOT.parent / '.env.payments', override=False)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    commands.add_parser('init-db')
    product = commands.add_parser('product')
    product.add_argument('--product', required=True)
    product.add_argument('--price-cents', type=int, required=True)
    product.add_argument('--disabled', action='store_true')
    commands.add_parser('reconcile')
    bind = commands.add_parser('bind-legacy')
    bind.add_argument('--order-id', required=True)
    bind.add_argument('--phone', required=True)
    bind.add_argument('--note', required=True)
    asyncio.run(run(parser.parse_args()))


if __name__ == '__main__':
    main()
