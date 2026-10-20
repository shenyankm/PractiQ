"""Checkpoint metadata lookups against disposable PostgreSQL."""
from tests.db_support import new_database


async def test_checkpoint_heads_preserves_scope_missing_and_duplicate_requests(disposable_databases):
    db = await new_database()
    async with db.connection() as conn:
        for thread, namespace, identifier in [('a', '', '001'), ('b', '', '002'), ('a', '', '003'),
                                               ('a', 'nested', '999'), ('nested-only', 'nested', '999')]:
            await conn.execute("INSERT INTO checkpoints(thread_id,checkpoint_ns,checkpoint_id,checkpoint) VALUES(%s,%s,%s,'{}')",
                               (thread, namespace, identifier))
    assert await db.checkpoint_heads(['b', 'a', 'missing', 'a', 'nested-only']) == {'a': '003', 'b': '002'}
    assert await db.checkpoint_heads([]) == {}
    assert await db.checkpoint_heads(['missing', 'nested-only']) == {}
    async with db.connection() as conn:
        await conn.execute("INSERT INTO checkpoints(thread_id,checkpoint_id,checkpoint) VALUES('b','004','{}')")
    assert await db.checkpoint_heads(['b', 'a']) == {'a': '003', 'b': '004'}
