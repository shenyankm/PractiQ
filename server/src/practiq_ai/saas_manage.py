"""Explicit product/card operations and manual reconciliation; no model calls."""

import argparse
import asyncio
import json
import os
import re
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import load_dotenv

from .database import Database
from .saas import digest, new_card, points, settle


async def run(args: argparse.Namespace) -> None:
    database = Database()
    await database.open()
    try:
        await database.check_schema()
        if args.action == 'product':
            url = urlsplit(args.purchase_url)
            if not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', args.id) or not args.name.strip() or len(args.name) > 255:
                raise ValueError('Invalid product ID or name')
            if url.scheme != 'https' or not url.hostname or url.username or url.password or len(args.purchase_url) > 2048:
                raise ValueError('A trusted HTTPS shop URL is required')
            async with database.transaction() as conn:
                await conn.execute('INSERT INTO import_products VALUES(%s,%s,%s,%s,%s) '
                                   'ON CONFLICT(product_id) DO UPDATE SET name=excluded.name,points=excluded.points,purchase_url=excluded.purchase_url,enabled=excluded.enabled',
                                   (args.id, args.name.strip(), points(args.points), args.purchase_url, not args.disabled))
            print('Product saved; existing card entitlements are unchanged')
        elif args.action == 'generate':
            if not 1 <= args.count <= 10_000:
                raise ValueError('Count must be between 1 and 10000')
            cards = [new_card() for _ in range(args.count)]
            # Never overwrite an export, and never print a credential to the terminal.
            with os.fdopen(os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as output:
                async with database.transaction() as conn:
                    product = await (await conn.execute('SELECT * FROM import_products WHERE product_id=%s AND enabled FOR UPDATE', (args.product,))).fetchone()
                    if not product:
                        raise ValueError('Enabled product not found')
                    for card in cards:
                        await conn.execute('INSERT INTO import_cards(digest,product_id,points) VALUES(%s,%s,%s)', (digest(card), args.product, product['points']))
                    output.write('\n'.join(cards) + '\n')
                    output.flush()
                    os.fsync(output.fileno())
            print(f'Generated {len(cards)} cards; protect the export and import it into the shop')
        elif args.action == 'revoke':
            async with database.transaction() as conn:
                row = await (await conn.execute('UPDATE import_cards SET revoked=true WHERE digest=%s RETURNING digest', (args.digest,))).fetchone()
                if not row:
                    raise ValueError('Card digest not found')
            print('Card access revoked; existing points and ledger retained')
        elif args.action == 'unknown':
            rows = await database.rows("SELECT call_key,phone,thread_id,created_at,rates FROM import_calls JOIN import_accounts USING(account_id) WHERE status='unknown' ORDER BY created_at")
            print(json.dumps(rows, default=str, ensure_ascii=False))
        elif args.action == 'resolve':
            if args.input_tokens < 0 or args.output_tokens < 0 or not args.note.strip() or len(args.note) > 1000:
                raise ValueError('Nonnegative actual token counts and a bounded reconciliation note are required')
            rows = await database.rows('SELECT status,usage FROM import_calls WHERE call_key=%s', (args.call_key,))
            usage = {'inputTokens': args.input_tokens, 'outputTokens': args.output_tokens}
            if not rows or rows[0]['status'] not in {'unknown', 'settled'}:
                raise ValueError('Unknown call not found')
            if rows[0]['status'] == 'settled' and any(rows[0]['usage'].get(key) != usage[key] for key in usage):
                raise ValueError('Call was already resolved with different usage')
            await settle(args.call_key, usage, note=args.note, database=database)
            print('Usage reconciled; explicit user recovery is still required')
    finally:
        await database.close()


def main() -> None:
    from .config import SERVER_ROOT
    load_dotenv(SERVER_ROOT.parent / '.env', override=False)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    product = commands.add_parser('product')
    for option in ('id', 'name', 'points', 'purchase-url'):
        product.add_argument('--' + option, required=True)
    product.add_argument('--disabled', action='store_true')
    generate = commands.add_parser('generate')
    generate.add_argument('--product', required=True)
    generate.add_argument('--count', type=int, required=True)
    generate.add_argument('--output', type=Path, required=True)
    revoke = commands.add_parser('revoke')
    revoke.add_argument('--digest', required=True)
    commands.add_parser('unknown')
    resolve = commands.add_parser('resolve')
    resolve.add_argument('--call-key', required=True)
    resolve.add_argument('--input-tokens', type=int, required=True)
    resolve.add_argument('--output-tokens', type=int, required=True)
    resolve.add_argument('--note', required=True)
    asyncio.run(run(parser.parse_args()))


if __name__ == '__main__':
    main()
