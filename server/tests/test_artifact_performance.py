"""Artifact membership checks keep private reads bounded and exact."""
import json
from datetime import UTC, datetime, timedelta
from functools import partial
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi import HTTPException
from langgraph.checkpoint.memory import InMemorySaver

from practiq_ai import runtime, task_api, webapp
from practiq_ai.contracts import ArtifactReference, DocumentReference
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.graphs import document as document_graph
from tests.support import object_store, parsed, source, upload


@pytest.mark.parametrize('present', [True, False])
async def test_artifact_membership_serializes_reference_once(monkeypatch, present):
    reference = ArtifactReference(objectKey=f"practiq-agent/artifacts/{'a' * 64}/visual/0-{'b' * 64}.png",
                                  sha256='b' * 64, sizeBytes=3, mediaType='image/png')
    saved = reference.model_dump()
    if not present:
        saved['sizeBytes'] += 1
    review = {'units': [{'questions': [{'id': f'q{i}', 'stem': 'Saved question'} for i in range(1000)]}],
              'visuals': [saved]}
    store = SimpleNamespace(get_verified=AsyncMock(return_value=b'png'))
    monkeypatch.setattr(task_api, 'client', lambda: SimpleNamespace(db=SimpleNamespace(rows=AsyncMock(return_value=[])), snapshot=AsyncMock(return_value=SimpleNamespace(values={}))))
    monkeypatch.setattr(task_api, '_read_task_record', AsyncMock(return_value={'document': {'sha256': 'a' * 64, 'objectKey': 'source'}}))
    monkeypatch.setattr(task_api, 'review_task', AsyncMock(return_value=review))
    monkeypatch.setattr(task_api, 'get_task', AsyncMock(return_value={}))
    monkeypatch.setattr(webapp, 'get_object_store', lambda: store)
    original = ArtifactReference.model_dump
    calls = 0

    def dump(self, *args, **kwargs):
        nonlocal calls
        calls += 1
        return original(self, *args, **kwargs)

    monkeypatch.setattr(ArtifactReference, 'model_dump', dump)
    if present:
        response = await webapp.read_artifact(reference, uuid4())
        assert response.body == b'png' and response.headers['Cache-Control'] == 'no-store'
        store.get_verified.assert_awaited_once_with(reference)
    else:
        with pytest.raises(HTTPException) as denied:
            await webapp.read_artifact(reference, uuid4())
        assert denied.value.status_code == 404
        store.get_verified.assert_not_awaited()
    assert calls == 1


@pytest.mark.parametrize('units', [1, 100, 300])
@pytest.mark.parametrize('location,detail_reads,review_reads', [('source', 0, 0), ('detail', 1, 0), ('review', 1, 1)])
async def test_artifact_authorization_short_circuits_saved_metadata(monkeypatch, units, location, detail_reads, review_reads):
    store, document = source('quiz')
    reference = (DocumentReference.model_validate(document) if location == 'source' else
                 await store.put_artifact(b'png', source_sha256=document['sha256'], kind='unit-result', index=0, media_type='image/png'))
    requested = ArtifactReference(**reference.model_dump(include=set(ArtifactReference.model_fields)))
    saved = {'units': [{'index': i} for i in range(units)], 'reference': reference.model_dump()}
    detail = AsyncMock(return_value=saved if location == 'detail' else {})
    review = AsyncMock(return_value=saved if location == 'review' else {})
    verified = AsyncMock(wraps=store.get_verified)
    monkeypatch.setattr(task_api, 'client', lambda: SimpleNamespace(db=SimpleNamespace(rows=AsyncMock(return_value=[])), snapshot=AsyncMock(return_value=SimpleNamespace(values={}))))
    monkeypatch.setattr(task_api, '_read_task_record', AsyncMock(return_value={'document': document}))
    monkeypatch.setattr(task_api, 'get_task', detail)
    monkeypatch.setattr(task_api, 'review_task', review)
    monkeypatch.setattr(webapp, 'get_object_store', lambda: SimpleNamespace(get_verified=verified))

    response = await webapp.read_artifact(requested, uuid4())

    assert response.body == (b'quiz' if location == 'source' else b'png')
    assert response.headers['Cache-Control'] == 'no-store'
    assert detail.await_count == detail_reads
    assert review.await_count == review_reads
    verified.assert_awaited_once_with(reference)


