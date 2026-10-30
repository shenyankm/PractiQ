"""Equivalent read/planning outputs with bounded CPU and storage work."""

import asyncio
import threading
from copy import deepcopy
from datetime import timedelta
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
from pydantic import ValidationError

from practiq_ai import task_api, webapp
from practiq_ai.contracts import (
    ArtifactReference,
    DocumentParseResult,
    DocumentTaskDetail,
    DocumentTaskReview,
)
from practiq_ai.database import utcnow
from practiq_ai.graphs import document
from tests.support import parsed, source


@pytest.fixture(autouse=True)
def configuration(monkeypatch):
    monkeypatch.setenv('AI_SERVICE_TOKEN', 'read-path-test')
    monkeypatch.setenv('AI_READ_ONLY', '1')


@pytest.mark.parametrize('unit_scoped', [False, True])
async def test_chunk_planning_uses_worker_and_preserves_complete_plan(monkeypatch, unit_scoped):
    text = '\n'.join(f'{i}. Short answer: 原题 {i}\nReference answer: A{i}' for i in range(1, 41))
    files, reference = source(text)
    text_ref = await files.put_artifact(text.encode(), source_sha256=reference['sha256'], kind='text', index=0, media_type='text/plain')
    state: dict[str, Any] = {'document': reference, 'textRef': text_ref.model_dump(mode='json')}
    if unit_scoped:
        state['textUnits'] = [
            {'start': 0, 'end': 0, 'sourceType': 'text', 'fileName': 'empty.txt', 'sourceIndex': 0},
            {'start': 0, 'end': len(text), 'sourceType': 'text', 'fileName': 'quiz.txt', 'sourceIndex': 1},
        ]
    original_state = deepcopy(state)
    split, presence = document.split_chunk_plan, document.source_presence_plan
    spans, header, counts = split(text, source_type='text')
    hints = presence(text, spans, source_type='text')
    threads = []

    def observed(function):
        def run(*args, **kwargs):
            threads.append(threading.get_ident())
            return function(*args, **kwargs)
        return run

    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    monkeypatch.setattr(document, 'split_chunk_plan', observed(split))
    monkeypatch.setattr(document, 'source_presence_plan', observed(presence))
    result = await document._assemble(cast(Any, state))
    assert threads and all(thread != threading.get_ident() for thread in threads)
    assert result['chunkSpans'] == spans and result['chunkNodeCounts'] == counts
    assert result['chunkPresence'] == hints
    assert result['chunkHeaders'] == [header if span['start'] else None for span in spans]
    assert result['chunkSources'] == ([{'fileName': 'quiz.txt', 'sourceType': 'text', 'sourceIndex': 1}] * len(spans) if unit_scoped else [])
    assert state == original_state
    assert [await files.get_verified(ArtifactReference.model_validate(ref)) for ref in result['chunkRefs']] == [
        text[span['start']:span['end']].encode() for span in spans
    ]


@pytest.mark.parametrize('failure', [False, True])
async def test_chunk_planning_drains_cancelled_worker_before_writing(monkeypatch, failure):
    files, reference = source('1. Short answer: Printed question')
    text_ref = await files.put_artifact(b'1. Short answer: Printed question', source_sha256=reference['sha256'], kind='text', index=0, media_type='text/plain')
    entered, release, exited = threading.Event(), threading.Event(), threading.Event()
    split = document.split_chunk_plan

    def planning(*args, **kwargs):
        entered.set()
        try:
            assert release.wait(5)
            if failure:
                raise ValueError('invalid source boundary')
            return split(*args, **kwargs)
        finally:
            exited.set()

    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    monkeypatch.setattr(document, 'split_chunk_plan', planning)
    task = asyncio.create_task(document._assemble(cast(Any, {'document': reference, 'textRef': text_ref.model_dump()})))
    try:
        assert await asyncio.to_thread(entered.wait, 3)
        if not failure:
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done() and not exited.is_set()
        release.set()
        with pytest.raises(ValueError if failure else asyncio.CancelledError):
            await task
        assert exited.is_set() and files.put_kinds == ['text']
    finally:
        release.set()
        await asyncio.gather(task, return_exceptions=True)


