"""Fault combinations from the 2026-09-19 review, without external model calls."""

import asyncio
import json
import os
import sys
import threading
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
from langgraph.types import Command
from PIL import Image
from pydantic import ValidationError

from practiq_ai import config, execution, webapp
from practiq_ai.contracts import ParsedQuestion, VisualElement
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.extractors import ExtractedDocument, image, isolated
from practiq_ai.graphs import document, vision
from scripts import storage_gc
from tests.support import (
    make_image,
    object_store,
    parsed,
    run_config,
    setup_graph,
    upload,
)


@pytest.mark.parametrize('phase,decision', [('vision', 'accept_partial'), ('vision', 'retry_failed'),
                                           ('chunk', 'accept_partial'), ('chunk', 'retry_failed'), ('result', 'accept_partial')])
async def test_pause_then_review_keeps_interrupt_order(monkeypatch, phase, decision):
    responses = [parsed('First'), {'bad': 1}, {'bad': 1}] if phase != 'result' else [parsed('Not in source')]
    graph, store, _, reference, model = setup_graph(monkeypatch, responses, parts=['First', 'Second'] if phase == 'chunk' else None)
    if phase == 'vision':
        monkeypatch.setattr(document, 'extract', AsyncMock(return_value=ExtractedDocument(text='', page_images=[make_image(), make_image()])))
    initial = run_config()
    result = await graph.ainvoke({'document': reference, 'failurePolicy': 'review'}, initial)
    assert result['__interrupt__'][0].value['stage'] == phase
    # Re-enter the preceding checkpoint with a pause already requested.
    await graph.aupdate_state(initial, {}, as_node=phase if phase != 'result' else 'merge')
    paused_run = run_config()
    await store.aput(execution.namespace('thread-1', 'pause'), str(paused_run.get('run_id')), {'requested': True})
    paused = await graph.ainvoke(None, paused_run)
    assert paused['__interrupt__'][0].value['kind'] == 'pause'
    reviewed = await graph.ainvoke(Command(resume={'action': 'resume'}), run_config())
    assert reviewed['__interrupt__'][0].value['kind'] == 'review'
    if decision == 'retry_failed':
        model.responses.append(parsed('Second'))
        result = await graph.ainvoke(Command(resume={'action': decision, 'requestId': str(uuid4())}), run_config())
        assert len(result['result']['questions']) == 2
    else:
        result = await graph.ainvoke(Command(resume={'action': 'accept_partial'}), run_config())
        assert result['result']['questions']








async def test_storage_timeout_retains_capacity_until_io_finishes(tmp_path):
    store = object_store(tmp_path, storage_concurrency=1, storage_timeout_seconds=0.02)
    release, finished = threading.Event(), threading.Event()
    calls = []
    def blocked():
        calls.append(1)
        try:
            release.wait(5)
        finally:
            finished.set()
    try:
        for _ in range(5):
            with pytest.raises(DocumentProcessingError):
                await store._call(blocked)
        assert calls == [1] and not finished.is_set()
    finally:
        release.set()
        await asyncio.to_thread(finished.wait, 5)
    assert await store._call(lambda: 'recovered') == 'recovered'


