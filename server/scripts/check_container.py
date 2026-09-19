"""Offline smoke check inside the hardened image; mount fixtures at /fixtures."""

import asyncio
import os
from pathlib import Path

from practiq_ai.extractors.isolated import extract
from practiq_ai.storage import get_object_store


async def main():
    assert os.getuid() == 10001
    assert not os.access('/app/server', os.W_OK)
    before = set(Path('/tmp').iterdir())
    document = await extract('pdf', Path('/fixtures/pdf/text-layer.pdf').read_bytes())
    assert document.page_images and not document.truncated
    assert not (set(Path('/tmp').iterdir()) - before)
    store = get_object_store()
    reference = await store.put_artifact(b'container-check', source_sha256='a' * 64, kind='text', index=0, media_type='text/plain')
    assert await store.get_verified(reference) == b'container-check'
    print('UID 10001: PDF rendering, isolated extraction, temporary cleanup and mounted storage passed')


if __name__ == '__main__':
    asyncio.run(main())
