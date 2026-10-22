"""Artifact membership checks keep private reads bounded and exact."""
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import cast
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi import HTTPException

from practiq_ai import task_api, webapp
from practiq_ai.contracts import ArtifactReference, DocumentReference
from tests.support import object_store, source, upload


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
    monkeypatch.setattr(task_api, 'client', lambda: None)
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
    monkeypatch.setattr(task_api, 'client', lambda: None)
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
    monkeypatch.setattr(task_api, 'client', lambda: None)
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
    monkeypatch.setattr(task_api, 'client', lambda: None)
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
