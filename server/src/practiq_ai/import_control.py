"""Durable personal-service import controls and shared Tencent admission."""

import asyncio
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any
from uuid import UUID, uuid4
from weakref import WeakKeyDictionary

from .contracts import ImportSettings, ImportSettingsSnapshot
from .errors import DocumentProcessingError

NAMESPACE = ('service', 'import_settings')
KEY = 'current'


class ImportControl:
    def __init__(self):
        self.snapshot = ImportSettingsSnapshot(revision=UUID(int=0), settings=ImportSettings())
        self.changed = asyncio.Event()
        self.write_lock = asyncio.Lock()
        self.active = 0

    async def load(self, store: Any):
        if saved := await store.aget(NAMESPACE, KEY, refresh_ttl=False):
            self.snapshot = ImportSettingsSnapshot.model_validate(saved.value)

    async def save(self, store: Any, value: ImportSettingsSnapshot) -> ImportSettingsSnapshot:
        async with self.write_lock:
            if value.revision != self.snapshot.revision:
                raise DocumentProcessingError(409, 'Import settings changed; reload before saving', 'IMPORT_SETTINGS_CONFLICT')
            saved = ImportSettingsSnapshot(revision=uuid4(), settings=value.settings)
            await store.aput(NAMESPACE, KEY, saved.model_dump(mode='json'), index=False, ttl=None)
            self.snapshot = saved
            self.changed.set()
            return saved

    @asynccontextmanager
    async def slot(self, check: Callable[[], Awaitable[None]]):
        while self.active >= self.snapshot.settings.tencentConcurrency:
            self.changed.clear()
            try:
                async with asyncio.timeout(1):
                    await self.changed.wait()
            except TimeoutError:
                await check()
        self.active += 1
        try:
            yield
        finally:
            self.active -= 1
            self.changed.set()


_defaults: WeakKeyDictionary[asyncio.AbstractEventLoop, ImportControl] = WeakKeyDictionary()


def current(runtime: Any) -> ImportControl:
    context = getattr(runtime, 'context', None)
    if isinstance(context, dict) and isinstance(context.get('importControl'), ImportControl):
        return context['importControl']
    loop = asyncio.get_running_loop()
    if loop not in _defaults:
        _defaults[loop] = ImportControl()
    return _defaults[loop]
