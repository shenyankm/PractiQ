"""Recovery preflight bounds work without retaining verified payloads."""
import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from practiq_ai import capacity, execution, normalization
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.graphs import document
from tests.support import make_image, object_store, source, upload


@pytest.mark.parametrize("module", ["cost_budget.py", "worker_sandbox.py"])
def test_production_policy_changes_invalidate_execution_identity(monkeypatch, module):
    original = Path.read_bytes
    target = Path(execution.__file__).parent / module
    before = execution.code_version.__wrapped__()
    monkeypatch.setattr(Path, "read_bytes", lambda path: original(path) + (b"\n# changed policy" if path == target else b""))
    assert execution.code_version.__wrapped__() != before


@pytest.mark.parametrize('corrupt', [None, 'tile', 'original'])
async def test_preflight_verifies_reused_split_page_and_original_once(tmp_path, monkeypatch, corrupt):
    store = object_store(tmp_path)
    original = await store.put_document(b'quiz', upload())
    page = await store.put_artifact(make_image(), source_sha256=original.sha256, kind='source-page', index=0, media_type='image/png')
    tile = await store.put_artifact(make_image(), source_sha256=original.sha256, kind='ocr-input', index=0, media_type='image/png')
    values = {'document': original.model_dump(), 'pageRefs': [tile.model_dump()],
              'inputParts': [{'reference': tile.model_dump(), 'originalPageRef': page.model_dump(),
                              'sourcePage': 0, 'pixelBounds': [0, 0, 16, 12]}]}
    if corrupt:
        reference = tile if corrupt == 'tile' else page
        (tmp_path / reference.objectKey).write_bytes(b'x' * reference.sizeBytes)
    reads = AsyncMock(wraps=store.get_verified)
    monkeypatch.setattr(store, 'get_verified', reads)
    monkeypatch.setattr(execution, 'get_object_store', lambda: store)
    monkeypatch.setattr(execution, 'validate_execution', Mock())
    if corrupt:
        with pytest.raises(DocumentProcessingError) as raised:
            await execution.preflight(values)
        assert raised.value.code == 'DOCUMENT_CHECKSUM_MISMATCH'
    else:
        await execution.preflight(values)
        assert [call.args[0] for call in reads.await_args_list] == [original, tile, page]


def preflight_values(count):
    _, original = source('quiz')
    references = [{'objectKey': f'page/{i}', 'sha256': 'a' * 64, 'sizeBytes': 1024, 'mediaType': 'text/plain'} for i in range(count)]
    results = [{'index': i, 'resultRef': reference} for i, reference in enumerate(references)]
    return {'document': original, 'execution': {}, 'normalization': {'saved': True},
            'pageRefs': references[::3], 'ocrPageRefs': references[1::3], 'chunkRefs': references[2::3],
            'inputParts': [{'reference': reference, 'originalPageRef': references[0]} for reference in references],
            'textRef': references[-1], 'visionResults': results[::2], 'chunkResults': [*results[1::2], {'parsed': {}}]}


@pytest.mark.parametrize('count', [10, 100, 300])
@pytest.mark.parametrize('concurrency', [1, 2, 4])
async def test_preflight_bounded_work_counts_and_discards_payloads(monkeypatch, count, concurrency):
    values = preflight_values(count)
    calls, mapped = [], []
    active = peak = 0

    async def verify(kind, key):
        nonlocal active, peak
        calls.append((kind, key))
        active += 1
        peak = max(peak, active)
        try:
            await asyncio.sleep(0)
            return bytearray(1024)
        finally:
            active -= 1

    async def get_verified(reference):
        return await verify('source' if reference.objectKey == values['document']['objectKey'] else 'artifact', reference.objectKey)

    async def load_result(item, source_sha256):
        assert source_sha256 == values['document']['sha256']
        return await verify('result', item['resultRef']['objectKey'])

    async def bounded_map(items, function):
        result = await capacity.bounded_map(items, function)
        mapped.append(result)
        return result

    async def normalized(*args, **kwargs):
        assert calls == [('source', values['document']['objectKey'])]
        calls.append(('normalization', None))

    monkeypatch.setattr(execution, 'validate_execution', Mock())
    monkeypatch.setattr(execution, 'get_object_store', lambda: SimpleNamespace(get_verified=get_verified))
    monkeypatch.setattr(normalization, 'verified_normalization', normalized)
    monkeypatch.setattr(document, 'load_unit_result', load_result)
    monkeypatch.setattr(capacity, 'load', lambda: SimpleNamespace(storage_concurrency=concurrency))
    monkeypatch.setattr(execution, 'bounded_map', bounded_map)

    assert await execution.preflight(values) is None
    assert peak == concurrency and active == 0
    assert mapped == [[None] * count, [None] * count]
    assert len(calls) == 2 + count * 2
    assert len({key for kind, key in calls if kind == 'artifact'}) == count
    assert len({key for kind, key in calls if kind == 'result'}) == count
    assert [kind for kind, _ in calls] == ['source', 'normalization'] + ['result'] * count + ['artifact'] * count


