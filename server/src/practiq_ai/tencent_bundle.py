"""Bounded Tencent result decoding; coordinates stay bound to their OCR page."""

import json
import re
import stat
import zipfile
import zlib
from contextlib import nullcontext
from io import BytesIO
from math import isfinite
from pathlib import PurePosixPath
from typing import Any
from xml.etree import ElementTree
from xml.parsers import expat

from .config import Config
from .errors import DocumentProcessingError

MAX_ENTRIES = 2_000
MAX_EXPANDED_BYTES = 150 * 1024 * 1024
MAX_PAGE_BYTES = 8 * 1024 * 1024


def evidence_text(value: Any) -> str:
    """Keep literal OCR strings for review quotes, including newlines and LaTeX."""
    if isinstance(value, str):
        return value
    values = value.values() if isinstance(value, dict) else value if isinstance(value, list) else []
    return "\n\n".join(text for item in values if (text := evidence_text(item)))


def _image_members(archive: zipfile.ZipFile, member_names: set[str]) -> dict[tuple[int, int], str]:
    members: dict[tuple[int, int], str] = {}
    for entry in archive.infolist():
        if not entry.filename.endswith("_xml_full.xml"):
            continue
        if entry.file_size > MAX_PAGE_BYTES:
            raise ValueError("XML exceeds its limit")
        parser = expat.ParserCreate()

        def reject(*_args):
            raise ValueError("XML entities and document types are forbidden")

        def start(name, attrs):
            if name != "image" or not attrs.get("src"):
                return
            identifier = re.fullmatch(r"p-(\d+)", attrs.get("id", ""))
            pages = attrs.get("page-numbers", "")
            member = attrs["src"]
            if (identifier is None or not re.fullmatch(r"\d+", pages) or member not in member_names
                    or not member.lower().endswith((".png", ".jpg", ".jpeg"))):
                raise ValueError("Image source must reference a local archive member and one page")
            key = (int(pages), int(identifier[1]))
            if key in members:
                raise ValueError("Duplicate image source association")
            members[key] = member

        parser.StartDoctypeDeclHandler = reject
        parser.EntityDeclHandler = reject
        parser.ExternalEntityRefHandler = reject
        parser.StartElementHandler = start
        parser.Parse(archive.read(entry), True)
    return members


def open_bundle(payload: bytes) -> zipfile.ZipFile:
    try:
        return zipfile.ZipFile(BytesIO(payload))
    except (zipfile.BadZipFile, ValueError, NotImplementedError) as exc:
        raise DocumentProcessingError(502, "Tencent result archive is invalid", "TENCENT_RESULT_INVALID") from exc


def read_bundle_image(archive: zipfile.ZipFile, member: str, config: Config) -> tuple[bytes, str]:
    from .extractors.image import extract

    entry = archive.getinfo(member)
    if entry.file_size > min(config.vision_max_bytes, 25 * 1024 * 1024):
        raise DocumentProcessingError(413, "Tencent subimage exceeds its limit", "TENCENT_RESULT_TOO_LARGE")
    try:
        data = archive.read(entry)
    except (zipfile.BadZipFile, zlib.error, NotImplementedError, RuntimeError) as exc:
        raise DocumentProcessingError(502, "Tencent subimage is invalid", "TENCENT_RESULT_INVALID") from exc
    extract(data)  # Shared actual-format, dimension and pixel validation.
    return data, "image/png" if data.startswith(b"\x89PNG") else "image/jpeg"


def _bbox(element: dict[str, Any], width: int, height: int) -> list[float]:
    polygon = element["polygon"]
    points = [polygon[key] for key in ("left_top", "right_top", "left_bottom", "right_bottom")]
    if any(type(p[axis]) not in {int, float} for p in points for axis in ("x", "y")):
        raise ValueError("Coordinates must be numeric")
    xs, ys = [p["x"] / width for p in points], [p["y"] / height for p in points]
    values = [min(xs), min(ys), max(xs), max(ys)]
    if (any(not isfinite(v) or not 0 <= v <= 1 for v in values)
            or values[0] >= values[2] or values[1] >= values[3]):
        raise ValueError("Invalid element coordinates")
    return values


