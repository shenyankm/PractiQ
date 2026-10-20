"""Import cancellation, private transport logs and final quality metrics."""

import asyncio
import json
import logging
import threading
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import AsyncMock

import httpx
import pytest

from practiq_ai import telemetry, temporary, tencent
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.graphs import document
from tests.support import make_image, source


@pytest.mark.parametrize('status', [200, 503])
async def test_signed_result_download_never_enters_verbose_transport_logs(monkeypatch, caplog, status):
    original = httpx.AsyncClient
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kwargs: original(
        transport=httpx.MockTransport(lambda _: httpx.Response(status, content=b'private-document')), **kwargs))
    for name in ('httpx', 'httpcore', 'httpx2', 'httpcore2'):
        monkeypatch.setattr(logging.getLogger(name), 'level', logging.DEBUG)
    monkeypatch.setattr(telemetry.logger, 'handlers', [caplog.handler])
    monkeypatch.setattr(telemetry.logger, 'level', logging.NOTSET)
    monkeypatch.setattr(telemetry.logger, 'propagate', False)
    url = 'https://fixture.cos.ap-guangzhou.myqcloud.com/result.zip?q-signature=private-signature'
    with caplog.at_level(logging.DEBUG):
        telemetry.configure_logging()
        telemetry.configure_logging()
        if status == 200:
            assert await tencent.download_result(url) == b'private-document'
        else:
            with pytest.raises(DocumentProcessingError, match='Tencent result download failed'):
                await tencent.download_result(url)
        logging.getLogger('httpcore.http11').debug('request headers: private-authorization')
        logging.getLogger('httpx2').info('HTTP Request: GET %s', url)
        logging.getLogger('httpcore2.http11').debug('request headers: private-authorization')
        telemetry.event('download_checked', outcome='success' if status == 200 else 'failed')
    assert [json.loads(record.getMessage())['event'] for record in caplog.records] == ['download_checked']
    assert 'private-' not in caplog.text


@pytest.mark.parametrize('worker', ['decode_bundle', 'read_bundle_image'])
async def test_cancelled_tencent_decode_holds_preparation_until_worker_finishes(monkeypatch, worker):
    files, reference = source('Synthetic source')
    artifact = await files.put_artifact(b'archive', source_sha256=reference['sha256'],
                                      kind='tencent-result', index=0, media_type='application/octet-stream')
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    monkeypatch.setattr(document, 'get_model', lambda: object())
    monkeypatch.setattr(document, 'parse_job', AsyncMock(return_value={
        'resultRef': artifact.model_dump(), 'SuccessPageNum': 1, 'FailPageNum': 0,
    }))
    if worker == 'read_bundle_image':
        monkeypatch.setattr(document, 'decode_bundle', lambda *_args, **_kwargs: [
            {'page': 0, 'elements': [], 'figures': [{'elementIndex': 0, 'imageMember': 'image.png'}]},
        ])
    loop = asyncio.get_running_loop()
    started = asyncio.Event()
    release = threading.Event()
    finished = threading.Event()

    def blocked(*_args, **_kwargs):
        loop.call_soon_threadsafe(started.set)
        try:
            assert release.wait(5), 'Test did not release the worker'
            return [] if worker == 'decode_bundle' else (make_image(), 'image/png')
        finally:
            finished.set()

    monkeypatch.setattr(document, worker, blocked)
    running = asyncio.create_task(document._prepare(cast(Any, {'document': reference}), cast(Any, SimpleNamespace())))
    try:
        await asyncio.wait_for(started.wait(), 5)
        running.cancel()
        await asyncio.sleep(0)
        running.cancel()
        await asyncio.sleep(0)
        assert not finished.is_set() and not running.done()
        assert temporary.current().used > 0 and temporary.current().preparing.locked()
    finally:
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await running
    assert finished.is_set()
    assert temporary.current().used == 0 and not temporary.current().preparing.locked()
    async with temporary.preparation(1):
        assert temporary.current().used == 1


@pytest.mark.parametrize('case', ['empty', 'truncated', 'unassociated', 'complete'])
async def test_result_metric_uses_the_exported_quality_flag(monkeypatch, case):
    files, reference = source('Source')
    monkeypatch.setattr(document, 'get_object_store', lambda: files)
    question = {'id': 'page:1:1', 'stem': 'Source', 'sourceText': 'Source', 'answerMode': 'choice',
                'questionTypeId': 'single-choice', 'choiceVariant': 'single', 'analysis': 'Supplied analysis',
                'options': [{'label': 'A', 'content': 'One'}, {'label': 'B', 'content': 'Two'}],
                'answerPayload': {'correct': ['A']}, 'confidence': 0.9, 'needsReview': False}
    image = await files.put_artifact(make_image(), source_sha256=reference['sha256'],
                                    kind='ocr-figure', index=0, media_type='image/png')
    state = {'document': reference, 'pageRefs': [reference], 'visualTotal': 1,
             'truncated': case == 'truncated', 'visionResults': [{
                 'kind': 'page', 'index': 0, 'artifact': reference,
                 'parsed': {'questions': [] if case == 'empty' else [question], 'groups': []},
                 'visuals': [{'kind': 'image', 'page': 0, 'questionIndexes': [], 'description': 'Unassociated',
                              'imageRef': image.model_dump()}]
                            if case == 'unassociated' else [],
             }]}
    review = case != 'complete'
    status = 'PARTIAL' if case in {'empty', 'truncated'} else 'SUCCEEDED'
    counter = telemetry.results.labels(status, str(review).lower())
    before = counter._value.get()
    result = await document._merge(cast(Any, state))
    assert result['processing']['quality']['reviewRequired'] is review
    assert result['status'] == status
    assert counter._value.get() == before + 1
