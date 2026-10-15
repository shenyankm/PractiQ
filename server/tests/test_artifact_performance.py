"""Artifact membership checks keep private reads bounded and exact."""
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi import HTTPException

from practiq_ai import task_api, webapp
from practiq_ai.contracts import ArtifactReference


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