def _label_crop_bbox(figure: dict[str, Any], elements: list[dict[str, Any]], width: int, height: int) -> list[float] | None:
    """Retain crossing labels only when Tencent also identifies them inside this figure."""
    # shortcut: skip repair above 1,000 elements; revisit for dense OCR pages.
    if len(elements) > 1_000 or any(not isinstance(element, dict) for element in elements):
        return None
    original = _bbox(figure, width, height)
    labels = {line.strip() for line in evidence_text(figure.get("figure_info")).splitlines()
              if re.fullmatch(r"[\w.()+−/\-]{1,16}", line.strip())}
    candidates = []
    for element in elements:
        if element is figure or not isinstance(element.get("text_info"), dict):
            continue
        text = element["text_info"].get("content", "")
        if not isinstance(text, str):
            continue
        text = text.strip()
        if text not in labels:
            continue
        try:
            box = _bbox(element, width, height)
        except (KeyError, TypeError, ValueError):
            continue
        if (max(box[0], original[0]) < min(box[2], original[2])
                and max(box[1], original[1]) < min(box[3], original[3])
                and not (original[0] <= box[0] < box[2] <= original[2] and original[1] <= box[1] < box[3] <= original[3])):
            candidates.append((element, text, box))
    if not candidates or len({text for _, text, _ in candidates}) != len(candidates):
        return None
    boxes = [original, *(box for _, _, box in candidates)]
    crop = [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]
    if (crop[2] - crop[0]) * (crop[3] - crop[1]) > 1.25 * (original[2] - original[0]) * (original[3] - original[1]):
        return None
    for element in elements:
        if element is figure or any(element is candidate for candidate, _, _ in candidates):
            continue
        try:
            box = _bbox(element, width, height)
        except (KeyError, TypeError, ValueError):
            return None
        if (max(box[0], crop[0]) < min(box[2], crop[2]) and max(box[1], crop[1]) < min(box[3], crop[3])
                and not (original[0] <= box[0] < box[2] <= original[2] and original[1] <= box[1] < box[3] <= original[3])):
            return None  # Additional source content must never enter a label repair.
    return crop


