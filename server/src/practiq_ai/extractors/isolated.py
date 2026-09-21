"""Run untrusted document extraction in a disposable, killable process group."""

import asyncio
import json
import os
import signal
import stat
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import cast

from ..config import load
from ..contracts import DocumentSourceType
from ..errors import DocumentProcessingError
from . import ExtractedDocument


async def extract(source_type: DocumentSourceType, payload: bytes, *, timeout: float = 180) -> ExtractedDocument:
    with TemporaryDirectory(prefix="practiq-extract-") as directory:
        root = Path(directory)
        source, output = root / "source", root / "result"
        await _thread_io(source.write_bytes, payload)
        process = await asyncio.create_subprocess_exec(
            *([sys.executable, "extract"] if getattr(sys, "frozen", False) else [sys.executable, "-m", __name__]), source_type, str(source), str(output),
            start_new_session=True, env={**os.environ, "TMPDIR": directory},
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            await asyncio.wait_for(process.wait(), timeout)
            if process.returncode != 0 or not output.is_file():
                raise DocumentProcessingError(502, "Document extraction process failed", "DOCUMENT_PREPARE_FAILED")
            return await _thread_io(_read_result, root)
        except TimeoutError as exc:
            raise DocumentProcessingError(504, "Document preparation timed out", "DOCUMENT_PREPARE_TIMEOUT") from exc
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            await process.wait()


async def _thread_io(function, *args):
    task = asyncio.create_task(asyncio.to_thread(function, *args))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        # Repeated cancellation must not let cleanup race the running thread.
        settled = asyncio.gather(task, return_exceptions=True)
        while not settled.done():
            try:
                await asyncio.shield(settled)
            except asyncio.CancelledError:
                pass
        raise


def _read_file(path: Path, limit: int) -> bytes:
    descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ValueError('Invalid extraction artifact')
        payload = stream.read(limit + 1)
        if len(payload) > limit:
            raise ValueError('Extraction artifact exceeds limit')
        return payload


def _write_result(root: Path, document: ExtractedDocument) -> None:
    for index, payload in enumerate(document.page_images):
        (root / f'page-{index}').write_bytes(payload)
    result = {'document': {'text': document.text, 'warnings': document.warnings,
              'truncated': document.truncated, 'page_images': list(map(len, document.page_images))}}
    (root / 'result').write_text(json.dumps(result), encoding='utf-8')


def _read_result(root: Path) -> ExtractedDocument:
    config = load()
    try:
        result = json.loads(_read_file(root / 'result', config.source_max_bytes * 8 + 65_536))
        if 'error' in result:
            raise DocumentProcessingError(*result['error'])
        document = result['document']
        sizes = document['page_images']
        if (not isinstance(sizes, list) or len(sizes) > config.max_document_pages
                or any(type(size) is not int or not 0 < size <= 25 * 1024 * 1024 for size in sizes)
                or sum(sizes) > config.vision_max_bytes
                or not isinstance(document['text'], str)
                or not isinstance(document['warnings'], list)
                or any(not isinstance(w, str) for w in document['warnings'])
                or type(document['truncated']) is not bool):
            raise ValueError('Invalid extraction manifest')
        images = [_read_file(root / f'page-{i}', size) for i, size in enumerate(sizes)]
        if any(len(payload) != size for payload, size in zip(images, sizes, strict=True)):
            raise ValueError('Incomplete extraction artifact')
        return ExtractedDocument(**{**document, 'page_images': images})
    except DocumentProcessingError:
        raise
    except (OSError, ValueError, TypeError, KeyError) as exc:
        raise DocumentProcessingError(502, 'Document extraction process failed', 'DOCUMENT_PREPARE_FAILED') from exc


def main() -> None:
    import threading
    def parent_watch():
        while os.read(0, 1024):
            pass
        if os.getpgrp() == os.getpid():
            os.killpg(os.getpgrp(), signal.SIGKILL)
        os._exit(70)
    threading.Thread(target=parent_watch, daemon=True).start()
    from . import extract as extract_document

    source_type, source, output = sys.argv[1:]
    try:
        document = extract_document(cast(DocumentSourceType, source_type), Path(source).read_bytes())
        _write_result(Path(output).parent, document)
    except DocumentProcessingError as exc:
        Path(output).write_text(json.dumps({"error": [exc.status_code, exc.detail, exc.code]}), encoding="utf-8")


if __name__ == "__main__":
    main()
