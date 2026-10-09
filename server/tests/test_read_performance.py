"""Bounded read work and completed-head reuse preserve authoritative state."""
import asyncio
import json
import threading
from datetime import timedelta
from typing import Any, cast
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from langgraph.types import Interrupt

from practiq_ai import task_api
from practiq_ai.contracts import DocumentReference, DocumentTaskCreate
from practiq_ai.database import utcnow
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.graphs import document
from tests.db_support import setup_api
from tests.support import parsed, source


async def test_merge_runs_off_the_event_loop_without_changing_saved_questions(monkeypatch):
    threads = []
    original = document.merge_chunk_results
    def merge(*args, **kwargs):
        threads.append(threading.get_ident())
        return original(*args, **kwargs)
    monkeypatch.setattr(document, 'merge_chunk_results', merge)
    files, reference = source('Saved question')
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    result = await document._merge(cast(Any, {
        'document': reference,
        'chunkResults': [{'index': 0, 'parsed': parsed('Saved question')}],
    }))
    assert threads and threads[0] != threading.get_ident()
    assert result['result']['questions'][0]['stem'] == 'Saved question'
    assert result['processing']['questionSources'][0]['unitIndex'] == 0


async def test_completed_heads_share_bounded_summaries_and_invalidate_on_changes(monkeypatch, disposable_databases):
    service, reference, model = await setup_api(monkeypatch, [parsed()])
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await service.wait_idle()
    service.stopping = True
    service.wake.set()
    await service.loop
    tid = created['threadId']
    detail = await task_api.get_task(tid)
    await task_api.list_tasks()
    snapshots = AsyncMock(wraps=service.snapshot)
    monkeypatch.setattr(service, 'snapshot', snapshots)
    head = await task_api.get_task_head(tid)
    assert head == {key: detail[key] for key in ('threadId', 'runId', 'state', 'checkpointId', 'updatedAt', 'modelConfigured', 'resumeCompatible')}
    assert await task_api.get_task_head(tid) == head
    assert snapshots.await_count == 0
    assert len(service.task_summaries) == 1
    monkeypatch.setenv('AI_READ_ONLY', '1')
    disabled = await task_api.get_task_head(tid)
    assert not disabled['modelConfigured'] and not disabled['resumeCompatible']
    monkeypatch.delenv('AI_READ_ONLY')
    monkeypatch.setenv('LLM_MODEL', 'changed-model')
    assert not (await task_api.get_task_head(tid))['resumeCompatible']
    monkeypatch.setenv('LLM_MODEL', 'test-model')
    run_id = str(uuid4())
    async with service.db.connection() as conn:
        await conn.execute("INSERT INTO document_runs(run_id,thread_id,request_id,context,status,created_at) VALUES(%s,%s,%s,'{}','pending',%s)",
                           (run_id, tid, run_id, utcnow() + timedelta(seconds=1)))
    for _ in range(2):
        active = await task_api.get_task_head(tid)
        assert active['state'] == 'PENDING' and active['runId'] == run_id
    assert snapshots.await_count == 2
    async with service.db.connection() as conn:
        await conn.execute('DELETE FROM document_runs WHERE run_id=%s', (run_id,))
    await service.graph.aupdate_state({'configurable': {'thread_id': tid}}, {'status': 'SUCCEEDED', 'result': parsed('Changed')}, as_node='finish')
    changed = await task_api.get_task_head(tid)
    assert changed['checkpointId'] != head['checkpointId']
    assert await task_api.get_task_head(tid) == changed
    assert snapshots.await_count == 3
    async with service.db.connection() as conn:
        await conn.execute('UPDATE document_tasks SET expires_at=%s WHERE thread_id=%s', (utcnow() - timedelta(seconds=1), tid))
    with pytest.raises(DocumentProcessingError) as expired:
        await task_api.get_task_head(tid)
    assert expired.value.code == 'TASK_EXPIRED'
    await task_api.delete_task(tid)
    assert tid not in service.task_summaries
    with pytest.raises(DocumentProcessingError) as deleted:
        await task_api.get_task_head(tid)
    assert deleted.value.code == 'TASK_NOT_FOUND'
    assert len(model.calls) == 1


