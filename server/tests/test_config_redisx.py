"""Config + redisx + pagination + imports_queue unit tests.

Mirrors config_test.go / redisx_test.go / pagination_test.go / imports_test.go.
"""

from __future__ import annotations

import base64

import fakeredis.aioredis
import pytest

from server import config, envelope, redisx
from server.services.pagination import build_page, clamp_positive, parse_page_cursor
from server import imports_queue


# ------------------------------------------------------------------ config


def test_session_ttl_default(monkeypatch):
    monkeypatch.delenv('SESSION_TTL_MS', raising=False)
    assert config.session_ttl_seconds() == 7 * 24 * 3600


def test_session_ttl_from_env(monkeypatch):
    monkeypatch.setenv('SESSION_TTL_MS', '120000')
    assert config.session_ttl_seconds() == 120


def test_session_ttl_invalid(monkeypatch):
    monkeypatch.setenv('SESSION_TTL_MS', 'not-a-number')
    with pytest.raises(ValueError):
        config.session_ttl_seconds()
    monkeypatch.setenv('SESSION_TTL_MS', '-5')
    with pytest.raises(ValueError):
        config.session_ttl_seconds()


def test_load_requires_auth_secret(monkeypatch):
    monkeypatch.delenv('AUTH_SECRET', raising=False)
    monkeypatch.setattr(config, '_dotenv_paths', lambda name: [])
    with pytest.raises(ValueError, match='AUTH_SECRET'):
        config.load()


def test_load_defaults(monkeypatch):
    monkeypatch.setenv('AUTH_SECRET', 'secret')
    monkeypatch.delenv('PORT', raising=False)
    monkeypatch.delenv('PRACTIQ_HOST', raising=False)
    monkeypatch.delenv('APP_ORIGIN', raising=False)
    monkeypatch.delenv('SESSION_TTL_MS', raising=False)
    monkeypatch.setattr(config, '_dotenv_paths', lambda name: [])
    cfg = config.load()
    assert cfg.port == 8080
    assert cfg.host == '127.0.0.1'
    assert cfg.node_env == 'development'
    assert cfg.app_origin == 'http://127.0.0.1:8080'


def test_load_db_config_requires_url(monkeypatch):
    monkeypatch.delenv('POSTGRES_URL', raising=False)
    with pytest.raises(ValueError, match='POSTGRES_URL'):
        config.load_db_config()


def test_load_db_config_defaults(monkeypatch):
    monkeypatch.setenv('POSTGRES_URL', 'postgres://localhost/practiq')
    monkeypatch.delenv('POSTGRES_POOL_MAX', raising=False)
    cfg = config.load_db_config()
    assert cfg.max_conns == 8
    assert cfg.idle_timeout_seconds == 30
    assert cfg.connect_timeout_seconds == 10


# ------------------------------------------------------------------ redisx


def test_redis_key_prefix(monkeypatch):
    monkeypatch.delenv('REDIS_KEY_PREFIX', raising=False)
    assert redisx.redis_key('cache', 'user', 7) == 'practiq:cache:user:7'
    monkeypatch.setenv('REDIS_KEY_PREFIX', 'custom')
    assert redisx.redis_key('cache', None, '', 'user') == 'custom:cache:user'


async def test_increment_rate_limit(monkeypatch):
    fake = fakeredis.aioredis.FakeRedis()
    result = await redisx.increment_rate_limit(fake, 'k', 2, 60)
    assert result.allowed and result.count == 1 and result.remaining == 1
    result = await redisx.increment_rate_limit(fake, 'k', 2, 60)
    assert result.allowed and result.count == 2
    result = await redisx.increment_rate_limit(fake, 'k', 2, 60)
    assert not result.allowed and result.count == 3
    assert result.reset_seconds >= 1


async def test_set_get_json_roundtrip():
    fake = fakeredis.aioredis.FakeRedis()
    assert await redisx.set_json(fake, 'k', {'a': 1}, 60)
    assert await redisx.get_json(fake, 'k') == {'a': 1}
    assert await redisx.get_json(fake, 'missing') is None


# --------------------------------------------------------------- pagination


def test_parse_page_cursor():
    assert parse_page_cursor('') == 0
    cursor = base64.urlsafe_b64encode(b'30').rstrip(b'=').decode()
    assert parse_page_cursor(cursor) == 30
    with pytest.raises(envelope.APIError):
        parse_page_cursor('!!!not-base64!!!')
    negative = base64.urlsafe_b64encode(b'-1').rstrip(b'=').decode()
    with pytest.raises(envelope.APIError):
        parse_page_cursor(negative)


def test_clamp_positive():
    assert clamp_positive(0, 30, 100) == 30
    assert clamp_positive(500, 30, 100) == 100
    assert clamp_positive(10, 30, 100) == 10


def test_build_page():
    page = build_page([1, 2, 3, 4], 3, 0)
    assert page.items == [1, 2, 3]
    assert page.page_info.has_more is True
    assert base64.urlsafe_b64decode(page.page_info.cursor + '=' * (-len(page.page_info.cursor) % 4)) == b'3'
    page = build_page([1, 2], 3, 0)
    assert page.page_info.has_more is False
    assert page.page_info.cursor == ''


# ------------------------------------------------------------ imports_queue


def test_retry_backoff():
    assert imports_queue.retry_backoff_seconds(0) == 1
    assert imports_queue.retry_backoff_seconds(1) == 1
    assert imports_queue.retry_backoff_seconds(2) == 2
    assert imports_queue.retry_backoff_seconds(3) == 4
