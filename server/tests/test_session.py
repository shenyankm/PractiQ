"""Session token tests mirroring backend/internal/auth/session_test.go."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from datetime import datetime, timedelta, timezone

import pytest

from server.auth import session as session_mod
from server.auth import runtime
from server import envelope
from tests.fakes import FakeCursor, FakePool


def _signed_token(secret: str, payload: dict, expires_at: datetime) -> str:
    header = {'alg': 'HS256', 'typ': 'JWT'}
    claims = dict(payload)
    claims['iat'] = int((expires_at - timedelta(minutes=1)).timestamp())
    claims['exp'] = int(expires_at.timestamp())

    def enc(value) -> str:
        return base64.urlsafe_b64encode(json.dumps(value, separators=(',', ':')).encode()).rstrip(b'=').decode()

    signing_input = enc(header) + '.' + enc(claims)
    signature = hmac.new(secret.encode(), signing_input.encode(), hashlib.sha256).digest()
    return signing_input + '.' + base64.urlsafe_b64encode(signature).rstrip(b'=').decode()


def _decode_jwt(token: str) -> tuple[dict, dict]:
    parts = token.split('.')
    assert len(parts) == 3

    def dec(raw: str) -> dict:
        return json.loads(base64.urlsafe_b64decode(raw + '=' * (-len(raw) % 4)))

    return dec(parts[0]), dec(parts[1])


def test_sign_session_token_payload_shape_and_default_expiry(monkeypatch):
    monkeypatch.setenv('NODE_ENV', 'test')
    monkeypatch.setenv('AUTH_SECRET', 'contract-secret')
    monkeypatch.setenv('ACCESS_TOKEN_TTL_MS', '120000')

    before = datetime.now(timezone.utc)
    token = session_mod.sign_session_token(session_mod.SessionPayload(user_id=42, expires='', session_id='session-1', jti='session-jti'))
    after = datetime.now(timezone.utc)

    header, claims = _decode_jwt(token)
    assert header['alg'] == 'HS256'
    assert claims['iss'] == session_mod.ACCESS_TOKEN_ISSUER
    assert claims['aud'] == session_mod.ACCESS_TOKEN_AUDIENCE
    assert claims['sub'] == '42'
    assert claims['sid'] == 'session-1'
    expires_at = datetime.fromtimestamp(claims['exp'], timezone.utc)
    assert before + timedelta(minutes=2) - timedelta(seconds=2) <= expires_at <= after + timedelta(minutes=2) + timedelta(seconds=2)
    assert claims['jti'] == 'session-jti'
    assert abs(claims['exp'] - expires_at.timestamp()) <= 1

    verified = session_mod.verify_session_token(token)
    assert verified.user_id == 42
    assert verified.session_id == 'session-1'


def test_session_cookie_flags(monkeypatch):
    expires = datetime(2026, 7, 15, 12, 0, 0, tzinfo=timezone.utc)
    monkeypatch.setenv('NODE_ENV', 'test')
    params = session_mod.session_cookie_params('token-value', expires)
    assert params['key'] == 'session'
    assert params['httponly'] is True
    assert params['samesite'] == 'lax'
    assert params['secure'] is False

    monkeypatch.setenv('NODE_ENV', 'production')
    params = session_mod.session_cookie_params('token-value', expires)
    assert params['secure'] is True


def test_verify_requires_configured_secret(monkeypatch):
    future = datetime.now(timezone.utc).replace(microsecond=0) + timedelta(hours=1)

    monkeypatch.setenv('AUTH_SECRET', 'configured-secret')
    token = _signed_token('configured-secret', {
        'iss': session_mod.ACCESS_TOKEN_ISSUER,
        'aud': session_mod.ACCESS_TOKEN_AUDIENCE,
        'sub': '11', 'sid': 'session-1', 'jti': 'j',
    }, future)
    payload = session_mod.verify_session_token(token)
    assert payload.user_id == 11

    monkeypatch.setenv('AUTH_SECRET', '')
    with pytest.raises(ValueError):
        session_mod.verify_session_token(token)

    monkeypatch.setenv('AUTH_SECRET', 'expected-secret')
    wrong = _signed_token('wrong-secret', {
        'iss': session_mod.ACCESS_TOKEN_ISSUER,
        'aud': session_mod.ACCESS_TOKEN_AUDIENCE,
        'sub': '23', 'sid': 'session-2',
    }, future)
    with pytest.raises(ValueError):
        session_mod.verify_session_token(wrong)


def test_sign_requires_auth_secret(monkeypatch):
    monkeypatch.setenv('AUTH_SECRET', '')
    with pytest.raises(ValueError):
        session_mod.sign_session_token(session_mod.SessionPayload(user_id=88, expires='2026-07-15T12:00:00Z', session_id='session-1'))


def test_verify_rejects_expired_malformed_and_invalid(monkeypatch):
    monkeypatch.setenv('AUTH_SECRET', 'verify-secret')
    expired_at = datetime(2026, 7, 7, 12, 0, 0, tzinfo=timezone.utc)
    expired = _signed_token('verify-secret', {
        'iss': session_mod.ACCESS_TOKEN_ISSUER,
        'aud': session_mod.ACCESS_TOKEN_AUDIENCE,
        'sub': '5', 'sid': 'session-1', 'jti': 'e',
    }, expired_at)
    with pytest.raises(ValueError):
        session_mod.verify_session_token(expired)

    with pytest.raises(ValueError):
        session_mod.verify_session_token('not-a-jwt')

    not_expired = datetime.now(timezone.utc).replace(microsecond=0) + timedelta(hours=1)
    invalid_shape = _signed_token('verify-secret', {
        'iss': session_mod.ACCESS_TOKEN_ISSUER,
        'aud': session_mod.ACCESS_TOKEN_AUDIENCE,
        'sub': 'not-an-id', 'sid': 'session-1',
    }, not_expired)
    with pytest.raises(ValueError):
        session_mod.verify_session_token(invalid_shape)


async def test_issue_session_persists_only_a_refresh_hash(monkeypatch):
    monkeypatch.setenv('AUTH_SECRET', 'issue-secret')
    pool = FakePool([('INSERT INTO auth_sessions', FakeCursor([('session-1',)]))])
    tokens = await runtime.issue_session(pool, 9)
    assert tokens.access_token != tokens.refresh_token
    assert session_mod.verify_session_token(tokens.access_token).session_id == 'session-1'
    refresh_insert = next(sql for sql, _ in pool.record if 'INSERT INTO refresh_tokens' in sql)
    assert tokens.refresh_token not in refresh_insert
    refresh_params = next(params for sql, params in pool.record if 'INSERT INTO refresh_tokens' in sql)
    assert isinstance(refresh_params[1], bytes) and len(refresh_params[1]) == 32


async def test_refresh_rotation_marks_old_token_used(monkeypatch):
    monkeypatch.setenv('AUTH_SECRET', 'rotate-secret')
    now = datetime.now(timezone.utc)
    pool = FakePool([
        ('FROM refresh_tokens AS rt', FakeCursor([(
            'old-token-id', 'session-1', 9, now + timedelta(days=90),
            now + timedelta(days=30), None, None, None,
        )])),
        ('INSERT INTO refresh_tokens', FakeCursor([('new-token-id',)])),
    ])
    tokens = await runtime.rotate_refresh_token(pool, 'old-refresh-token')
    assert tokens.refresh_token != 'old-refresh-token'
    assert any('SET used_at' in sql for sql, _ in pool.record)
    assert any('replaced_by_token_id' in sql for sql, _ in pool.record)


async def test_refresh_reuse_revokes_the_device_session(monkeypatch):
    now = datetime.now(timezone.utc)
    pool = FakePool([('FROM refresh_tokens AS rt', FakeCursor([(
        'old-token-id', 'session-1', 9, now + timedelta(days=90),
        now + timedelta(days=30), now, None, None,
    )]))])
    with pytest.raises(envelope.APIError) as exc_info:
        await runtime.rotate_refresh_token(pool, 'replayed-token')
    assert exc_info.value.code == 'REFRESH_TOKEN_REUSE'
    assert any('refresh_token_reuse' in sql for sql, _ in pool.record)