@pytest.mark.parametrize('field,value', [('objectKey', 'other-source'), ('sha256', 'f' * 64),
                                         ('sizeBytes', 5), ('mediaType', 'image/png')])
async def test_artifact_source_requires_all_reference_metadata(monkeypatch, field, value):
    _, document = source('quiz')
    reference = ArtifactReference(**{key: document[key] for key in ArtifactReference.model_fields})
    reference = reference.model_copy(update={field: value})
    verified = AsyncMock()
    monkeypatch.setattr(task_api, 'client', lambda: SimpleNamespace(db=SimpleNamespace(rows=AsyncMock(return_value=[])), snapshot=AsyncMock(return_value=SimpleNamespace(values={}))))
    monkeypatch.setattr(task_api, '_read_task_record', AsyncMock(return_value={'document': document}))
    monkeypatch.setattr(task_api, 'get_task', AsyncMock(return_value={'document': document}))
    monkeypatch.setattr(task_api, 'review_task', AsyncMock(return_value={}))
    monkeypatch.setattr(webapp, 'get_object_store', lambda: SimpleNamespace(get_verified=verified))
    with pytest.raises(HTTPException) as error:
        await webapp.read_artifact(reference, uuid4())
    assert error.value.status_code == 404
    verified.assert_not_awaited()


@pytest.mark.parametrize('invalid', ['missing-id', 'missing-task', 'expired', 'unsupported', 'cross-task'])
async def test_artifact_source_shortcut_preserves_task_guards(monkeypatch, invalid):
    _, document = source('quiz')
    _, other_document = source('other quiz')
    task = {'document': other_document if invalid == 'cross-task' else document,
            'graph_id': 'document_parser', 'expires_at': datetime.now(UTC) + timedelta(days=1)}
    if invalid == 'expired':
        task['expires_at'] = datetime.now(UTC) - timedelta(seconds=1)
    if invalid == 'unsupported':
        task['document'] = {**document, 'sourceType': 'html'}
    service = SimpleNamespace(db=SimpleNamespace(rows=AsyncMock(return_value=[] if invalid == 'missing-task' else [task])))
    detail, review, verified = AsyncMock(), AsyncMock(), AsyncMock()
    monkeypatch.setattr(task_api, 'client', lambda: service)
    monkeypatch.setattr(task_api, 'get_task', detail)
    monkeypatch.setattr(task_api, 'review_task', review)
    monkeypatch.setattr(webapp, 'get_object_store', lambda: SimpleNamespace(get_verified=verified))
    reference = ArtifactReference(**{key: document[key] for key in ArtifactReference.model_fields})
    with pytest.raises(HTTPException) as error:
        await webapp.read_artifact(reference, None if invalid == 'missing-id' else uuid4())
    assert error.value.status_code == {'expired': 410, 'unsupported': 409}.get(invalid, 404)
    detail.assert_not_awaited()
    review.assert_not_awaited()
    verified.assert_not_awaited()


@pytest.mark.parametrize('damage,code', [('missing', 'OBJECT_NOT_FOUND'), ('corrupt', 'DOCUMENT_CHECKSUM_MISMATCH')])
async def test_artifact_source_shortcut_still_verifies_local_bytes(monkeypatch, tmp_path, damage, code):
    store = object_store(tmp_path)
    document = await store.put_document(b'quiz', upload())
    path = tmp_path / document.objectKey
    if damage == 'missing':
        path.unlink()
    else:
        path.write_bytes(b'fail')
    detail, review = AsyncMock(), AsyncMock()
    monkeypatch.setattr(task_api, 'client', lambda: SimpleNamespace(snapshot=AsyncMock(return_value=SimpleNamespace(values={}))))
    monkeypatch.setattr(task_api, '_read_task_record', AsyncMock(return_value={'document': document.model_dump()}))
    monkeypatch.setattr(task_api, 'get_task', detail)
    monkeypatch.setattr(task_api, 'review_task', review)
    monkeypatch.setattr(webapp, 'get_object_store', lambda: store)
    reference = ArtifactReference(**document.model_dump(include=set(ArtifactReference.model_fields)))
    with pytest.raises(HTTPException) as error:
        await webapp.read_artifact(reference, uuid4())
    assert cast(dict[str, str], error.value.detail)['code'] == code
    detail.assert_not_awaited()
    review.assert_not_awaited()


