"""Native desktop boundaries exercised on macOS, Windows and Linux CI."""
import asyncio
import subprocess
import sys
from io import BytesIO

import pytest
from PIL import Image

from practiq_ai.database import Ownership
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.extractors import isolated


async def test_ownership_excludes_another_process_and_releases_on_close(tmp_path):
    path = tmp_path / 'owner.lock'
    owner = Ownership(path)
    probe = '''
import sys
from pathlib import Path
from practiq_ai.database import Ownership
try:
    owner = Ownership(Path(sys.argv[1]))
except BlockingIOError:
    sys.exit(23)
owner.file.close()
'''
    try:
        owner.check()
        assert (await asyncio.to_thread(subprocess.run, [sys.executable, '-c', probe, str(path)], timeout=30, check=False)).returncode == 23
    finally:
        await owner.close()
    assert (await asyncio.to_thread(subprocess.run, [sys.executable, '-c', probe, str(path)], timeout=30, check=False)).returncode == 0


@pytest.mark.parametrize('kind', ['text', 'csv', 'image', 'pdf'])
async def test_native_extraction_roundtrip(kind):
    if kind in {'image', 'pdf'}:
        data = BytesIO()
        Image.new('RGB', (80, 60), 'white').save(data, 'PNG' if kind == 'image' else 'PDF')
        payload = data.getvalue()
    else:
        payload = 'Question,Answer\n测试,A\n'.encode()
    result = await isolated.extract(kind, payload)
    if kind in {'image', 'pdf'}:
        assert result.page_images
    else:
        assert '测试' in result.text


async def test_native_extraction_timeout_and_cancellation_recover():
    with pytest.raises(DocumentProcessingError) as error:
        await isolated.extract('text', b'Question', timeout=0)
    assert error.value.code == 'DOCUMENT_PREPARE_TIMEOUT'
    task = asyncio.create_task(isolated.extract('text', b'Question'))
    await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert (await isolated.extract('text', b'Recovered')).text == 'Recovered'


@pytest.mark.skipif(sys.platform != 'win32', reason='Native Windows Job Object boundary')
@pytest.mark.parametrize('stop', ['parent_exit', 'terminate_worker'])
async def test_windows_extraction_worker_kills_descendants(tmp_path, stop):
    if sys.platform != 'win32':
        pytest.skip('Native Windows Job Object boundary')
    import ctypes
    from ctypes import wintypes

    # Use the production worker/watchdog with a slow renderer substitute.
    probe = '''
import subprocess, sys, time
import practiq_ai.extractors as extractors
from practiq_ai.extractors.isolated import main
def slow(*args):
    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
    print(child.pid, flush=True)
    time.sleep(120)
extractors.extract = slow
sys.argv = ['worker', 'text', sys.argv[1], sys.argv[2]]
main()
'''
    source = tmp_path / 'source'
    source.write_bytes(b'question')
    worker = await asyncio.create_subprocess_exec(sys.executable, '-c', probe, str(source), str(tmp_path / 'result'),
                                                  stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE)
    assert worker.stdout is not None and worker.stdin is not None
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = None
    try:
        pid = int(await asyncio.wait_for(worker.stdout.readline(), 30))
        handle = kernel.OpenProcess(0x100000, False, pid)  # SYNCHRONIZE
        assert handle
        if stop == 'parent_exit':
            worker.stdin.close()
        else:
            worker.kill()
        await asyncio.wait_for(worker.wait(), 15)
        assert await asyncio.to_thread(kernel.WaitForSingleObject, handle, 10000) == 0
    finally:
        if worker.returncode is None:
            worker.kill()
            await worker.wait()
        if handle:
            kernel.CloseHandle(handle)


async def test_native_storage_publication_and_replacement(tmp_path):
    from tests.support import object_store

    store = object_store(tmp_path / '测试 storage')
    store._write('nested/document', b'first')
    store._write('nested/document', b'replacement')
    assert store._read('nested/document', 11) == b'replacement'
    assert [path.name for path in (store.root / 'nested').iterdir()] == ['document']
