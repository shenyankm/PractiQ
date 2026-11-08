
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


@pytest.fixture
async def business_http(monkeypatch):
    """Isolate existing document transport tests from the new identity boundary.

    Real cookie/ownership/admission coverage lives in test_accounts; these tests
    exercise their existing substituted model/storage and HTTP failure contracts.
    """
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from practiq_ai import identity, webapp
    from practiq_ai.account_middleware import AccountMiddleware

    async def dispatch(self, request, call_next):
        return await call_next(request)
    webapp.app.middleware_stack = None
    monkeypatch.setattr(AccountMiddleware, 'dispatch', dispatch)
    monkeypatch.setattr(identity, 'require_upload', AsyncMock())
    monkeypatch.setattr(identity, 'grant', AsyncMock())
    monkeypatch.setattr(identity, 'reserve', AsyncMock())
    monkeypatch.setattr(identity, 'record_call', AsyncMock())
    monkeypatch.setattr(identity, 'release', AsyncMock())
    monkeypatch.setattr(identity, 'db', lambda: SimpleNamespace(rows=AsyncMock(return_value=[{'owned': True}])))

    yield
    webapp.app.middleware_stack = None


@pytest.fixture
def load_credentials(monkeypatch, tmp_path):
    """Capacity tests isolate login; test_monitoring checks real credential boundaries."""
    from unittest.mock import AsyncMock

    from scripts import load_test
    path = tmp_path / 'metrics-token'
    path.write_text('m' * 43)
    path.chmod(0o600)
    monkeypatch.setattr(load_test, 'login', AsyncMock())
    monkeypatch.setattr(load_test.getpass, 'getpass', lambda _: 'isolated-test-password')
    return path
