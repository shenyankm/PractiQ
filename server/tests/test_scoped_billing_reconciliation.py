import json

import pytest

from practiq_ai import runtime, saas
from practiq_ai.execution import namespace
from tests.db_support import new_database, seed_account


@pytest.mark.usefixtures('disposable_databases')
async def test_thread_reconciliation_preserves_other_calls_and_settles_saved_usage_once():
    db = await new_database()
    await seed_account(db)
    await seed_account(db, number='13900139000')
    accounts = await db.rows('SELECT account_id FROM import_accounts ORDER BY phone')
    owner, other = (account['account_id'] for account in accounts)
    thread_id, other_thread = 'deadline-thread', 'other-live-thread'
    rates = {'inputMicropointsPer1k': 1_000_000, 'outputMicropointsPer1k': 3_000_000}

    async def pending(key, account, thread, dispatched, result=None):
        async with db.transaction() as conn:
            await conn.execute(
                "INSERT INTO import_calls(call_key,account_id,thread_id,result_key,rates,status,dispatched) "
                "VALUES(%s,%s,%s,%s,%s,'pending',%s)",
                (key, account, thread, result, json.dumps(rates), dispatched),
            )

    usage = {'inputTokens': 10, 'outputTokens': 5}
    await pending('known', owner, thread_id, True, 'known-result')
    await pending('other-live', other, other_thread, True)
    await db.store.aput(namespace(thread_id, 'model_results'), 'known-result', {'usage': usage}, index=False)
    for _ in range(2):
        await saas.reconcile(db, thread_id=thread_id)
    assert (await db.rows("SELECT status,usage FROM import_calls WHERE call_key='known'")) == [
        {'status': 'settled', 'usage': usage},
    ]
    assert await db.rows("SELECT amount FROM import_ledger WHERE kind='model'") == [{'amount': -25_000}]

    run_id = 'deadline-run'
    service = runtime.Service(db)
    await pending('undispatched', owner, thread_id, False)
    await db.store.aput(namespace(thread_id, 'calls'), 'undispatched', {'runId': run_id, 'status': 'started'}, index=False)
    assert await service.unknown_calls({'run_id': run_id, 'thread_id': thread_id})
    await saas.reconcile(db, thread_id=thread_id)
    assert not await service.unknown_calls({'run_id': run_id, 'thread_id': thread_id})
    assert await db.rows("SELECT status,usage FROM import_calls WHERE call_key='undispatched'") == [
        {'status': 'rejected', 'usage': None},
    ]

    await pending('unknown', owner, thread_id, True)
    await saas.reconcile(db, thread_id=thread_id)
    assert await db.rows("SELECT status,usage FROM import_calls WHERE call_key='unknown'") == [
        {'status': 'unknown', 'usage': None},
    ]
    assert await db.rows("SELECT status,usage FROM import_calls WHERE call_key='other-live'") == [
        {'status': 'pending', 'usage': None},
    ]
    assert await db.rows("SELECT amount FROM import_ledger WHERE kind='model'") == [{'amount': -25_000}]
    assert all(row['rates'] == rates for row in await db.rows('SELECT rates FROM import_calls'))
