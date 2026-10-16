"""One process-wide scratch budget, retained until workers/files actually close."""

import asyncio
from contextlib import asynccontextmanager
from weakref import WeakKeyDictionary

from .config import TEMPORARY_LIMIT as LIMIT
from .errors import DocumentProcessingError

WAIT_SECONDS = 30


def busy() -> DocumentProcessingError:
    return DocumentProcessingError(503, 'Temporary resources are busy; retry explicitly', 'TEMPORARY_BUSY')


class Lease:
    def __init__(self, budget: Budget, size: int):
        self.budget, self.size = budget, size

    def release(self) -> None:
        self.budget.used -= self.size
        self.size = 0
        self.budget.changed.set()


class Budget:
    def __init__(self, limit: int):
        self.limit, self.used = limit, 0
        self.changed = asyncio.Event()
        self.preparing = asyncio.Lock()

    async def acquire(self, size: int, *, timeout: float = WAIT_SECONDS) -> Lease:
        if not 0 < size <= self.limit:
            raise busy()
        try:
            async with asyncio.timeout(timeout):
                while self.used + size > self.limit:
                    self.changed.clear()
                    await self.changed.wait()
                self.used += size
                return Lease(self, size)
        except TimeoutError as exc:
            raise busy() from exc


_budgets: WeakKeyDictionary[asyncio.AbstractEventLoop, Budget] = WeakKeyDictionary()


def current() -> Budget:
    loop = asyncio.get_running_loop()
    if loop not in _budgets:
        _budgets[loop] = Budget(LIMIT)
    return _budgets[loop]


@asynccontextmanager
async def preparation(size: int):
    budget = current()
    try:
        async with asyncio.timeout(WAIT_SECONDS):
            await budget.preparing.acquire()
    except TimeoutError as exc:
        raise busy() from exc
    lease = None
    try:
        lease = await budget.acquire(size)
        yield
    finally:
        if lease:
            lease.release()
        budget.preparing.release()