@pytest.fixture
async def saved_checkpoint(monkeypatch, tmp_path):
    """Real graph snapshots and externalized unit files; only database rows are fake."""
    store = object_store(tmp_path)
    document = await store.put_document(b'quiz', upload())
    thread_id = uuid4()
    task = {'thread_id': str(thread_id), 'document': document.model_dump(), 'graph_id': 'document_parser',
            'parent_thread_id': None, 'created_at': datetime.now(UTC),
            'expires_at': datetime.now(UTC) + timedelta(days=1)}
    graph = document_graph.build_document_graph(InMemorySaver())
    service = SimpleNamespace(
        graphs={'document_parser': graph}, checkpoint_id=runtime.Service.checkpoint_id,
        db=SimpleNamespace(rows=AsyncMock(side_effect=lambda query, args: [task] if 'FROM document_tasks' in query else []),
                           store=SimpleNamespace(asearch=AsyncMock(return_value=[]))))
    service.snapshot = AsyncMock(wraps=partial(runtime.Service.snapshot, cast(runtime.Service, service)))
    monkeypatch.setattr(task_api, 'client', lambda: service)
    for owner in (webapp, document_graph):
        monkeypatch.setattr(owner, 'get_object_store', lambda: store)
    detail = AsyncMock(wraps=task_api.get_task)
    review = AsyncMock(wraps=task_api.review_task)
    units = AsyncMock(wraps=task_api.load_unit_result)
    verified = AsyncMock(wraps=store.get_verified)
    monkeypatch.setattr(task_api, 'get_task', detail)
    monkeypatch.setattr(task_api, 'review_task', review)
    monkeypatch.setattr(task_api, 'load_unit_result', units)
    monkeypatch.setattr(store, 'get_verified', verified)

    async def save(values):
        await graph.aupdate_state({'configurable': {'thread_id': str(thread_id)}}, values, as_node='finish')

    return SimpleNamespace(store=store, document=document, thread_id=thread_id, task=task, service=service,
                           save=save, detail=detail, review=review, units=units, verified=verified)


@pytest.mark.parametrize('count', [1, 30, 100])
@pytest.mark.parametrize('refs,results', [('pageRefs', 'visionResults'), ('chunkRefs', 'chunkResults'),
                                         ('ocrPageRefs', 'visionResults')])
async def test_checkpoint_source_reads_skip_real_unit_loads(saved_checkpoint, count, refs, results):
    saved = saved_checkpoint
    references, units = [], []
    for index in range(count):
        reference = await saved.store.put_artifact(f'source {index}'.encode(), source_sha256=saved.document.sha256,
                                                   kind='page', index=index, media_type='text/plain')
        result = await saved.store.put_artifact(json.dumps({'parsed': parsed(f'Question {index}')}).encode(),
                                                source_sha256=saved.document.sha256, kind='unit-result',
                                                index=index, media_type='application/json')
        references.append(reference.model_dump())
        units.append({'index': index, 'parsed': {'questionCount': 1}, 'resultRef': result.model_dump()})
    await saved.save({refs: references, results: units})
    # Establish that this checkpoint really exposes the references and loads every saved unit.
    review = await task_api.review_task(str(saved.thread_id))
    field = 'evidenceRef' if refs == 'ocrPageRefs' else 'sourceRef'
    assert [unit[field] for unit in review['units']] == references
    assert saved.units.await_count == count
    assert saved.verified.await_count == count
    for spy in (saved.units, saved.review, saved.service.snapshot, saved.verified):
        spy.reset_mock()

    for reference in references:
        response = await webapp.read_artifact(ArtifactReference.model_validate(reference), saved.thread_id)
        assert response.status_code == 200 and response.headers['cache-control'] == 'no-store'
    assert saved.service.snapshot.await_count == count
    assert saved.verified.await_count == count
    saved.units.assert_not_awaited()
    saved.detail.assert_not_awaited()
    saved.review.assert_not_awaited()
    saved.service.db.store.asearch.assert_not_awaited()


@pytest.mark.parametrize('refs', ['pageRefs', 'chunkRefs', 'ocrPageRefs'])
@pytest.mark.parametrize('field,value', [('objectKey', 'other-source'), ('sha256', 'f' * 64),
                                         ('sizeBytes', 999), ('mediaType', 'image/png')])