@pytest.mark.parametrize('failure', ['execution', 'source', 'normalization'])
async def test_preflight_validates_source_and_normalization_before_saved_outputs(monkeypatch, failure):
    values = preflight_values(10)
    error = DocumentProcessingError(409, 'Invalid saved input', 'INVALID_INPUT')
    validation = Mock(side_effect=error if failure == 'execution' else None)
    verified = AsyncMock(side_effect=error if failure == 'source' else None)
    normalized = AsyncMock(side_effect=error if failure == 'normalization' else None)
    result = AsyncMock()
    monkeypatch.setattr(execution, 'validate_execution', validation)
    monkeypatch.setattr(execution, 'get_object_store', lambda: SimpleNamespace(get_verified=verified))
    monkeypatch.setattr(normalization, 'verified_normalization', normalized)
    monkeypatch.setattr(document, 'load_unit_result', result)

    with pytest.raises(DocumentProcessingError) as raised:
        await execution.preflight(values)
    assert raised.value is error
    assert verified.await_count == (0 if failure == 'execution' else 1)
    assert normalized.await_count == (1 if failure == 'normalization' else 0)
    result.assert_not_awaited()


@pytest.mark.parametrize('stage', ['result', 'artifact'])
@pytest.mark.parametrize('cancel', [False, True])
async def test_preflight_failure_or_cancellation_drains_workers(monkeypatch, stage, cancel):
    values = preflight_values(10)
    started, blocked = asyncio.Event(), asyncio.Event()
    active = 0
    calls = []
    error = DocumentProcessingError(409, 'Saved input is corrupt', 'DOCUMENT_CHECKSUM_MISMATCH')

    async def check(key):
        nonlocal active
        calls.append(key)
        active += 1
        try:
            if len(calls) == 1:
                started.set()
                await asyncio.Event().wait()
            else:
                await started.wait()
                blocked.set()
                if not cancel:
                    raise error
                await asyncio.Event().wait()
        finally:
            active -= 1

    async def verified(reference):
        if reference.objectKey != values['document']['objectKey']:
            assert stage == 'artifact', 'Result failure must prevent artifact reads'
            await check(reference.objectKey)

    async def load_result(item, _):
        if stage == 'result':
            await check(item['resultRef']['objectKey'])

    monkeypatch.setattr(execution, 'validate_execution', Mock())
    monkeypatch.setattr(execution, 'get_object_store', lambda: SimpleNamespace(get_verified=verified))
    monkeypatch.setattr(normalization, 'verified_normalization', AsyncMock())
    monkeypatch.setattr(document, 'load_unit_result', load_result)
    monkeypatch.setattr(capacity, 'load', lambda: SimpleNamespace(storage_concurrency=2))

    task = asyncio.create_task(execution.preflight(values))
    await asyncio.wait_for(blocked.wait(), 1)
    if cancel:
        task.cancel()
    with pytest.raises(asyncio.CancelledError if cancel else DocumentProcessingError):
        await asyncio.wait_for(task, 1)
    assert active == 0
    assert len(calls) == 2