@pytest.mark.parametrize('cancel', [False, True])
async def test_extractor_reaps_blocked_process_and_descendants(monkeypatch, tmp_path, cancel):
    original = asyncio.create_subprocess_exec
    processes = []
    child_pid = tmp_path / 'child'
    async def blocked(*args, **kwargs):
        code = ('import subprocess,sys,time; from pathlib import Path; '
                'p=subprocess.Popen([sys.executable,"-c","import time; time.sleep(60)"]); '
                f'Path({str(child_pid)!r}).write_text(str(p.pid)); time.sleep(60)')
        process = await original(sys.executable, '-c', code, **kwargs)
        processes.append(process)
        return process
    with monkeypatch.context() as patch:
        patch.setattr(asyncio, 'create_subprocess_exec', blocked)
        task = asyncio.create_task(isolated.extract('text', b'First', timeout=0.3 if not cancel else 60))
        async with asyncio.timeout(5):
            while not child_pid.exists():
                await asyncio.sleep(0.01)
        if cancel:
            task.cancel()
        with pytest.raises(asyncio.CancelledError if cancel else DocumentProcessingError):
            await task
    assert processes[0].returncode is not None
    # A killed descendant may briefly be a zombie until the OS reaps it.
    status = await original('ps', '-o', 'stat=', '-p', child_pid.read_text(), stdout=asyncio.subprocess.PIPE)
    stdout, _ = await status.communicate()
    assert not stdout.strip() or stdout.strip().startswith(b'Z')
    assert (await isolated.extract('text', b'Recovered')).text == 'Recovered'


def test_image_pixel_and_frame_limits(monkeypatch):
    monkeypatch.setenv('AI_MAX_VISION_PAGE_PIXELS', '39999')
    with pytest.raises(DocumentProcessingError, match='pixel'):
        image.extract(make_image())
    monkeypatch.setenv('AI_MAX_VISION_PAGE_PIXELS', '40000')
    assert image.extract(make_image()).page_images
    data = BytesIO()
    Image.new('RGB', (2, 2), 'red').save(data, format='PNG', save_all=True, append_images=[Image.new('RGB', (2, 2), 'blue')])
    with pytest.raises(DocumentProcessingError, match='Multi-frame'):
        image.extract(data.getvalue())


@pytest.mark.parametrize('mode,payload', [
    ('true_false', {'value': ['x', None]}), ('choice', {'correctOption': ['A', None]}),
    ('short_answer', {'text': [None]}), ('fill_blank', {'answers': [1, None]}),
    ('ordering', {'order': [True, None]}), ('matching', {'matches': [{'left': '1', 'right': None}]}),
    ('fill_blank', {'answers': [None] * 101}), ('choice', {'correct': ['A'] * 33}),
    ('short_answer', {'text': 'x' * 120001}),
])
def test_partial_answers_never_bypass_shape_constraints(mode, payload):
    with pytest.raises(ValidationError):
        ParsedQuestion(stem='Question', answerMode=mode, answerPayload=payload)


@pytest.mark.parametrize('mode,payload', [('true_false', {'value': None}), ('choice', {'correct': [None]}),
    ('short_answer', {'text': None}), ('fill_blank', {'answers': ['A', None]}),
    ('ordering', {'order': [1, None]}), ('matching', {'matches': [{'left': 1, 'right': None}]})])
def test_partial_answers_preserve_missing_values(mode, payload):
    value = ParsedQuestion(stem='Question', answerMode=mode, answerPayload=payload)
    assert value.answerPayload == payload and 'answerPayload' in value.missingFields


@pytest.mark.parametrize('fields', [{'description': '   '}, {'label': 'x' * 1001}])
async def test_visual_constraints_are_corrected_inside_model_boundary(fields):
    from practiq_ai import llm
    from tests.support import FakeModel
    good = {'description': 'Figure', 'bbox': [0, 0, 1, 1]}
    model = FakeModel(responses=[{**good, **fields}, good])
    result, usage, failure = await llm.structured_call(model, [], vision.PageFigure, 'vision_parse')
    assert result is not None and failure is None and len(usage) == 2
    assert VisualElement(**result.model_dump(exclude={"tableRows"})).description == 'Figure'


async def test_failed_batch_waits_for_sibling_cancellation():
    started, stopped = asyncio.Event(), asyncio.Event()
    async def work(index):
        if index == 0:
            await started.wait()
            raise ValueError('failed')
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()
    with pytest.raises(ValueError, match='failed'):
        await document._bounded_map([0, 1], work)
    assert stopped.is_set()


