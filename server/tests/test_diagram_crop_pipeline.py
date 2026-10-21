"""Final diagram crops retain full sources without model calls."""
import hashlib
from io import BytesIO

import pytest
from PIL import Image, ImageDraw

from practiq_ai.config import Config
from practiq_ai.contracts import DocumentUploadRequest, VisualElement
from practiq_ai.graphs import document, vision
from practiq_ai.storage import ObjectStore


@pytest.mark.parametrize('kind', ['diagram', 'image', 'table'])
@pytest.mark.parametrize('associated', [False, True])
async def test_cut_diagram_keeps_full_source_and_other_kinds_keep_original_crop(monkeypatch, tmp_path, kind, associated):
    buffer = BytesIO()
    with Image.new('RGB', (200, 160), 'white') as image:
        ImageDraw.Draw(image).line((150, 70, 170, 70), fill='black', width=3)
        image.save(buffer, 'PNG')
    payload = buffer.getvalue()
    config = Config(
        provider="", api_key="", model_id="", storage_dir=tmp_path, read_only=True,
        source_max_bytes=1024 * 1024, vision_max_bytes=1024 * 1024,
        max_document_pages=1, max_vision_page_pixels=1024 * 1024,
        max_total_input_chars=10_000, graph_max_concurrency=1, storage_concurrency=1,
        storage_timeout_seconds=10, model_timeout_seconds=10, model_max_tokens=1,
    )
    store = ObjectStore(config)
    monkeypatch.setattr(document, "load", lambda: config)
    reference = await store.put_document(payload, DocumentUploadRequest(
        sourceType='image', fileName='paper.png', mediaType='image/png',
        sizeBytes=len(payload), sha256=hashlib.sha256(payload).hexdigest(),
    ))
    page = await store.put_artifact(payload, source_sha256=reference.sha256, kind='page', index=0, media_type='image/png')
    monkeypatch.setattr(document, 'get_object_store', lambda: store)
    box = [.2, .25, .8, .75]
    visual = VisualElement(kind=kind, description='Cut source stroke', page=0, bbox=box, questionIndexes=[0] if associated else [])
    result, failures, truncated = await document._crop_visuals({
        'document': reference.model_dump(),
        'visionResults': [{'index': 0, 'kind': 'page', 'artifact': page.model_dump()}],
    }, [visual])
    assert not truncated and result[0].sourceRef == page
    assert result[0].sourceRef is not None
    assert await store.get_verified(result[0].sourceRef) == payload
    if kind == 'diagram':
        assert result[0].imageRef is None
        assert len(failures) == 1 and failures[0].code == 'CROP_UNVERIFIED'
        assert failures[0].index == 0 and not failures[0].retryable
    else:
        assert not failures and result[0].imageRef is not None
        assert await store.get_verified(result[0].imageRef) == vision.crop_figures(payload, [box])[0]


@pytest.mark.parametrize('bottom,expected_success', [(125 / 160, True), (121 / 160, False)])
@pytest.mark.parametrize('existing_image', [False, True])
@pytest.mark.parametrize('page_available', [False, True])
async def test_source_label_crop_bounds_still_pass_original_cut_guard(monkeypatch, tmp_path, bottom, expected_success, existing_image, page_available):
    buffer = BytesIO()
    with Image.new('RGB', (200, 160), 'white') as image:
        ImageDraw.Draw(image).line((80, 115, 80, 123), fill='black', width=2)
        image.save(buffer, 'PNG')
    payload = buffer.getvalue()
    monkeypatch.setenv('AI_STORAGE_DIR', str(tmp_path))
    from practiq_ai.config import load

    store = ObjectStore(load())
    monkeypatch.setattr(document, 'get_object_store', lambda: store)
    reference = await store.put_document(payload, DocumentUploadRequest(
        sourceType='image', fileName='source.png', mediaType='image/png', sizeBytes=len(payload),
        sha256=hashlib.sha256(payload).hexdigest()))
    page = await store.put_artifact(payload, source_sha256=reference.sha256, kind='page', index=0, media_type='image/png')
    box = [.2, .25, .8, .75]
    crop = [.2, .25, .8, bottom]
    old_image = await store.put_artifact(vision.crop_figures(payload, [box])[0] or b'', source_sha256=reference.sha256,
        kind='ocr-figure', index=0, media_type='image/jpeg') if existing_image else None
    visual = VisualElement(kind='diagram', description='Verified crossing source label', page=0, bbox=box, cropBbox=crop, imageRef=old_image)
    result, failures, _ = await document._crop_visuals({'document': reference.model_dump(),
        'visionResults': [{'index': 0, 'kind': 'page', 'artifact': page.model_dump()}] if page_available else []}, [visual])
    assert result[0].bbox == box and result[0].cropBbox == crop
    assert result[0].sourceRef == (page if page_available else None)
    assert bool(result[0].imageRef) == (expected_success and page_available)
    assert [f.code for f in failures] == (['CROP_FAILED'] if not page_available else [] if expected_success else ['CROP_UNVERIFIED'])
    if result[0].imageRef is not None:
        assert await store.get_verified(result[0].imageRef) == vision.crop_figures(payload, [crop])[0]
