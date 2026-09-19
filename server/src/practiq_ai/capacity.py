"""Per-process provider allocation and model limits."""

import asyncio
import time
from collections import deque
from contextlib import asynccontextmanager
from typing import Any
from weakref import WeakKeyDictionary

from . import telemetry
from .config import load


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
async def provider_slot(record: dict[str, Any] | None = None):
    loop = asyncio.get_running_loop()
    if loop not in _providers:
        config = load()
        _providers[loop] = ProviderGate(config.provider_concurrency // config.deployment_workers,
                                       config.provider_rpm // config.deployment_workers)
    gate = _providers[loop]
    timings = record if record is not None else {}
    with telemetry.measure("provider_concurrency_wait", timings, "concurrencyWaitMs"):
        await gate.semaphore.acquire()
    try:
        with telemetry.measure("provider_rate_wait", timings, "rateWaitMs"):
            await gate.wait_rate()
        with telemetry.inflight.track_inprogress():
            yield
    finally:
        gate.semaphore.release()
