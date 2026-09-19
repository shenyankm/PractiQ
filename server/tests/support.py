"""Shared test data and fakes; no test modules are imported here."""
import asyncio
import hashlib
import json
from dataclasses import replace
from io import BytesIO
from pathlib import Path
from typing import Any, cast
from uuid import uuid4

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.runnables import RunnableConfig, RunnableLambda
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.store.memory import InMemoryStore
from PIL import Image
from pydantic import BaseModel, Field, ValidationError

from practiq_ai.config import load
from practiq_ai.contracts import (
    ArtifactReference,
    DocumentReference,
    DocumentUploadRequest,
)
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.graphs import document
from practiq_ai.storage import ObjectStore


class FakeModel(BaseChatModel):
    responses: list[Any]
    calls: list[list[Any]] = Field(default_factory=list)

    @property
    def _llm_type(self) -> str:
        return "fake"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=""))])

    def with_structured_output(self, schema: Any, *, include_raw=False, **kwargs):
        async def invoke(messages):
            self.calls.append(list(messages))
            item = self.responses.pop(0)
            if callable(item):
                item = item(messages, schema)
            delay = 0
            if isinstance(item, tuple):
                delay, item = item
            if delay:
                await asyncio.sleep(delay)
            if isinstance(item, Exception):
                raise item
            raw = AIMessage(
                content=json.dumps(item),
                usage_metadata={
                    "input_tokens": 10,
                    "output_tokens": 5,
                    "total_tokens": 15,
                },
            )
            try:
                parsed = cast(type[BaseModel], schema).model_validate(item)
                error = None
            except ValidationError as exc:
                parsed, error = None, exc
            return {"raw": raw, "parsed": parsed, "parsing_error": error}

        return RunnableLambda(invoke)


class FakeObjectStore:
    def __init__(self, blobs: dict[str, bytes]):
        self.blobs = blobs
        self.put_kinds: list[str] = []

    async def get_verified(self, reference):
        payload = self.blobs[reference.objectKey]
        if len(payload) != reference.sizeBytes:
            raise DocumentProcessingError(
                409, "Stored document size does not match", "DOCUMENT_SIZE_MISMATCH"
            )
        if hashlib.sha256(payload).hexdigest() != reference.sha256:
            raise DocumentProcessingError(
                409,
                "Stored document checksum does not match",
                "DOCUMENT_CHECKSUM_MISMATCH",
            )
        return payload

    async def put_artifact(
        self,
        payload: bytes,
        *,
        source_sha256: str,
        kind: str,
        index: int,
        media_type: str,
    ):
        digest = hashlib.sha256(payload).hexdigest()
        key = f"artifact/{source_sha256}/{kind}/{index}/{digest}"
        self.blobs[key] = payload
        self.put_kinds.append(kind)
        return ArtifactReference(
            objectKey=key,
            sha256=digest,
            mediaType=media_type,
            sizeBytes=len(payload),
        )


def question(stem: str) -> dict[str, Any]:
    return {
        "stem": stem,
        "sourceText": stem,
        "answerMode": "short_answer",
        "questionTypeId": "imported-short",
        "options": [],
        "contentBlocks": [{"partType": "text", "textValue": stem}],
        "confidence": 0.8,
        "needsReview": False,
    }


def source(text: str) -> tuple[FakeObjectStore, dict[str, Any]]:
    payload = text.encode()
    digest = hashlib.sha256(payload).hexdigest()
    key = f"practiq-agent/sources/{digest}/source.txt"
    reference = DocumentReference(
        objectKey=key,
        sha256=digest,
        mediaType="text/plain",
        sizeBytes=len(payload),
        sourceType="text",
        fileName="quiz.txt",
    )
    return FakeObjectStore({key: payload}), reference.model_dump(mode="json")


def run_config(thread: str = "thread-1") -> RunnableConfig:
    return cast(
        RunnableConfig,
        {"configurable": {"thread_id": thread}, "run_id": uuid4()},
    )


def local_graph(checkpointer=None, **kwargs):
    """Explicit local Store; production uses PostgreSQL-backed storage."""
    kwargs.setdefault("store", InMemoryStore())
    return document.build_document_graph(checkpointer, **kwargs).with_config(run_config())


def make_image() -> bytes:
    buffer = BytesIO()
    Image.new("RGB", (200, 200), "white").save(buffer, format="PNG")
    return buffer.getvalue()


class MemoryStore(InMemoryStore):
    # Accept TTL metadata in unit tests; expiry itself is tested at the boundary.
    supports_ttl = True


def setup_graph(monkeypatch, responses, *, parts=None):
    files, reference = source("".join(parts) if parts else "1. First\n2. Second")
    model = FakeModel(responses=responses)
    store = MemoryStore()
    monkeypatch.setattr(document, "get_model", lambda *args: model)
    monkeypatch.setattr(document, "get_object_store", lambda: files)
    if parts:
        monkeypatch.setattr(document, "split_chunk_spans", lambda _: [
            {"start": sum(map(len, parts[:i])), "end": sum(map(len, parts[:i + 1])),
             "overlapStart": sum(map(len, parts[:i])), "overlapEnd": sum(map(len, parts[:i]))}
            for i in range(len(parts))
        ])
    graph = local_graph(InMemorySaver(), store=store)
    return graph, store, files, reference, model


def parsed(stem="First"):
    return {"questions": [question(stem)], "groups": []}


def make_blank_pdf(pages: int, size: int = 200) -> bytes:
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument.new()
    for _ in range(pages):
        document.new_page(size, size)
    buffer = BytesIO()
    document.save(buffer)
    document.close()
    return buffer.getvalue()


def object_store(root: Path, **overrides) -> ObjectStore:
    return ObjectStore(replace(load(), storage_dir=root, **overrides))


def upload(payload=b"quiz"):
    return DocumentUploadRequest(sourceType="text", fileName="quiz.txt", mediaType="text/plain",
                                 sizeBytes=len(payload), sha256=hashlib.sha256(payload).hexdigest())
