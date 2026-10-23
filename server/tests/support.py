"""Shared test data and fakes; no test modules are imported here."""
import asyncio
import hashlib
import json
import zipfile
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
    DocumentUploadResponse,
    document_source_key,
)
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.graphs import document
from practiq_ai.graphs.chunking import source_presence_plan, split_chunk_plan
from practiq_ai.storage import ObjectStore, StorageHealth, verify_payload


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


def tencent_provider(monkeypatch, pages: list[dict[str, Any]] | None = None):
    """Replace only Tencent HTTP; plain-text fixtures echo the actual input bytes."""
    import base64

    from practiq_ai import tencent

    monkeypatch.setenv("AI_TENCENT_SECRET_ID", "synthetic-id")
    monkeypatch.setenv("AI_TENCENT_SECRET_KEY", "synthetic-key")
    calls = []
    archives = {}
    counts = {}

    async def request(action, data, config):
        calls.append((action, data))
        if action == "SubmitMultimodalDocParseJob":
            payload = base64.b64decode(data["FileBase64"])
            task_id = "synthetic-" + hashlib.sha256(payload).hexdigest()
            evidence = pages
            if evidence is None:
                assert data["FileType"] in {5, 6}, "Visual fixtures must provide explicit Tencent OCR evidence"
                evidence = [ocr_text_page(payload.decode("utf-8-sig"))]
            buffer = BytesIO()
            with zipfile.ZipFile(buffer, "w") as archive:
                if data["ResultType"] == 2:
                    archive.writestr("fixture_md_full.md", "\n".join(
                        element["text_info"]["content"] for page in evidence for element in page["elements"] if "text_info" in element))
                else:
                    for index, page in enumerate(evidence):
                        archive.writestr(f"fixture_ocr_page{index}.json", json.dumps(page))
            archives[task_id] = buffer.getvalue()
            counts[task_id] = len(evidence)
            return {"TaskId": task_id, "RequestId": str(uuid4())}
        return {"Status": "Success", "ResultUrl": "https://fixture.cos.ap-guangzhou.myqcloud.com/" + data["TaskId"],
                "SuccessPageNum": counts[data["TaskId"]], "FailPageNum": 0, "FailedPages": [], "RequestId": str(uuid4())}

    async def download(url):
        return archives[url.rsplit("/", 1)[1]]

    monkeypatch.setattr(tencent, "request", request)
    monkeypatch.setattr(tencent, "download_result", download)
    monkeypatch.setattr(tencent, "get_object_store", lambda: document.get_object_store())
    return calls


def ocr_text_page(text: str, *, figures: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    elements = [{"type": 2, "text_info": {"content": text}}]
    for index, figure in enumerate(figures or []):
        x0, y0, x1, y1 = [value * 1000 for value in figure["bbox"]]
        elements.append({"index": index, "figure_info": {}, "polygon": {
            "left_top": {"x": x0, "y": y0}, "right_top": {"x": x1, "y": y0},
            "left_bottom": {"x": x0, "y": y1}, "right_bottom": {"x": x1, "y": y1},
        }})
    return {"width": 1000, "height": 1000, "elements": elements}


def ocr_page_model(monkeypatch, responses, *, page_count=1):
    """Migrate fixed page fixtures: boxes belong to Tencent, identities to the LLM.

    The first draft defines this fixture's immutable PRIMARY inventory. Context
    drafts can change associations/content, but cannot replace its source boxes.
    Tests of untrusted model coordinates use FakeModel directly instead.
    """
    source_figures = next((row.get("figures", []) for row in responses
                           if isinstance(row, dict) and row.get("figures")), [])
    tencent_provider(monkeypatch, [ocr_text_page("Synthetic primary source", figures=source_figures),
                                  *[ocr_text_page("Synthetic context source") for _ in range(page_count - 1)]])
    return FakeModel(responses=[ocr_draft(row) for row in responses])


def ocr_draft(row):
    """Fixture wire representation; the legacy box is deliberately not LLM input."""
    if not isinstance(row, dict) or not isinstance(row.get("figures", []), list):
        return row
    return {**row, "figures": [{**{key: value for key, value in figure.items() if key != "bbox"}, "elementIndex": index}
                              for index, figure in enumerate(row.get("figures", []))]}


def tencent_pages(monkeypatch, reference, count, *, figures=None):
    """Turn a graph fixture into a managed visual source with fixed OCR pages."""
    files = document.get_object_store()
    assert isinstance(files, FakeObjectStore), "Visual graph fixtures require their in-memory object store"
    old_key = reference["objectKey"]
    kind = reference["sourceType"] if reference["sourceType"] in {"pdf", "image"} else "pdf"
    reference.update(sourceType=kind, mediaType="image/png" if kind == "image" else "application/pdf",
                     objectKey=document_source_key(kind, reference["sha256"]))
    files.blobs[reference["objectKey"]] = files.blobs.pop(old_key)
    return tencent_provider(monkeypatch, [ocr_text_page(f"Source page {index + 1}", figures=figures or []) for index in range(count)])


class FakeObjectStore:
    def __init__(self, blobs: dict[str, bytes]):
        self.blobs = blobs
        self.put_kinds: list[str] = []

    async def health(self):
        return StorageHealth(True)

    async def require_available(self):
        if not (await self.health()).healthy:
            raise DocumentProcessingError(503, 'File storage is unavailable', 'OBJECT_STORE_UNAVAILABLE')

    async def prepare_document(self, request):
        return DocumentUploadResponse(document=DocumentReference(
            objectKey=document_source_key(request.sourceType, request.sha256), sha256=request.sha256,
            mediaType=request.mediaType, sizeBytes=request.sizeBytes, sourceType=request.sourceType,
            fileName=request.fileName,
        ), upload=None)

    async def get_verified(self, reference):
        payload = self.blobs[reference.objectKey]
        await verify_payload(reference, payload)
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
        if kind == "unit-result":
            key = f"practiq-agent/artifacts/{source_sha256}/{kind}/{index}-{digest}.json"
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


def source_presence_hints(text: str, *, source_type: str = 'text', tabular_rows_safe: bool = False):
    spans, _, _ = split_chunk_plan(text, source_type=source_type, tabular_rows_safe=tabular_rows_safe)
    assert len(spans) == 1, 'Source-presence fixture must fit one complete chunk'
    return source_presence_plan(text, spans, source_type=source_type, tabular_rows_safe=tabular_rows_safe)[0]


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
        monkeypatch.setattr(document, "split_chunk_plan", lambda _, **kwargs: ([
            {"start": sum(map(len, parts[:i])), "end": sum(map(len, parts[:i + 1])),
             "overlapStart": sum(map(len, parts[:i])), "overlapEnd": sum(map(len, parts[:i]))}
            for i in range(len(parts))
        ], None, [None] * len(parts)))
    tencent_provider(monkeypatch)
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
