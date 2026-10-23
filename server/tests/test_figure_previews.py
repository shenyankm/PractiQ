"""Model previews are bounded; authoritative figure/source artifacts stay intact."""

import base64
import hashlib
import json
import random
from io import BytesIO
from unittest.mock import Mock

import pytest
from langgraph.runtime import Runtime
from PIL import Image

from practiq_ai.config import load
from practiq_ai.contracts import DocumentUploadRequest
from practiq_ai.graphs import document, vision
from practiq_ai.storage import ObjectStore
from tests.support import make_image, question


@pytest.mark.parametrize("encoding_fails", [False, True])
async def test_vision_bounds_provider_previews_preserves_order_and_reuses_context(monkeypatch, tmp_path, encoding_fails):
    monkeypatch.setenv("AI_STORAGE_DIR", str(tmp_path))
    store = ObjectStore(load())
    monkeypatch.setattr(document, "get_object_store", lambda: store)
    monkeypatch.setattr(document, "get_model", lambda: object())
    buffer = BytesIO()
    with Image.frombytes("RGB", (512, 512), random.Random(42).randbytes(512 * 512 * 3)) as image:
        image.save(buffer, "PNG")
    large = buffer.getvalue()
    assert len(large) > vision.MAX_CROP_BYTES
    small = make_image()
    reference = await store.put_document(small, DocumentUploadRequest(
        sourceType="image", fileName="source.png", mediaType="image/png", sizeBytes=len(small),
        sha256=hashlib.sha256(small).hexdigest()))
    page = await store.put_artifact(small, source_sha256=reference.sha256, kind="page", index=0, media_type="image/png")
    figures = [{"elementIndex": index, "bbox": [0.1, 0.1, 0.9, 0.9], "kind": "image"} for index in [8, 2, 19]]
    refs = []
    for position, payload in [(0, large), (2, small)]:
        ref = await store.put_artifact(payload, source_sha256=reference.sha256,
                                       kind="ocr-figure", index=position, media_type="image/png")
        refs.append(ref)
        figures[position]["imageRef"] = ref.model_dump()
    primary = {"page": 0, "elements": [], "figures": figures}
    ocr = await store.put_artifact(json.dumps(primary).encode(), source_sha256=reference.sha256,
                                   kind="ocr-page", index=0, media_type="application/json")
    neighbor = await store.put_artifact(json.dumps({"page": 1, "elements": [], "figures": []}).encode(),
                                        source_sha256=reference.sha256, kind="ocr-page", index=1, media_type="application/json")
    vision_crop = vision.crop_figure
    encoder = Mock(wraps=vision_crop)
    if encoding_fails:
        encoder.side_effect = lambda image, bbox: None if isinstance(image, bytes) else vision_crop(image, bbox)
    monkeypatch.setattr(vision, "crop_figure", encoder)
    calls = []

    async def call(_model, messages, schema, _kind, *, runtime):
        calls.append(messages)
        record = {**question("Question?"), "id": "page:1:1"}
        return schema.model_validate({"questions": [record], "figures": [
            {"elementIndex": item["elementIndex"], "questionIndexes": [0], "kind": "image", "description": "Source figure"}
            for item in figures]}), [], None

    monkeypatch.setattr(document, "structured_call", call)
    result = await document._vision({"kind": "page", "index": 0, "artifact": page.model_dump(),
                                    "ocrArtifact": ocr.model_dump(), "neighbors": [{"index": 1, "ocrArtifact": neighbor.model_dump()}]},
                                   Runtime(context=None))
    assert len(calls) == 2
    previews = calls[0][1:-1]
    expected_ids = [2, 19] if encoding_fails else [8, 2, 19]
    assert len(previews) == len(expected_ids)
    for message, element_index in zip(previews, expected_ids, strict=True):
        assert f"elementIndex={element_index}." in message.content[0]["text"]
        header, encoded = message.content[1]["image_url"]["url"].split(",", 1)
        payload = base64.b64decode(encoded)
        assert len(payload) <= vision.MAX_CROP_BYTES
        assert header == ("data:image/png;base64" if element_index == 19 else "data:image/jpeg;base64")
        with Image.open(BytesIO(payload)) as preview:
            assert preview.format == ("PNG" if element_index == 19 else "JPEG")
        if element_index == 19:
            assert payload == small
    assert all(first is second for first, second in zip(calls[0], calls[1], strict=False))
    assert [call.args for call in encoder.call_args_list if isinstance(call.args[0], bytes)] == [(large, [0, 0, 1, 1])]
    assert not result["failures"]
    output = result["visionResults"][0]
    assert output["parsed"]["questions"][0]["needsReview"]
    assert [item["bbox"] for item in output["visuals"]] == [item["bbox"] for item in figures]
    assert output["visuals"][0]["imageRef"] == refs[0].model_dump()
    assert output["visuals"][2]["imageRef"] == refs[1].model_dump()
    assert await store.get_verified(refs[0]) == large
    assert await store.get_verified(refs[1]) == await store.get_verified(reference) == await store.get_verified(page) == small
    assert json.loads(await store.get_verified(ocr)) == primary
