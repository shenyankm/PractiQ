"""DOCX page rendering and original embedded-image extraction."""

import os
import shutil
import signal
import subprocess
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import BadZipFile, ZipFile

from pydantic import StrictBytes, validate_call

from ..config import load
from . import DocumentProcessingError, ExtractedDocument, enforce_vision_bytes
from .pdf import extract as extract_pdf

MAX_DOCX_ENTRIES = 5_000
MAX_DOCX_EXPANDED_BYTES = 100 * 1024 * 1024
MAX_EMBEDDED_IMAGES = 50
IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp")
CONVERSION_TIMEOUT_SECONDS = 60


def convert_to_pdf(file_bytes: bytes, *, source_type: str = "docx", timeout_seconds: float | None = None) -> bytes:
    label = source_type.upper()
    executable = shutil.which(load().soffice_path)
    if executable is None:
        raise DocumentProcessingError(
            503, f"LibreOffice is required for {label} rendering", f"{label}_CONVERTER_MISSING"
        )
    with TemporaryDirectory(prefix=f"practiq-{source_type}-") as directory:
        root = Path(directory)
        source = root / f"source.{source_type}"
        source.write_bytes(file_bytes)
        profile = root / "profile" / "user"
        profile.mkdir(parents=True)
        (profile / "registrymodifications.xcu").write_text(
            '<oor:items xmlns:oor="http://openoffice.org/2001/registry">'
            '<item oor:path="/org.openoffice.Office.Common/Security/Scripting">'
            '<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>'
            '</item></oor:items>'
        )
        command = [
            executable,
            f"-env:UserInstallation={(root / 'profile').as_uri()}",
            "--headless",
            "--convert-to",
            "pdf:writer_pdf_Export" if source_type == "docx" else "pdf:calc_pdf_Export",
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
                    returncode = process.wait(timeout=min(CONVERSION_TIMEOUT_SECONDS, timeout_seconds) if timeout_seconds is not None else CONVERSION_TIMEOUT_SECONDS)
                except subprocess.TimeoutExpired as exc:
                    # Kill the conversion process group, including LibreOffice children.
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait()
                    raise DocumentProcessingError(
                        504,
                        f"{label} conversion exceeded its time limit",
                        f"{label}_CONVERSION_TIMEOUT",
                    ) from exc
        except OSError as exc:
            raise DocumentProcessingError(
                502, f"Could not start {label} converter", f"{label}_CONVERSION_FAILED"
            ) from exc
        output = root / "source.pdf"
        if returncode != 0 or not output.is_file():
            raise DocumentProcessingError(
                502, f"{label} conversion failed", f"{label}_CONVERSION_FAILED"
            )
        return output.read_bytes()


@validate_call
def extract_docx_content(file_bytes: StrictBytes) -> ExtractedDocument:
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
    document = extract_pdf(convert_to_pdf(file_bytes))
    enforce_vision_bytes(sum(map(len, images)) + sum(map(len, document.page_images)))
    return ExtractedDocument(
        text="",
        page_images=document.page_images,
        warnings=warnings,
        embedded_images=images,
        truncated=truncated,
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