async def saved_units(monkeypatch, count):
    service, reference, model = await setup_api(monkeypatch, [])
    service.stopping = True
    service.wake.set()
    await service.loop
    tid = str(uuid4())
    async with service.db.connection() as conn:
        await conn.execute('INSERT INTO document_tasks(thread_id,request_hash,graph_id,document,failure_policy,expires_at) VALUES(%s,%s,%s,%s,%s,%s)',
                           (tid, tid, 'document_parser', json.dumps(reference), 'return_partial', utcnow() + timedelta(days=1)))
    units = [{'index': index, 'parsed': parsed(f'Question {index}')} for index in reversed(range(count))]
    await service.graph.aupdate_state({'configurable': {'thread_id': tid}}, {'chunkResults': units}, as_node='finish')
    return tid, model


async def test_preview_reads_are_bounded_concurrent_and_keep_unit_order(monkeypatch, disposable_databases):
    monkeypatch.setenv('AI_STORAGE_CONCURRENCY', '2')
    tid, model = await saved_units(monkeypatch, 6)
    entered = asyncio.Event()
    release = asyncio.Event()
    active = peak = 0
    async def read(item, _source_sha256):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        if active == 2:
            entered.set()
        try:
            await release.wait()
            await asyncio.sleep((6 - item['index']) * .001)
            return item
        finally:
            active -= 1
    monkeypatch.setattr(task_api, 'load_unit_result', read)
    review = asyncio.create_task(task_api.review_task(tid))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        assert peak == 2
    finally:
        release.set()
        result = await review
    assert [unit['index'] for unit in result['units']] == list(range(6))
    assert peak == 2 and active == 0 and not model.calls


@pytest.mark.parametrize('outcome', ['failure', 'cancel'])
async def test_preview_failure_or_cancellation_joins_pending_reads(monkeypatch, disposable_databases, outcome):
    tid, model = await saved_units(monkeypatch, 2)
    entered = asyncio.Event()
    cancelled = asyncio.Event()
    async def read(item, _source_sha256):
        if item['index'] == 0:
            await asyncio.wait_for(entered.wait(), 1)
            if outcome == 'failure':
                raise DocumentProcessingError(409, 'Checksum mismatch', 'DOCUMENT_CHECKSUM_MISMATCH')
            await asyncio.Event().wait()
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()
    monkeypatch.setattr(task_api, 'load_unit_result', read)
    review = asyncio.create_task(task_api.review_task(tid))
    if outcome == 'failure':
        with pytest.raises(DocumentProcessingError) as failed:
            await review
        assert failed.value.code == 'DOCUMENT_CHECKSUM_MISMATCH'
    else:
        await asyncio.wait_for(entered.wait(), 1)
        review.cancel()
        with pytest.raises(asyncio.CancelledError):
            await review
    assert cancelled.is_set() and not model.calls


async def test_heads_recheck_same_checkpoint_interrupts_without_caching(monkeypatch, disposable_databases):
    tid, model = await saved_units(monkeypatch, 1)
    service = task_api.client()
    task = (await service.db.rows('SELECT * FROM document_tasks WHERE thread_id=%s', (tid,)))[0]
    snapshot = await service.snapshot(task)
    current = snapshot._replace(interrupts=(Interrupt({'kind': 'pause'}),))
    snapshots = AsyncMock(side_effect=lambda _task: current)
    monkeypatch.setattr(service, 'snapshot', snapshots)
    paused = await task_api.get_task_head(tid)
    current = snapshot._replace(interrupts=(Interrupt({'kind': 'review'}),))
    review = await task_api.get_task_head(tid)
    assert paused['checkpointId'] == review['checkpointId']
    assert paused['state'] == 'PAUSED' and review['state'] == 'WAITING_REVIEW'
    assert snapshots.await_count == 2 and tid not in service.task_summaries
    assert not model.calls