async def test_gc_final_replace_failure_preserves_recovery_manifest(tmp_path, monkeypatch):
    store = object_store(tmp_path / 'store')
    reference = await store.put_artifact(b'old', source_sha256='a' * 64, kind='text', index=0, media_type='text/plain')
    os.utime(store._path(reference.objectKey), (0, 0))
    monkeypatch.setattr(storage_gc, 'get_object_store', lambda: store)
    monkeypatch.setattr(storage_gc, 'live_sources', AsyncMock(return_value=set()))
    def fail(*args):
        raise OSError('disk failed')
    monkeypatch.setattr(storage_gc.os, 'replace', fail)
    output = tmp_path / 'inventory.json'
    with pytest.raises(OSError):
        await storage_gc.scan(SimpleNamespace(output=output, retention_days=187, quarantine=True), None)
    manifest = json.loads(output.read_text())
    assert not manifest['completed'] and manifest['objects'] == 1
    assert (store.root / '.quarantine' / manifest['runId'] / reference.objectKey).read_bytes() == b'old'


def test_default_uvicorn_logging_emits_json_without_private_fields():
    import subprocess
    code = ('import logging.config; from uvicorn.config import LOGGING_CONFIG; '
            'from practiq_ai.telemetry import configure_logging,event; '
            'logging.config.dictConfig(LOGGING_CONFIG); configure_logging(); configure_logging(); '
            'event("stage", stage="prepare", body="private", token="secret", exception="raw")')
    result = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, check=True)
    lines = result.stderr.splitlines()
    assert len(lines) == 1 and json.loads(lines[0])['stage'] == 'prepare'
    assert all(word not in lines[0] for word in ('private', 'secret', 'raw'))




def test_storage_legacy_and_wheel_paths_fail_without_moving_data(tmp_path, monkeypatch):
    root = tmp_path / 'server'
    (root / 'src/practiq_ai').mkdir(parents=True)
    (root / 'pyproject.toml').touch()
    monkeypatch.setattr(config, 'SERVER_ROOT', root)
    assert config.storage_path('.local/ai') == root / '.local/ai'
    legacy = tmp_path / '.local/ai'
    legacy.mkdir(parents=True)
    (legacy / 'old').write_text('keep')
    with pytest.raises(ValueError, match='Existing storage'):
        config.storage_path('.local/ai')
    assert config.storage_path(str(legacy)) == legacy
    assert (legacy / 'old').read_text() == 'keep'
    monkeypatch.setattr(config, 'SERVER_ROOT', tmp_path / 'site-packages')
    with pytest.raises(ValueError, match='Wheel'):
        config.storage_path('.local/ai')
    assert config.storage_path(str(legacy)) == legacy


async def test_stalled_upload_times_out_and_releases_slot(tmp_path, monkeypatch):
    store = object_store(tmp_path)
    monkeypatch.setattr(webapp, 'get_object_store', lambda: store)
    monkeypatch.setenv('AI_UPLOAD_TIMEOUT_SECONDS', '0.03')
    monkeypatch.setenv('AI_UPLOAD_CONCURRENCY', '1')
    async def stalled():
        yield b'q'
        await asyncio.Event().wait()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url='http://test') as client:
        headers = {'Authorization': 'Bearer ' + config.service_token()}
        response = await client.put('/api/uploads/content', params=upload().model_dump(), headers=headers, content=stalled())
        assert response.status_code == 408
        response = await client.put('/api/uploads/content', params=upload().model_dump(), headers=headers, content=b'quiz')
        assert response.status_code == 200
        response = await client.get('/api/maintenance', headers={b'authorization': b'Bearer \xff'})
        assert response.status_code == 401


async def test_extractor_returns_sanitized_input_failure():
    with pytest.raises(DocumentProcessingError) as error:
        await isolated.extract('image', b'not an image')
    assert error.value.status_code == 400
    assert error.value.detail == 'Image preprocessing failed'
