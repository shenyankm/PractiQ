"""Run untrusted document extraction in a disposable, killable process group."""

import asyncio
import base64
import json
import os
import signal
import sys
from dataclasses import asdict
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import cast

from ..contracts import DocumentSourceType
from ..errors import DocumentProcessingError
from . import ExtractedDocument


async def extract(source_type: DocumentSourceType, payload: bytes, *, timeout: float = 180) -> ExtractedDocument:
    with TemporaryDirectory(prefix="practiq-extract-") as directory:
        root = Path(directory)
        source, output = root / "source", root / "result"
        source.write_bytes(payload)
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-m", __name__, source_type, str(source), str(output),
            start_new_session=True, env={**os.environ, "TMPDIR": directory},
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            await asyncio.wait_for(process.wait(), timeout)
            if process.returncode != 0 or not output.is_file():
                raise DocumentProcessingError(502, "Document extraction process failed", "DOCUMENT_PREPARE_FAILED")
            result = json.loads(output.read_bytes(), object_hook=_decode_bytes)
            if "error" in result:
                raise DocumentProcessingError(*result["error"])
            return ExtractedDocument(**result["document"])
        except TimeoutError as exc:
            raise DocumentProcessingError(504, "Document preparation timed out", "DOCUMENT_PREPARE_TIMEOUT") from exc
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            await process.wait()


def _encode_bytes(value: bytes) -> dict[str, str]:
    return {"base64": base64.b64encode(value).decode("ascii")}


def _decode_bytes(value):
    return base64.b64decode(value["base64"], validate=True) if set(value) == {"base64"} else value


def main() -> None:
    from . import docx
    from . import extract as extract_document

    docx.ISOLATED_PROCESS = True
    source_type, source, output = sys.argv[1:]
    try:
        result = {"document": asdict(extract_document(cast(DocumentSourceType, source_type), Path(source).read_bytes()))}
    except DocumentProcessingError as exc:
        result = {"error": [exc.status_code, exc.detail, exc.code]}
    Path(output).write_text(json.dumps(result, default=_encode_bytes))


if __name__ == "__main__":
    main()
