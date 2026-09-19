
import pytest


@pytest.fixture
async def disposable_databases():
    yield
    from tests.db_support import cleanup
    await cleanup()
