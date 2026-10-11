"""Actual parser workers keep limits without inheriting service credentials."""

import asyncio
from io import BytesIO

import pytest
from PIL import Image

from practiq_ai.errors import DocumentProcessingError
from practiq_ai.extractors import isolated
from tests.support import make_blank_pdf


@pytest.mark.parametrize("kind", ["pdf", "PNG", "JPEG", "text", "csv"])
async def test_worker_environment_excludes_credentials_and_runs_parsers(monkeypatch, kind):
    secrets = {key: "synthetic-worker-secret" for key in (
        "LLM_API_KEY", "AI_SERVICE_TOKEN", "DATABASE_URI", "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY", "CUSTOM_PASSWORD", "HTTP_PROXY",
    )}
    for key, value in secrets.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setenv("AI_READ_ONLY", "1")
    monkeypatch.setenv("AI_MAX_DOCUMENT_PAGES", "2")
    monkeypatch.setenv("AI_MAX_VISION_PAGE_PIXELS", "40000")
    original = asyncio.create_subprocess_exec
    environments = []

    async def launch(*args, **kwargs):
        env = kwargs["env"]
        environments.append(env)
        assert not any(value in env.values() for value in secrets.values())
        assert not (set(secrets) - {"AI_SERVICE_TOKEN"}) & env.keys()
        assert env["TMPDIR"] == env["TEMP"] == env["TMP"]
        assert env["AI_MAX_DOCUMENT_PAGES"] == "2"
        assert env["AI_MAX_VISION_PAGE_PIXELS"] == "40000"
        assert kwargs["stdout"] == kwargs["stderr"] == asyncio.subprocess.DEVNULL
        return await original(*args, **kwargs)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    if kind == "pdf":
        result = await isolated.extract("pdf", make_blank_pdf(2, size=40))
        assert len(result.page_images) == 2
        assert all(page.startswith(b"\x89PNG") for page in result.page_images)
    elif kind in {"PNG", "JPEG"}:
        payload = BytesIO()
        Image.new("RGB", (200, 200), "white").save(payload, format=kind)
        result = await isolated.extract("image", payload.getvalue())
        assert result.page_images == [payload.getvalue()]
    elif kind == "text":
        assert (await isolated.extract("text", b"Question")).text == "Question"
    else:
        assert (await isolated.extract("csv", b"Question,Answer")).text == "Question\tAnswer"
    assert len(environments) == 1


@pytest.mark.parametrize("key,value,source_type", [
    ("AI_SOURCE_MAX_BYTES", "1", "text"),
    ("AI_MAX_DOCUMENT_PAGES", "1", "pdf"),
    ("AI_MAX_VISION_PAGE_PIXELS", "1", "image"),
    ("AI_MAX_VISION_BYTES", "1", "pdf"),
])
async def test_actual_worker_retains_configured_parser_limits(monkeypatch, key, value, source_type):
    monkeypatch.setenv("AI_READ_ONLY", "1")
    monkeypatch.setenv(key, value)
    if source_type == "pdf":
        payload = make_blank_pdf(2)
    elif source_type == "image":
        buffer = BytesIO()
        Image.new("RGB", (2, 2)).save(buffer, format="PNG")
        payload = buffer.getvalue()
    else:
        payload = b"Question"
    with pytest.raises(DocumentProcessingError) as error:
        await isolated.extract(source_type, payload)
    assert error.value.status_code == 413
