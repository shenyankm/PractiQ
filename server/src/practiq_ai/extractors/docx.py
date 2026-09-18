"""DOCX page rendering and original embedded-image extraction."""

import os
import shutil
import signal
import subprocess
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import BadZipFile, ZipFile

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, ConfigDict, StrictBytes

from ..config import load
from . import DocumentProcessingError, ExtractedDocument, enforce_vision_bytes
from .pdf import extract as extract_pdf

MAX_DOCX_ENTRIES = 5_000
MAX_DOCX_EXPANDED_BYTES = 100 * 1024 * 1024
MAX_EMBEDDED_IMAGES = 50
IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp")
CONVERSION_TIMEOUT_SECONDS = 60


class DocxExtractionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    file_bytes: StrictBytes


def convert_to_pdf(file_bytes: bytes) -> bytes:
    executable = shutil.which(load().soffice_path)
    if executable is None:
        raise DocumentProcessingError(
            503, "LibreOffice is required for DOCX rendering", "DOCX_CONVERTER_MISSING"
        )
    with TemporaryDirectory(prefix="practiq-docx-") as directory:
        root = Path(directory)
        source = root / "source.docx"
        source.write_bytes(file_bytes)
        command = [
            executable,
            f"-env:UserInstallation={(root / 'profile').as_uri()}",
            "--headless",
            "--convert-to",
            "pdf:writer_pdf_Export",
            "--outdir",
            str(root),
            str(source),
        ]
        try:
            with subprocess.Popen(
                command,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            ) as process:
                try:
                    returncode = process.wait(timeout=CONVERSION_TIMEOUT_SECONDS)
                except subprocess.TimeoutExpired as exc:
                    # Kill the conversion process group, including LibreOffice children.
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait()
                    raise DocumentProcessingError(
                        504,
                        "DOCX conversion exceeded 60 seconds",
                        "DOCX_CONVERSION_TIMEOUT",
                    ) from exc
        except OSError as exc:
            raise DocumentProcessingError(
                502, "Could not start DOCX converter", "DOCX_CONVERSION_FAILED"
            ) from exc
        output = root / "source.pdf"
        if returncode != 0 or not output.is_file():
            raise DocumentProcessingError(
                502, "DOCX conversion failed", "DOCX_CONVERSION_FAILED"
            )
        return output.read_bytes()


def _extract_docx_content(file_bytes: bytes) -> ExtractedDocument:
    if len(file_bytes) > load().source_max_bytes:
        raise DocumentProcessingError(413, "Uploaded file is too large")
    _validate_docx_archive(file_bytes)
    warnings: list[str] = []
    try:
        images, truncated = _extract_embedded_images(file_bytes, warnings)
    except DocumentProcessingError:
        raise
    except (BadZipFile, RuntimeError, OSError) as exc:
        raise DocumentProcessingError(400, "DOCX image extraction failed") from exc
    document = extract_pdf("", convert_to_pdf(file_bytes))
    enforce_vision_bytes(sum(map(len, images)) + sum(map(len, document.page_images)))
    return ExtractedDocument(
        text="",
        page_images=document.page_images,
        warnings=warnings,
        embedded_images=images,
        truncated=truncated,
    )


extract_docx_content = StructuredTool.from_function(
    func=_extract_docx_content,
    name="extract_docx_content",
    description="Render verified DOCX bytes as pages and extract original images.",
    args_schema=DocxExtractionInput,
)


def _validate_docx_archive(file_bytes: bytes) -> set[str]:
    try:
        with ZipFile(BytesIO(file_bytes)) as archive:
            infos = archive.infolist()
            names = {info.filename for info in infos}
            if "word/document.xml" not in names:
                raise DocumentProcessingError(
                    400, "Uploaded file is not a DOCX document"
                )
            if (
                len(infos) > MAX_DOCX_ENTRIES
                or sum(info.file_size for info in infos) > MAX_DOCX_EXPANDED_BYTES
            ):
                raise DocumentProcessingError(413, "DOCX expanded content is too large")
            return names
    except BadZipFile as exc:
        raise DocumentProcessingError(
            400, "Uploaded file is not a valid DOCX document"
        ) from exc


def _extract_embedded_images(
    file_bytes: bytes, warnings: list[str]
) -> tuple[list[bytes], bool]:
    images: list[bytes] = []
    total_bytes = 0
    max_bytes = load().vision_max_bytes
    with ZipFile(BytesIO(file_bytes)) as archive:
        media_names = [
            name
            for name in archive.namelist()
            if name.startswith("word/media/") and name.lower().endswith(IMAGE_SUFFIXES)
        ]
        for name in media_names[:MAX_EMBEDDED_IMAGES]:
            with archive.open(name) as image_file:
                image = image_file.read(max_bytes - total_bytes + 1)
            total_bytes += len(image)
            enforce_vision_bytes(total_bytes)
            images.append(image)
        if len(media_names) > MAX_EMBEDDED_IMAGES:
            warnings.append(
                f"docx contains {len(media_names)} images; only the first "
                f"{MAX_EMBEDDED_IMAGES} were analyzed."
            )
    return images, len(media_names) > MAX_EMBEDDED_IMAGES
