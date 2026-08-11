"""ASGI middleware stack mirroring backend/internal/httpserver/middleware.go.

Order (outermost first): SecurityHeaders -> RequestID -> RequestLog ->
Recovery -> RateLimit -> SameOriginProtection -> Idempotency -> SPAGuard.
"""

from __future__ import annotations

import hashlib
import logging
import time
import uuid as uuidlib
from typing import Any, Awaitable, Callable
from urllib.parse import quote, urlparse

from fastapi import Request, Response
from fastapi.responses import RedirectResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

from . import envelope, redisx

logger = logging.getLogger('practiq.http')

API_RATE_LIMIT = 300
API_RATE_LIMIT_WINDOW_SECONDS = 60
IDEMPOTENCY_TTL_SECONDS = 24 * 3600
PROTECTED_SPA_PREFIXES = ('/dashboard', '/banks', '/imports', '/practice', '/questions', '/settings', '/admin')


def content_security_policy(node_env: str) -> str:
    script_src = "script-src 'self' 'unsafe-inline'"
    if node_env == 'development':
        script_src += " 'unsafe-eval'"
    return (
        "default-src 'self'; " + script_src + "; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob: https:; font-src 'self' data:; "
        "connect-src 'self' https: http:; object-src 'none'; base-uri 'self'; "
        "form-action 'self'; frame-ancestors 'none'"
    )


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp, node_env: str):
        super().__init__(app)
        self.csp = content_security_policy(node_env)

    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers['Content-Security-Policy'] = self.csp
        response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['X-Frame-Options'] = 'DENY'
        return response


class RequestIDMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        request_id = request.headers.get('x-request-id', '')
        if not request_id.strip() or len(request_id) > 128:
            request_id = str(uuidlib.uuid4())
        request.state.request_id = request_id
        response = await call_next(request)
        response.headers['X-Request-ID'] = request_id
        return response


class RequestLogMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        started = time.time()
        response = await call_next(request)
        logger.info(
            'http request method=%s path=%s status=%s durationMs=%s requestId=%s',
            request.method,
            request.url.path,
            response.status_code,
            int((time.time() - started) * 1000),
            envelope.request_id(request),
        )
        return response


class RecoveryMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        try:
            return await call_next(request)
        except Exception:
            logger.exception(
                'panic recovered method=%s path=%s requestId=%s',
                request.method,
                request.url.path,
                envelope.request_id(request),
            )
            return envelope.error_response(
                request, envelope.new_error(500, 'INTERNAL_ERROR', 'Unexpected server error')
            )


class RateLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if not path.startswith('/api/') or path.startswith('/api/health'):
            return await call_next(request)
        rdb = redisx.client()
        if rdb is None:
            # ponytail: Redis 缺失时放行（fail-open），认证端点仍由自身 fail-closed 限流兜底
            return await call_next(request)
        address = request.client.host if request.client else 'unknown'
        try:
            result = await redisx.increment_rate_limit(
                rdb, redisx.redis_key('rate-limit', 'api', 'ip', address),
                API_RATE_LIMIT, API_RATE_LIMIT_WINDOW_SECONDS,
            )
        except Exception:
            result = None
        if result is not None and not result.allowed:
            return envelope.error_response(
                request, envelope.new_error(429, 'RATE_LIMITED', 'Too many requests')
            )
        return await call_next(request)


def _same_origin(value: str, expected: str) -> bool:
    try:
        parsed_value, parsed_expected = urlparse(value), urlparse(expected)
    except ValueError:
        return False
    return parsed_value.scheme == parsed_expected.scheme and parsed_value.netloc == parsed_expected.netloc


class SameOriginProtectionMiddleware(BaseHTTPMiddleware):
    PROTECTED_METHODS = {'POST', 'PUT', 'PATCH', 'DELETE'}

    def __init__(self, app: ASGIApp, app_origin: str):
        super().__init__(app)
        self.app_origin = app_origin

    async def dispatch(self, request: Request, call_next):
        if request.method.upper() not in self.PROTECTED_METHODS:
            return await call_next(request)
        origin = request.headers.get('origin', '')
        referer = request.headers.get('referer', '')
        if not origin and not referer:
            return await call_next(request)
        candidate = origin or referer
        if _same_origin(candidate, self.app_origin):
            return await call_next(request)
        return envelope.error_response(
            request, envelope.new_error(403, 'INVALID_ORIGIN', 'Cross-site requests are not allowed')
        )


