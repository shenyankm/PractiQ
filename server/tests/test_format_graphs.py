import hashlib
from typing import get_args

import pytest
from langgraph.checkpoint.memory import InMemorySaver

from practiq_ai.contracts import (
    DOCUMENT_MEDIA_TYPES,
    DocumentSourceType,
    document_source_key,
)
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.extractors import ExtractedDocument
from practiq_ai.graphs import document, formats
from tests.test_workflows import FakeModel, FakeObjectStore, question, run_config

FORMAT_GRAPHS = [
    ("text_csv_parser", ("text", "csv")),
    ("pdf_parser", ("pdf",)),
    ("docx_parser", ("docx",)),
    ("excel_parser", ("xlsx",)),
]


@pytest.mark.parametrize(("name", "allowed"), FORMAT_GRAPHS)
@pytest.mark.parametrize("source_type", get_args(DocumentSourceType))
@pytest.mark.parametrize("resume", [False, True])
async def test_format_graph_enforces_source_type_before_storage(
    monkeypatch, name, allowed, source_type, resume
):
    payload = b"1. What is 2 + 2?"
    digest = hashlib.sha256(payload).hexdigest()
    key = document_source_key(source_type, digest)
    reference = {
        "objectKey": key,
        "sha256": digest,
        "sizeBytes": len(payload),
        "sourceType": source_type,
        "mediaType": (
            "image/png" if source_type == "image"
            else next(iter(DOCUMENT_MEDIA_TYPES[source_type]))
        ),
    }
    model = FakeModel(responses=[{"questions": [question("2 + 2?")]}])
    store = FakeObjectStore({key: payload})
    extracted = []

    def get_store():
        assert source_type in allowed, "wrong format reached storage"
        return store

    def extract(kind, data):
        extracted.append(kind)
        assert data == payload
        return ExtractedDocument(text=data.decode())

    monkeypatch.setattr(document, "get_object_store", get_store)
    monkeypatch.setattr(document, "get_models", lambda: (model, None))
    monkeypatch.setattr(document, "extract", extract)
    graph = getattr(formats, name)
    config = run_config()
    graph_input = {"document": reference}
    if resume:
        graph = document.build_document_graph(
            InMemorySaver(), name=name, source_types=allowed
        )
        await graph.aupdate_state(config, graph_input, as_node="load_context")
        graph_input = None

    assert graph.name == name
    if source_type in allowed:
        output = await graph.ainvoke(graph_input, config)
        assert output["status"] == "SUCCEEDED"
        assert output["result"]["questions"][0]["stem"] == "2 + 2?"
        assert extracted == [source_type]
        assert len(model.calls) == 1
    else:
        with pytest.raises(DocumentProcessingError) as exc:
            await graph.ainvoke(graph_input, config)
        assert exc.value.code == "DOCUMENT_SOURCE_TYPE_MISMATCH"
        assert exc.value.status_code == 422
        assert extracted == model.calls == store.put_kinds == []
