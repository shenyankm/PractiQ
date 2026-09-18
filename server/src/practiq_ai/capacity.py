"""Per-process provider allocation and native queue admission; no second queue."""

import asyncio
import time
from collections import deque
from contextlib import asynccontextmanager
from weakref import WeakKeyDictionary

from langgraph_sdk import get_client

from . import telemetry
from .config import load
from .errors import DocumentProcessingError


class ProviderGate:
    def __init__(self, concurrency: int, rpm: int):
        self.semaphore = asyncio.Semaphore(concurrency)
        self.rpm = rpm
        self.starts: deque[float] = deque()
        self.lock = asyncio.Lock()

    async def wait_rate(self) -> None:
        while True:
            async with self.lock:
                now = time.monotonic()
                while self.starts and self.starts[0] <= now - 60:
                    self.starts.popleft()
                if len(self.starts) < self.rpm:
                    self.starts.append(now)
                    return
                delay = self.starts[0] + 60 - now
            await asyncio.sleep(delay)


_providers: WeakKeyDictionary[asyncio.AbstractEventLoop, ProviderGate] = WeakKeyDictionary()


@asynccontextmanager
async def provider_slot():
    loop = asyncio.get_running_loop()
    if loop not in _providers:
        config = load()
        _providers[loop] = ProviderGate(config.provider_concurrency // config.deployment_workers,
                                       config.provider_rpm // config.deployment_workers)
    gate = _providers[loop]
    async with gate.semaphore:
        await gate.wait_rate()
        with telemetry.inflight.track_inprogress():
            yield


async def admit_run(api=None) -> None:
    if load().maintenance:
        raise DocumentProcessingError(503, "Service is draining for maintenance", "MAINTENANCE")
    try:
        busy = await (api or get_client(url=None, api_key=None)).threads.count(status="busy")
    except Exception as exc:
        raise DocumentProcessingError(503, "Queue capacity is unavailable", "ADMISSION_UNAVAILABLE") from exc
    if busy >= load().max_busy_threads:
        raise DocumentProcessingError(503, "Document queue is full; retry later", "QUEUE_FULL")
