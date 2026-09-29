"""Integrity checks for the multi-format manual import corpus, without model calls."""
import csv
import hashlib
import json
import zipfile
from pathlib import Path
from xml.etree import ElementTree

import pypdfium2 as pdfium
from PIL import Image

BASE = Path(__file__).resolve().parents[2] / "app/fixtures/ai-import"


def test_multi_format_import_corpus_preserves_content_and_assets():
    expected = json.loads((BASE / "formats-expected.json").read_text(encoding="utf-8"))
    root = BASE / "formats"
    assert len(list(root.glob("all-types*.*"))) == 10
    assert (expected["types"], expected["questionRows"], expected["compositeParents"], expected["answerableRows"]) == (16, 25, 6, 19)
    for name, digest in expected["files"].items():
        data = (root / name).read_bytes()
        assert 0 < len(data) < 25 * 1024 * 1024
        assert hashlib.sha256(data).hexdigest() == digest, name
    text = (root / "all-types.txt").read_text(encoding="utf-8")
    assert text.startswith((BASE / "all-question-types.txt").read_text(encoding="utf-8"))
    assert all(formula in text for formula in expected["formulaLatex"])
    with (root / "all-types.csv").open(newline="", encoding="utf-8") as stream:
        rows = list(csv.DictReader(stream))
    assert len(rows) == 11
    assert all(case in rows[i]["section"] for i, case in enumerate(expected["baseCases"]))
    for suffix in ("png", "jpg"):
        with Image.open(root / f"all-types.{suffix}") as image:
            assert list(image.size) == expected["rasterSize"]
            assert image.width * image.height < 25_000_000
            image.verify()
    for name, scanned in (("all-types.pdf", False), ("all-types-scanned.pdf", True)):
        with pdfium.PdfDocument(root / name) as pdf:
            assert len(pdf) == expected["pdfPages"] == 4
            pages = [page.get_textpage().get_text_range() for page in pdf]
            if scanned:
                assert not any(page.strip() for page in pages)
            else:
                assert all(case in "\n".join(pages) for case in expected["baseCases"])
                assert "determinant" in pages[-1]
    for suffix in ("doc", "xls"):
        assert (root / f"all-types.{suffix}").read_bytes().startswith(bytes.fromhex("d0cf11e0a1b11ae1"))
    for suffix, content, media in (("docx", "word/document.xml", "word/media/"), ("xlsx", "xl/sharedStrings.xml", "xl/media/")):
        with zipfile.ZipFile(root / f"all-types.{suffix}") as archive:
            assert archive.testzip() is None
            source = " ".join(ElementTree.fromstring(archive.read(content)).itertext())
            assert all(case in source for case in expected["baseCases"])
            assert any(name.startswith(media) for name in archive.namelist())
            if suffix == "xlsx":
                assert len([name for name in archive.namelist() if name.startswith("xl/worksheets/sheet") and name.endswith(".xml")]) == 13
                assert all(value in source for row in expected["table"] for value in row)
