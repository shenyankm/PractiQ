"""Transport safeguards for the private AI service."""

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse, Response

DEFAULT_JSON_BODY_BYTES = 1 * 1024 * 1024
WEB_CONTENT_SECURITY_POLICY = ("default-src 'none'; script-src 'self'; connect-src 'self'; "
                               "img-src 'self' blob:; media-src 'self' blob:; font-src 'self'; "
                               "style-src 'self' 'unsafe-inline'; base-uri 'none'; object-src 'none'; "
                               "frame-ancestors 'none'; form-action 'self'")


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
        # Bound every task mutation; binary uploads own their streaming/body limits.
        if (scope['type'] != 'http' or scope['method'] not in {'POST', 'PUT', 'PATCH'}
                or not (scope['path'].rstrip('/') in {'/api/uploads', '/api/artifacts/read', '/api/document-tasks', '/api/subjective-grades'}
                        or scope['path'].startswith('/api/document-tasks/'))):
            await self.app(scope, receive, send)
            return
        maximum = 32 * 1024 * 1024 if scope['path'].rstrip('/') == '/api/subjective-grades' else self.maximum
        try:
            headers = dict(scope['headers'])
            if int(headers.get(b'content-length', b'0')) > maximum:
                raise _BodyTooLarge
            chunks: list[bytes] = []
            total = 0
            while True:
                message = await receive()
                if message['type'] != 'http.request':
                    async def disconnected(event=message):
                        return event

                    await self.app(scope, disconnected, send)
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
                    return await receive()
                sent = True
                return {'type': 'http.request', 'body': b''.join(chunks), 'more_body': False}

            await self.app(scope, replay_receive, send)
        except _BodyTooLarge:
            await JSONResponse(
                {'detail': {'code': 'REQUEST_TOO_LARGE', 'message': 'Request body is too large', 'params': {}}}, 413
            )(scope, receive, send)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = apply_security_headers(await call_next(request))
        # Static assets use the same-origin Web client; uploaded artifacts remain
        # under the strict API policy and are displayed only through checked blobs.
        if (request.url.path not in {'/ok', '/ready'}
                and not request.url.path.startswith('/api/')
                and request.method in {'GET', 'HEAD'}):
            response.headers['Content-Security-Policy'] = WEB_CONTENT_SECURITY_POLICY
        return response