async def test_checkpoint_source_requires_exact_metadata(saved_checkpoint, refs, field, value):
    saved = saved_checkpoint
    reference = await saved.store.put_artifact(b'page', source_sha256=saved.document.sha256,
                                               kind='page', index=0, media_type='text/plain')
    values = {refs: [reference.model_dump()]}
    if refs == 'ocrPageRefs':
        values['visionResults'] = [{'index': 0, 'parsed': parsed()}]
    await saved.save(values)
    if field == 'objectKey':
        value = reference.objectKey.replace('/0-', '/1-')
    with pytest.raises(HTTPException) as error:
        await webapp.read_artifact(reference.model_copy(update={field: value}), saved.thread_id)
    assert error.value.status_code == 404
    saved.verified.assert_not_awaited()


@pytest.mark.parametrize('invalid', ['missing-task', 'expired', 'cross-task', 'same-source-other-task'])
async def test_checkpoint_source_preserves_task_guards(saved_checkpoint, invalid):
    saved = saved_checkpoint
    reference = await saved.store.put_artifact(b'page', source_sha256=saved.document.sha256,
                                               kind='page', index=0, media_type='text/plain')
    await saved.save({'pageRefs': [reference.model_dump()]})
    if invalid == 'missing-task':
        saved.service.db.rows.side_effect = None
        saved.service.db.rows.return_value = []
    elif invalid == 'expired':
        saved.task['expires_at'] = datetime.now(UTC) - timedelta(seconds=1)
    elif invalid == 'cross-task':
        saved.task['document'] = source('other quiz')[1]
    else:
        saved.thread_id = uuid4()
        saved.task['thread_id'] = str(saved.thread_id)
    with pytest.raises(HTTPException) as error:
        await webapp.read_artifact(reference, saved.thread_id)
    assert error.value.status_code == (410 if invalid == 'expired' else 404)
    saved.verified.assert_not_awaited()
    if invalid != 'same-source-other-task':
        saved.service.snapshot.assert_not_awaited()


@pytest.mark.parametrize('damage', ['missing', 'corrupt'])
async def test_checkpoint_source_still_verifies_requested_bytes(saved_checkpoint, tmp_path, damage):
    saved = saved_checkpoint
    reference = await saved.store.put_artifact(b'page', source_sha256=saved.document.sha256,
                                               kind='page', index=0, media_type='text/plain')
    await saved.save({'pageRefs': [reference.model_dump()]})
    path = tmp_path / reference.objectKey
    if damage == 'missing':
        path.unlink()
    else:
        path.write_bytes(b'fail')
    with pytest.raises(HTTPException) as error:
        await webapp.read_artifact(reference, saved.thread_id)
    assert cast(dict[str, str], error.value.detail)['code'] == (
        'OBJECT_NOT_FOUND' if damage == 'missing' else 'DOCUMENT_CHECKSUM_MISMATCH')
    saved.verified.assert_awaited_once_with(reference)
    saved.detail.assert_not_awaited()
    saved.review.assert_not_awaited()


async def test_checkpoint_source_ignores_unrelated_corrupt_unit(saved_checkpoint, tmp_path):
    saved = saved_checkpoint
    reference = await saved.store.put_artifact(b'page', source_sha256=saved.document.sha256,
                                               kind='page', index=0, media_type='text/plain')
    result = await saved.store.put_artifact(json.dumps({'parsed': parsed()}).encode(),
                                            source_sha256=saved.document.sha256, kind='unit-result',
                                            index=0, media_type='application/json')
    await saved.save({'pageRefs': [reference.model_dump()],
                      'visionResults': [{'index': 0, 'parsed': {'questionCount': 1}, 'resultRef': result.model_dump()}]})
    path = tmp_path / result.objectKey
    payload = path.read_bytes()
    path.write_bytes(bytes([payload[0] ^ 1]) + payload[1:])
    with pytest.raises(DocumentProcessingError) as corrupt:
        await task_api.review_task(str(saved.thread_id))
    assert corrupt.value.code == 'DOCUMENT_CHECKSUM_MISMATCH'
    saved.units.reset_mock()
    response = await webapp.read_artifact(reference, saved.thread_id)
    assert response.body == b'page'
    saved.units.assert_not_awaited()


@pytest.mark.parametrize('location', ['textRef', 'inputParts', 'resultRef', 'nested-page',
                                     'unexposed-ocr', 'failed-vision-ocr', 'chunk-only-ocr', 'merged-orphan-ocr'])