def _session_identity(request: Request) -> str:
    cookie = request.cookies.get('session')
    if cookie:
        return cookie
    return request.headers.get('authorization', '')


class IdempotencyMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        key = request.headers.get('idempotency-key', '').strip()
        if not key or request.method == 'GET' or request.url.path.startswith('/api/v1/auth/'):
            return await call_next(request)
        if len(key) > 128 or '\r' in key or '\n' in key:
            return envelope.error_response(
                request,
                envelope.validation_error(
                    [envelope.ValidationDetail('Idempotency-Key', 'must be at most 128 characters')]
                ),
            )
        rdb = redisx.client()
        if rdb is None:
            return envelope.error_response(
                request,
                envelope.new_error(503, 'IDEMPOTENCY_UNAVAILABLE', 'Idempotent writes are temporarily unavailable'),
            )
        digest = hashlib.sha256(
            (_session_identity(request) + '\x00' + request.method + '\x00' + request.url.path + '\x00' + key).encode()
        ).hexdigest()
        cache_key = redisx.redis_key('idempotency', digest)
        cached = await redisx.get_json(rdb, cache_key)
        if cached is not None:
            return _replay_cached(cached)
        lock_key = cache_key + ':lock'
        try:
            locked = await rdb.set(lock_key, '1', nx=True, ex=30)
        except Exception:
            return envelope.error_response(
                request,
                envelope.new_error(503, 'IDEMPOTENCY_UNAVAILABLE', 'Idempotent writes are temporarily unavailable'),
            )
        if not locked:
            return envelope.error_response(
                request,
                envelope.new_error(409, 'REQUEST_IN_PROGRESS', 'An identical request is already in progress'),
            )
        try:
            response = await call_next(request)
            body = b''
            async for chunk in response.body_iterator:
                body += chunk if isinstance(chunk, bytes) else chunk.encode()
            record = {
                'status': response.status_code,
                'headers': dict(response.headers),
                'body': body.decode('utf-8', errors='replace'),
            }
            if 200 <= response.status_code < 400:
                await redisx.set_json(rdb, cache_key, record, IDEMPOTENCY_TTL_SECONDS)
            return Response(
                content=body,
                status_code=response.status_code,
                headers=dict(response.headers),
                media_type=response.media_type,
            )
        finally:
            try:
                await rdb.delete(lock_key)
            except Exception:
                pass


def _replay_cached(cached: dict[str, Any]) -> Response:
    headers = cached.get('headers') or {}
    return Response(
        content=cached.get('body', ''),
        status_code=int(cached.get('status', 200)),
        headers={k: v for k, v in headers.items() if k.lower() not in ('content-length', 'transfer-encoding')},
    )


def is_protected_spa_path(path: str) -> bool:
    for prefix in PROTECTED_SPA_PREFIXES:
        if path == prefix or path.startswith(prefix + '/'):
            return True
    return False


class SPAGuardMiddleware(BaseHTTPMiddleware):
    """Redirects unauthenticated GETs on protected SPA paths to /sign-in."""

    def __init__(self, app: ASGIApp, app_origin: str, verify_session: Callable[[str], Awaitable[bool]]):
        super().__init__(app)
        self.app_origin = app_origin
        self.verify_session = verify_session

    async def dispatch(self, request: Request, call_next):
        if request.method == 'GET' and is_protected_spa_path(request.url.path):
            token = request.cookies.get('session', '')
            valid = bool(token) and await self.verify_session(token)
            if not valid:
                redirect_target = request.url.path
                if request.url.query:
                    redirect_target += '?' + request.url.query
                target = self.app_origin.rstrip('/') + '/sign-in'
                return RedirectResponse(
                    url=f'{target}?redirect={quote(redirect_target)}', status_code=307
                )
        return await call_next(request)
