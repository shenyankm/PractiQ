
import pytest


@pytest.fixture
async def disposable_databases(monkeypatch, tmp_path):
    from practiq_ai.storage import get_object_store
    monkeypatch.setenv('AI_STORAGE_DIR', str(tmp_path / 'files'))
    get_object_store.cache_clear()
    yield
    from tests.db_support import cleanup
    await cleanup()
    get_object_store.cache_clear()
