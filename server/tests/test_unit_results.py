"""Saved-result reads keep schema, source ownership and checksum boundaries."""

import json
from copy import deepcopy
from typing import Any, cast
from unittest.mock import AsyncMock

import pytest

from practiq_ai.errors import DocumentProcessingError
from practiq_ai.unit_results import UnitParseResult, load_unit_result
from tests.support import object_store, parsed


@pytest.mark.parametrize('inline', [True, False])
async def test_unit_reader_preserves_inline_and_failed_checkpoints(inline):
    item = {'index': 0, 'parsed': parsed() if inline else None}
    store = AsyncMock()
    assert await load_unit_result(item, 'a' * 64, store) is item
    store.get_verified.assert_not_called()


async def test_unit_reader_preserves_historical_metadata_and_review_flags(tmp_path):
    store = object_store(tmp_path)
    value = parsed()
    value['questions'][0]['confidence'] = 0.2
    value['questions'][0]['blankCount'] = 2
    audit = {'status': 'repair_rejected', 'original': deepcopy(value)}
    payload = {'parsed': value, 'visuals': [], 'agentReview': audit}
    reference = await store.put_artifact(json.dumps(payload).encode(), source_sha256='a' * 64,
                                         kind='unit-result', index=0, media_type='application/json')
    item = {'index': 0, 'round': 1, 'parsed': {'questionCount': 1}, 'resultRef': reference.model_dump(mode='json')}
    before = deepcopy(item)
    result = await load_unit_result(item, 'a' * 64, store)
    assert result['parsed'] == UnitParseResult.model_validate(value).model_dump(mode='json')
    assert result['parsed']['questions'][0]['needsReview']
    assert result['parsed']['questions'][0]['blankCount'] is None
    assert result['agentReview'] == audit and result['round'] == 1
    assert result['visuals'] == [] and item == before


@pytest.mark.parametrize('damage', ['source', 'index', 'media', 'json', 'group', 'duplicate', 'parent', 'visual', 'checksum'])
async def test_unit_reader_rejects_invalid_references_or_payloads(tmp_path, damage):
    store = object_store(tmp_path)
    value = parsed()
    if damage == 'group':
        value['groups'] = [{'title': 'Invalid group', 'questionIndexes': [1]}]
    elif damage == 'duplicate':
        value['questions'][0]['id'] = 'same'
        value['questions'].append(deepcopy(value['questions'][0]))
    elif damage == 'parent':
        value['questions'][0]['id'] = 'parent'
        value['questions'].append({**value['questions'][0], 'id': 'child', 'parentId': 'parent'})
    payload = json.dumps({'parsed': value, 'visuals': [None] if damage == 'visual' else []}).encode()
    reference = await store.put_artifact(b'{' if damage == 'json' else payload, source_sha256='a' * 64,
                                         kind='unit-result', index=0, media_type='text/plain' if damage == 'media' else 'application/json')
    item = {'index': 1 if damage == 'index' else 0, 'parsed': {'questionCount': 1}, 'resultRef': reference.model_dump(mode='json')}
    if damage == 'checksum':
        (tmp_path / reference.objectKey).write_bytes(b'x' * reference.sizeBytes)
    with pytest.raises(DocumentProcessingError) as raised:
        await load_unit_result(cast(dict[str, Any], item), 'b' * 64 if damage == 'source' else 'a' * 64, store)
    assert raised.value.code == ('DOCUMENT_CHECKSUM_MISMATCH' if damage == 'checksum' else 'UNIT_RESULT_INVALID')