def decode_bundle(payload: bytes | zipfile.ZipFile, config: Config, *, page_count: int, allow_empty: bool = False, result_type: int = 9) -> list[dict[str, Any]]:
    """No archive paths are written; reject unsupported layouts rather than guess."""
    try:
        with open_bundle(payload) if isinstance(payload, bytes) else nullcontext(payload) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_ENTRIES or sum(e.file_size for e in entries) > MAX_EXPANDED_BYTES:
                raise ValueError("Archive exceeds limits")
            seen: set[str] = set()
            pages = {}
            text_size = 0
            # Validate every member before using XML associations or decoding images.
            for entry in entries:
                path = PurePosixPath(entry.filename)
                if (entry.filename in seen or path.is_absolute() or ".." in path.parts
                        or any(c in entry.filename for c in "\\:\x00")
                        or stat.S_ISLNK(entry.external_attr >> 16) or entry.flag_bits & 1):
                    raise ValueError("Unsafe archive entry")
                seen.add(entry.filename)
            if result_type == 2:
                members = [entry for entry in entries if entry.filename.endswith("_md_full.md")]
                if not members and allow_empty:
                    return []
                if len(members) != 1 or members[0].file_size > MAX_PAGE_BYTES:
                    raise ValueError("Expected one bounded Markdown result")
                text = archive.read(members[0]).decode("utf-8-sig")
                if not text.strip() and allow_empty:
                    return []
                if not text.strip() or len(text) > config.max_total_input_chars:
                    raise ValueError("Markdown evidence is empty or exceeds the shared limit")
                return [{"page": 0, "format": "markdown", "elements": [{"type": 2, "text_info": {"content": text}}], "figures": []}]
            if result_type != 9:
                raise ValueError("Unexpected result format")
            image_members = _image_members(archive, seen)
            tables = None
            for entry in entries:
                path = PurePosixPath(entry.filename)
                match = re.fullmatch(r".*_ocr_page(\d+)\.json", path.name)
                if not match:
                    continue
                page = int(match[1])
                if page in pages or not 0 <= page < page_count or entry.file_size > MAX_PAGE_BYTES:
                    raise ValueError("Invalid or repeated OCR page")
                value = json.loads(archive.read(entry))
                if isinstance(value, dict) and {"table_name", "fields", "rows"} <= value.keys():
                    if (not isinstance(value["table_name"], str) or not isinstance(value["fields"], list)
                            or not isinstance(value["rows"], list) or len(value["fields"]) > 10_000 or len(value["rows"]) > 10_000
                            or any(not isinstance(field, dict) for field in value["fields"])
                            or any(not isinstance(row, dict) or not isinstance(row.get("cells"), list)
                                   or len(row["cells"]) > 10_000 or any(not isinstance(cell, dict) for cell in row["cells"])
                                   for row in value["rows"])):
                        raise ValueError("Invalid native table evidence")
                    if tables is None:
                        tables = []
                        xml_size = 0
                        for layout in entries:
                            if layout.filename.endswith("_xml_full.xml"):
                                xml_size += layout.file_size
                                if xml_size > min(MAX_PAGE_BYTES, config.max_total_input_chars * 4):
                                    raise ValueError("Native table layouts exceed the shared limit")
                                tables.extend(ElementTree.fromstring(archive.read(layout)).iter("table"))
                    caption = value.get("caption", value["table_name"])
                    layouts = [table for table in tables if (node := table.find("caption")) is not None
                               and "".join(node.itertext()).strip() == caption.strip()] if isinstance(caption, str) else []
                    element = {"type": 3, "table_info": value}
                    if len(layouts) == 1:
                        element["layout_xml"] = ElementTree.tostring(layouts[0], encoding="unicode")
                    text_size += len(json.dumps(element, ensure_ascii=False))
                    if text_size > config.max_total_input_chars:
                        raise ValueError("Native table evidence exceeds the shared document limit")
                    pages[page] = {"page": page, "format": "table", "elements": [element], "figures": []}
                    continue
                width, height, elements = value["width"], value["height"], value["elements"]
                if (type(width) is not int or type(height) is not int or width <= 0 or height <= 0
                        or width * height > config.max_vision_page_pixels
                        or not isinstance(elements, list) or len(elements) > 10_000):
                    raise ValueError("Invalid OCR page dimensions or elements")
                figures = []
                figure_ids = set()
                for position, element in enumerate(elements):
                    if not isinstance(element, dict):
                        raise TypeError("Invalid OCR element")
                    if "figure_info" in element or "table_info" in element:
                        identifier = element.get("index", position)
                        if type(identifier) is not int or identifier < 0 or identifier in figure_ids:
                            raise ValueError("Invalid or duplicate figure identity")
                        figure_ids.add(identifier)
                        figures.append({"elementIndex": identifier,
                                        "bbox": _bbox(element, width, height),
                                        "kind": "table" if "table_info" in element else "image",
                                        "imageMember": image_members.get((page, identifier))})
                        if "figure_info" in element and (crop := _label_crop_bbox(element, elements, width, height)):
                            figures[-1]["cropBbox"] = crop
                # Keep nested table cells, formulas and reading order in source evidence.
                text = json.dumps(elements, ensure_ascii=False, separators=(",", ":"))
                text_size += len(text)
                if text_size > config.max_total_input_chars:
                    raise ValueError("OCR text exceeds the shared document limit")
                pages[page] = {"page": page, "width": width, "height": height,
                               "elements": elements, "figures": figures}
            if not pages and not allow_empty:
                raise ValueError("No supported OCR page records")
            return [pages[index] for index in sorted(pages)]
    except (ValueError, KeyError, TypeError, OverflowError, ZeroDivisionError, RecursionError,
            zipfile.BadZipFile, zlib.error, expat.ExpatError, ElementTree.ParseError, NotImplementedError, RuntimeError) as exc:
        raise DocumentProcessingError(502, "Tencent result archive is invalid or uses an unsupported layout",
                                      "TENCENT_RESULT_INVALID") from exc
