"""Transport safeguards for the private AI service."""

import logging
import time
import uuid

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse, Response

from .extractors import get_upload_max_bytes

DEFAULT_JSON_BODY_BYTES = 1 * 1024 * 1024
AI_JSON_BODY_BYTES = 6 * get_upload_max_bytes() + DEFAULT_JSON_BODY_BYTES


class _BodyTooLarge(Exception):
    pass


def apply_security_headers(response: Response) -> Response:
    response.headers.update({
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    })
    return response


class JsonBodyLimitMiddleware:
    def __init__(self, app, maximum: int = DEFAULT_JSON_BODY_BYTES):
        self.app = app
        self.maximum = maximum

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or scope['method'] not in {'POST', 'PUT', 'PATCH'}:
            await self.app(scope, receive, send)
            return
        maximum = AI_JSON_BODY_BYTES if scope['path'].startswith('/api/v1/ai/') else self.maximum
        try:
            headers = dict(scope['headers'])
            if int(headers.get(b'content-length', b'0')) > maximum:
                raise _BodyTooLarge
            chunks: list[bytes] = []
            total = 0
            while True:
                message = await receive()
                if message['type'] != 'http.request':
                    await self.app(scope, lambda: message, send)
                    return
                chunk = message.get('body', b'')
                total += len(chunk)
                if total > maximum:
                    raise _BodyTooLarge
                chunks.append(chunk)
                if not message.get('more_body', False):
                    break

            sent = False

            async def replay_receive():
                nonlocal sent
                if sent:
                    return {'type': 'http.request', 'body': b'', 'more_body': False}
                sent = True
                return {'type': 'http.request', 'body': b''.join(chunks), 'more_body': False}

            await self.app(scope, replay_receive, send)
        except _BodyTooLarge:
            await JSONResponse(
                {'error': {'code': 'REQUEST_TOO_LARGE', 'message': 'Request body is too large'}}, 413
            )(scope, receive, send)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        return apply_security_headers(await call_next(request))


class RequestIDMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        request_id = request.headers.get('X-Request-ID', '')
        if not request_id or len(request_id) > 128:
            request_id = str(uuid.uuid4())
        request.state.request_id = request_id
        response = await call_next(request)
        response.headers.update({'X-Request-ID': request_id})
        return response


class RequestLogMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        started = time.monotonic()
        response = await call_next(request)
        logging.getLogger('practiq.ai').info(
            '%s %s %s %.3fs', request.method, request.url.path, response.status_code,
            time.monotonic() - started,
        )
        return response
