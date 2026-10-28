"""Assert mixed scratch pressure inside the hardened Linux image; no models/network."""

import asyncio
import io
import json
import random
import shutil
import subprocess
import wave
from pathlib import Path
from zipfile import ZipFile

from PIL import Image

from practiq_ai import bank_export, temporary
from practiq_ai.config import MIB, load
from practiq_ai.contracts import DocumentTaskDetail, DocumentUploadRequest
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.execution import code_version
from practiq_ai.extractors.isolated import extract
from practiq_ai.office_service import convert_office
from practiq_ai.storage import get_object_store


async def main():
    import hashlib
    import os
    import time

    assert os.getuid() == 10001
    rng = random.Random(244)
    images = [Image.frombytes('RGB', (1800, 1800), rng.randbytes(1800 * 1800 * 3)) for _ in range(5)]
    pdf = io.BytesIO()
    images[0].save(pdf, format='PDF', save_all=True, append_images=images[1:], resolution=200, quality=95)
    for image in images:
        image.close()
    del images
    pdf_bytes = pdf.getvalue()
    assert len(pdf_bytes) < 25 * MIB
    office_bytes = io.BytesIO()
    # Exercise the real deployed engine with a valid near-source-limit OOXML snapshot.
    with ZipFile('/fixtures/ai-import/formats/all-types.docx') as original, ZipFile(office_bytes, 'w') as target:
        for entry in original.infolist():
            target.writestr(entry, original.read(entry))
        target.writestr('word/media/pressure.bin', rng.randbytes(24 * MIB))
    docx = office_bytes.getvalue()
    assert len(docx) < 25 * MIB
    store = get_object_store()
    async def source(kind, data, media):
        return await store.put_document(data, DocumentUploadRequest(sourceType=kind, fileName='pressure.' + kind,
                         mediaType=media, sizeBytes=len(data), sha256=hashlib.sha256(data).hexdigest()))
    reference = await source('text', b'1. Preserved', 'text/plain')
    office_reference = await source('docx', docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    questions = []
    for index in range(10):
        buffer = io.BytesIO()
        with wave.open(buffer, 'wb') as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(48000)
            audio.writeframes(rng.randbytes(25 * MIB - 44))
        artifact = await store.put_artifact(buffer.getvalue(), source_sha256=reference.sha256, kind='audio', index=index, media_type='audio/wav')
        questions.append({'id': str(index), 'stem': 'Preserved', 'sourceText': 'Preserved', 'answerMode': 'listening',
                          'questionTypeId': None, 'items': [], 'options': [], 'answerPayload': None, 'contentBlocks': [],
                          'confidence': 0.5, 'needsReview': True, 'missingFields': ['answerPayload'], 'audioRef': artifact.model_dump()})
        questions.append({'id': f'child-{index}', 'parentId': str(index), 'stem': 'Preserved', 'sourceText': 'Preserved',
                          'answerMode': 'short_answer', 'questionTypeId': None, 'items': [], 'options': [],
                          'answerPayload': None, 'contentBlocks': [], 'confidence': 0.5,
                          'needsReview': True, 'missingFields': ['answerPayload']})
        buffer.close()
    task = DocumentTaskDetail.model_validate({
        'threadId': '11111111-1111-4111-8111-111111111111', 'runId': None, 'parentThreadId': None,
        'modelConfigured': False, 'resumeCompatible': False, 'fileName': 'pressure.txt', 'state': 'COMPLETED',
        'phase': 'completed', 'checkpointId': 'saved', 'updatedAt': '2026-10-16', 'expiresAt': '2026-10-17',
        'allowedActions': [], 'failures': [], 'blocking': [],
        'progress': {key: {'total': 0, 'succeeded': 0, 'failed': 0, 'remaining': 0} for key in ('visuals', 'chunks')},
        'status': 'PARTIAL', 'result': {'schemaVersion': 3, 'questions': questions, 'groups': [], 'visualElements': [],
            'warnings': [], 'confidenceScore': 50, 'missingFields': []},
        'modelBudget': {'limit': 1, 'reserved': 0}, 'processing': None, 'usage': [], 'unknownUsageCalls': [],
    })
    peak_tmp = 0
    done = asyncio.Event()
    async def monitor():
        nonlocal peak_tmp
        while not done.is_set():
            peak_tmp = max(peak_tmp, shutil.disk_usage('/tmp').used)
            await asyncio.sleep(0.02)
    watcher = asyncio.create_task(monitor())
    started = time.monotonic()
    try:
        output = await bank_export.export_task_bank(task, store, source=reference)
        try:
            with ZipFile(output) as archive:
                assert archive.testzip() is None
            zip_bytes = output.seek(0, 2)
            assert zip_bytes > 249 * MIB
            pending = await asyncio.gather(extract('pdf', pdf_bytes), convert_office(office_reference, docx, mode='pdf', config=load(), timeout=180), return_exceptions=True)
            assert all(isinstance(value, DocumentProcessingError) and value.code == 'TEMPORARY_BUSY' for value in pending)
            assert temporary.current().used > 300 * MIB  # A slow downloader still owns its file.
            try:
                await bank_export.export_task_bank(task, store, source=reference)
            except DocumentProcessingError as error:
                assert error.code == 'TEMPORARY_BUSY'
            else:
                raise AssertionError('Second ZIP overcommitted scratch')
        finally:
            output.close()
        prepared, converted = await asyncio.gather(extract('pdf', pdf_bytes), convert_office(office_reference, docx, mode='pdf', config=load(), timeout=180))
        assert prepared.page_images and converted and temporary.current().used == 0
        assert not list(Path('/tmp').glob('practiq-*'))
        events = dict(line.split() for line in Path('/sys/fs/cgroup/memory.events').read_text().splitlines())
        memory_peak = int(Path('/sys/fs/cgroup/memory.peak').read_text())
        assert int(events['oom_kill']) == int(events['oom']) == 0
        assert peak_tmp <= 0.8 * 512 * MIB and memory_peak <= 0.8 * 2 * 1024 * MIB
        version = await asyncio.to_thread(subprocess.check_output, [str(load().office_executable), '--version'], text=True)
        print(json.dumps({'status': 'PASSED', 'codeHash': code_version(), 'pdfSourceBytes': len(pdf_bytes),
            'pdfPageBytes': sum(map(len, prepared.page_images)), 'officeSourceBytes': len(docx), 'zipBytes': zip_bytes,
            'tmpPeakBytes': peak_tmp, 'memoryPeakBytes': memory_peak, 'memoryEvents': events,
            'seconds': time.monotonic() - started, 'overloadRejected': 3, 'explicitPreparationRetries': 2,
            'officeVersion': version.strip()}))
    finally:
        done.set()
        await watcher


if __name__ == '__main__':
    asyncio.run(main())
