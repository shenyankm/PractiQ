"""Frozen format-matrix provenance, OOXML uploads and lossless image groups."""

import hashlib
import json
from collections import Counter
from pathlib import Path
from xml.etree import ElementTree
from zipfile import ZipFile

import pytest
from PIL import Image

from practiq_ai.config import load
from practiq_ai.storage import ObjectStore
from scripts import evaluate

ROOT = Path(__file__).parents[1] / "evals"
MATRIX = ROOT / "formats30"


def test_format_matrix_preserves_source_gold_and_exact_six_per_format():
    original = json.loads((ROOT / "cases.json").read_text())
    gold = {case["id"]: case for case in original["cases"]}
    manifest = evaluate.load_manifest(MATRIX / "cases.json")
    provenance = json.loads((MATRIX / "provenance.json").read_text())
    assert Counter(case["sourceType"] for case in manifest["cases"]) == dict.fromkeys(["text", "docx", "pdf", "xlsx", "image"], 6)
    assert provenance["baseManifestSha256"] == hashlib.sha256((ROOT / "cases.json").read_bytes()).hexdigest()
    assert len(manifest["cases"]) == len(provenance["cases"]) == 30
    for case, record in zip(manifest["cases"], provenance["cases"], strict=True):
        assert case["id"] == record["id"]
        source = gold[record["regressionCaseId"]]
        assert case["expectedQuestions"] == evaluate.GoldCase.model_validate(source).model_dump(mode="json")["expectedQuestions"]
        assert hashlib.sha256((MATRIX / case["path"]).read_bytes()).hexdigest() == record["sha256"]
        if case["sourceType"] in {"docx", "xlsx"}:
            with ZipFile(MATRIX / case["path"]) as archive:
                member = "word/document.xml" if case["sourceType"] == "docx" else "xl/worksheets/sheet1.xml"
                namespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main" if case["sourceType"] == "docx" else "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
                lines = [node.text or "" for node in ElementTree.fromstring(archive.read(member)).iter("{" + namespace + "}t")]
                assert lines == (ROOT / source["path"]).read_text().splitlines()
        if case["sourceType"] == "image":
            assert len(record["imageGroup"]) == 2
            with Image.open(MATRIX / case["path"]) as combined:
                for member in record["imageGroup"]:
                    path = (MATRIX / member["path"]).resolve()
                    assert path.is_relative_to(MATRIX.resolve())
                    assert hashlib.sha256(path.read_bytes()).hexdigest() == member["sha256"]
                    with Image.open(path) as image:
                        bounds = (member["x"], member["y"], member["x"] + member["width"], member["y"] + member["height"])
                        assert combined.crop(bounds).tobytes() == image.tobytes()


@pytest.mark.parametrize("kind", ["docx", "xlsx"])
async def test_format_evaluator_uploads_verified_office_sources(monkeypatch, tmp_path, kind):
    monkeypatch.setenv("AI_STORAGE_DIR", str(tmp_path))
    store = ObjectStore(load())
    monkeypatch.setattr(evaluate, "get_object_store", lambda: store)
    case = next(case for case in evaluate.load_manifest(MATRIX / "cases.json")["cases"] if case["sourceType"] == kind)
    from practiq_ai.contracts import DocumentReference

    reference = DocumentReference.model_validate(await evaluate.prepare_document(case, MATRIX / "cases.json"))
    assert reference.sourceType == kind
    assert await store.get_verified(reference) == (MATRIX / case["path"]).read_bytes()