@pytest.fixture
async def saved_read(monkeypatch):
    files, reference = source('Printed question')
    ref = await files.put_artifact(b'Printed question', source_sha256=reference['sha256'], kind='chunk', index=0, media_type='text/plain')
    now = utcnow()
    thread = str(uuid4())
    result = DocumentParseResult.model_validate({'schemaVersion': 3, 'questions': [{**parsed()['questions'][0], 'id': 'q1'}],
                                                'groups': [], 'visualElements': [], 'warnings': [], 'confidenceScore': 80}).model_dump(mode='json')
    snapshot = SimpleNamespace(values={'result': result, 'status': 'SUCCEEDED', 'phase': 'completed', 'chunkRefs': [ref.model_dump(mode='json')]},
                               interrupts=(), next=(), created_at=now.isoformat())
    task = {'document': reference, 'parent_thread_id': None, 'created_at': now, 'expires_at': now + timedelta(days=1)}
    service = SimpleNamespace(db=SimpleNamespace(store=SimpleNamespace(asearch=AsyncMock(return_value=[]))), checkpoint_id=lambda *_: 'saved-checkpoint')
    read = AsyncMock(return_value=(task, snapshot, None))
    monkeypatch.setattr(task_api, 'client', lambda: service)
    monkeypatch.setattr(task_api, '_read_task', read)
    monkeypatch.setattr(task_api, '_calls', AsyncMock(return_value=[]))
    return thread, snapshot, read


async def test_http_reads_preserve_validated_models_and_default_json(saved_read):
    thread, snapshot, _ = saved_read
    before = deepcopy(snapshot.values)
    detail = await webapp.get_document_task(cast(Any, thread))
    review = await webapp.preview_document_task(cast(Any, thread), include_result=True)
    assert isinstance(detail, DocumentTaskDetail) and isinstance(review, DocumentTaskReview)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url='http://test', headers={'Authorization': 'Bearer read-path-test'}) as client:
        response = await client.get(f'/api/document-tasks/{thread}')
        assert response.status_code == 200 and response.json() == await task_api.get_task(thread)
        response = await client.get(f'/api/document-tasks/{thread}/preview')
        assert response.status_code == 200 and response.json() == await task_api.review_task(thread)
    assert snapshot.values == before


async def test_model_reads_still_validate_saved_content(saved_read):
    thread, snapshot, _ = saved_read
    snapshot.values['result']['questions'][0]['confidence'] = 2
    with pytest.raises(ValidationError):
        await task_api.get_task_model(thread)
    with pytest.raises(ValidationError):
        await task_api.review_task_model(thread)


async def test_metadata_preview_omits_only_merged_result_and_validates_query(saved_read):
    thread, snapshot, read = saved_read
    before = deepcopy(snapshot.values)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url='http://test') as client:
        path = f'/api/document-tasks/{thread}/preview'
        assert (await client.get(path + '?include_result=false')).status_code == 401
        read.assert_not_awaited()
        client.headers['Authorization'] = 'Bearer read-path-test'
        assert (await client.get(path + '?include_result=invalid')).status_code == 422
        full = await client.get(path)
        metadata = await client.get(path + '?include_result=false')
    assert full.status_code == metadata.status_code == 200
    full_body = full.json()
    assert metadata.json() == {**full_body, 'units': [unit for unit in full_body['units'] if unit['stage'] != 'result']}
    assert len(metadata.content) < len(full.content) and metadata.json()['units'][0]['sourceRef']
    assert snapshot.values == before


async def test_metadata_preview_retains_unmerged_partial_candidates(saved_read):
    thread, snapshot, _ = saved_read
    snapshot.values.pop('result')
    snapshot.values['chunkResults'] = [{'index': 0, 'parsed': parsed()}]
    expected = await task_api.review_task(thread)
    actual = await task_api.review_task_model(thread, include_result=False)
    assert actual.model_dump(mode='json') == expected and actual.units[0].questions