async def test_checkpoint_internal_refs_are_not_authorized(saved_checkpoint, location):
    saved = saved_checkpoint
    reference = await saved.store.put_artifact(b'internal', source_sha256=saved.document.sha256,
                                               kind='ocr-page', index=0, media_type='text/plain')
    ref = reference.model_dump()
    values = {}
    if location == 'resultRef':
        values['visionResults'] = [{'index': 0, 'parsed': None, 'resultRef': ref}]
    elif location == 'nested-page':
        values['inputParts'] = [{'originalPageRefs': [ref]}]
    elif location in {'unexposed-ocr', 'failed-vision-ocr', 'chunk-only-ocr', 'merged-orphan-ocr'}:
        values['ocrPageRefs'] = [ref]
        if location == 'merged-orphan-ocr':
            values.update(result={**parsed(), 'schemaVersion': 3, 'visualElements': [], 'warnings': [], 'confidenceScore': 80},
                          visionResults=[{'index': 0, 'parsed': parsed()}])
            values['result']['questions'][0]['id'] = 'q0'
        elif location == 'failed-vision-ocr':
            values['visionResults'] = [{'index': 0, 'parsed': None}]
        elif location == 'chunk-only-ocr':
            values['chunkResults'] = [{'index': 0, 'parsed': parsed()}]
    else:
        values[location] = ref if location == 'textRef' else [ref]
    await saved.save(values)
    with pytest.raises(HTTPException) as error:
        await webapp.read_artifact(reference, saved.thread_id)
    assert error.value.status_code == 404
    saved.verified.assert_not_awaited()


async def test_checkpoint_result_only_visual_retains_real_review_fallback(saved_checkpoint):
    saved = saved_checkpoint
    reference = await saved.store.put_artifact(b'visual', source_sha256=saved.document.sha256,
                                               kind='visual', index=0, media_type='image/png')
    result = await saved.store.put_artifact(json.dumps({'parsed': parsed(), 'visuals': [
        {'kind': 'image', 'description': 'Saved figure', 'imageRef': reference.model_dump()}]}).encode(),
        source_sha256=saved.document.sha256, kind='unit-result', index=0, media_type='application/json')
    await saved.save({'visionResults': [{'index': 0, 'parsed': {'questionCount': 1}, 'resultRef': result.model_dump()}]})
    response = await webapp.read_artifact(reference, saved.thread_id)
    assert response.body == b'visual'
    saved.detail.assert_awaited_once()
    saved.review.assert_awaited_once()
    saved.units.assert_awaited_once()
    assert saved.verified.await_count == 2
    assert saved.service.snapshot.await_count == 3


@pytest.mark.parametrize('merged', [True, False])
@pytest.mark.parametrize('same_reference', [True, False])
async def test_checkpoint_ocr_evidence_tracks_public_page_units(saved_checkpoint, merged, same_reference):
    saved = saved_checkpoint
    page = await saved.store.put_artifact(b'page', source_sha256=saved.document.sha256,
                                         kind='page', index=0, media_type='text/plain')
    evidence = page if same_reference else await saved.store.put_artifact(
        b'evidence', source_sha256=saved.document.sha256, kind='ocr-page', index=0, media_type='text/plain')
    values: dict[str, Any] = {'pageRefs': [page.model_dump()], 'ocrPageRefs': [evidence.model_dump()]}
    if merged:
        values['result'] = {**parsed(), 'schemaVersion': 3, 'visualElements': [], 'warnings': [], 'confidenceScore': 80}
        values['result']['questions'][0]['id'] = 'q0'
    await saved.save(values)
    review = await task_api.review_task(str(saved.thread_id))
    unit = next(unit for unit in review['units'] if unit['stage'] == 'vision_parse')
    assert unit['sourceRef'] == page.model_dump()
    assert unit['evidenceRef'] == (None if same_reference else evidence.model_dump())
    saved.review.reset_mock()
    saved.service.snapshot.reset_mock()
    response = await webapp.read_artifact(evidence, saved.thread_id)
    assert response.body == (b'page' if same_reference else b'evidence')
    saved.service.snapshot.assert_awaited_once()
    saved.detail.assert_not_awaited()
    saved.review.assert_not_awaited()
    saved.units.assert_not_awaited()
