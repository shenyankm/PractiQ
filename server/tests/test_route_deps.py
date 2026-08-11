"""Route helper unit tests (no database required)."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from server import envelope
from server.routes import deps


def _request(query: dict) -> SimpleNamespace:
    return SimpleNamespace(query_params=query)


def test_query_updated_since_empty():
    assert deps.query_updated_since(_request({})) == ''
    assert deps.query_updated_since(_request({'updated_since': '   '})) == ''


def test_query_updated_since_valid():
    value = '2026-08-11T03:30:02.558Z'
    assert deps.query_updated_since(_request({'updated_since': value})) == value
    offset = '2026-08-11T03:30:02+00:00'
    assert deps.query_updated_since(_request({'updated_since': offset})) == offset


def test_query_updated_since_invalid():
    with pytest.raises(envelope.APIError) as exc_info:
        deps.query_updated_since(_request({'updated_since': 'not-a-date'}))
    assert exc_info.value.status == 422
    assert exc_info.value.code == 'VALIDATION_ERROR'
