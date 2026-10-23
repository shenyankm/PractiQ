"""Offline smoke check inside the hardened image; mount fixtures at /fixtures."""

import asyncio
import hashlib
import os
import subprocess
from contextlib import closing
from dataclasses import replace
from importlib.metadata import distribution
from pathlib import Path

import pypdfium2 as pdfium

from practiq_ai.config import load
from practiq_ai.contracts import (
    DOCUMENT_MEDIA_TYPES,
    DocumentReference,
    document_source_key,
)
from practiq_ai.extractors.isolated import extract
from practiq_ai.office_service import convert_office
from practiq_ai.storage import get_object_store


async def main():
    assert os.getuid() == 10001
    assert not os.access('/app/server', os.W_OK)
    assert not os.path.lexists('/app/server/LICENSE')
    package = distribution('practiq-ai-service')
    assert package.metadata['License-Expression'] == 'MIT'
    notices = [path for path in package.files or [] if str(path).endswith('.dist-info/licenses/LICENSE')]
    assert len(notices) == 1
    assert package.locate_file(notices[0]).read_bytes() == Path('/app/LICENSE').read_bytes()
    before = set(Path('/tmp').iterdir())
    document = await extract('pdf', Path('/fixtures/ai-import/formats/all-types.pdf').read_bytes())
    assert document.page_images and not document.truncated
    assert not (set(Path('/tmp').iterdir()) - before)
    engine = Path('/usr/bin/libreoffice')
    version = await asyncio.to_thread(subprocess.check_output, [str(engine), '--version'], text=True)
    config = replace(load(), office_executable=engine, office_version=version.strip())
    payload = Path('/fixtures/office/smoke.pptx').read_bytes()
    digest = hashlib.sha256(payload).hexdigest()
    source = DocumentReference(objectKey=document_source_key('pptx', digest), sha256=digest,
                               mediaType=next(iter(DOCUMENT_MEDIA_TYPES['pptx'])), sizeBytes=len(payload),
                               sourceType='pptx', fileName='smoke.pptx')
    converted = await convert_office(source, payload, mode='pdf', config=config, timeout=60)
    assert len(converted) == 1 and converted[0].source_type == 'pdf'
    with pdfium.PdfDocument(converted[0].payload) as pdf:
        assert len(pdf) == 1
        with closing(pdf[0]) as page, closing(page.get_textpage()) as text:
            assert 'PractiQ presentation smoke check' in text.get_text_range()
    assert not (set(Path('/tmp').iterdir()) - before)
    store = get_object_store()
    reference = await store.put_artifact(b'container-check', source_sha256='a' * 64, kind='text', index=0, media_type='text/plain')
    assert await store.get_verified(reference) == b'container-check'
    print('UID 10001: MIT notice, PDF rendering, real PPTX conversion, isolated extraction, temporary cleanup and mounted storage passed')


if __name__ == '__main__':
    asyncio.run(main())
