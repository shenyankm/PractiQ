from __future__ import annotations

from tempfile import SpooledTemporaryFile

from fastapi import FastAPI
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from extractors import get_upload_max_bytes
from routes import authentication_error, router

DOCUMENT_PATH = '/internal/ai/parse-document'
DOCUMENT_BODY_OVERHEAD_BYTES = 1024 * 1024
AI_JSON_BODY_MAX_BYTES = 1024 * 1024


class DocumentGuardMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(
        self,
        scope: Scope,
        receive: Receive,
        send: Send,
    ) -> None:
        path = scope.get('path', '')
        if (
            scope['type'] != 'http'
            or scope.get('method') != 'POST'
            or not path.startswith('/internal/ai/')
        ):
            await self.app(scope, receive, send)
            return

        headers = {key.lower(): value for key, value in scope['headers']}
        authorization = headers.get(b'authorization', b'').decode('latin-1')
        auth_error = authentication_error(authorization)
        if auth_error:
            await _error_response(*auth_error)(scope, receive, send)
            return

        max_body_bytes = AI_JSON_BODY_MAX_BYTES
        if path == DOCUMENT_PATH:
            max_file_bytes = get_upload_max_bytes()
            max_body_bytes = (
                ((max_file_bytes + 2) // 3) * 4 + DOCUMENT_BODY_OVERHEAD_BYTES
            )
        content_length = headers.get(b'content-length')
        if content_length:
            try:
                if int(content_length) > max_body_bytes:
                    await _error_response(413, 'Uploaded request is too large')(scope, receive, send)
                    return
            except ValueError:
                await _error_response(400, 'Invalid Content-Length header')(scope, receive, send)
                return

        with SpooledTemporaryFile(max_size=1024 * 1024) as body:
            received_bytes = 0
            while True:
                message = await receive()
                if message['type'] != 'http.request':
                    return
                chunk = message.get('body', b'')
                received_bytes += len(chunk)
                if received_bytes > max_body_bytes:
                    await _error_response(413, 'Uploaded request is too large')(
                        scope, receive, send
                    )
                    return
                body.write(chunk)
                if not message.get('more_body', False):
                    break

            body.seek(0)

            async def replay_receive() -> Message:
                chunk = body.read(1024 * 1024)
                return {
                    'type': 'http.request',
                    'body': chunk,
                    'more_body': body.tell() < received_bytes,
                }

            await self.app(scope, replay_receive, send)


def _error_response(status_code: int, detail: str) -> JSONResponse:
    headers = {'WWW-Authenticate': 'Bearer'} if status_code == 401 else None
    return JSONResponse({'detail': detail}, status_code=status_code, headers=headers)


app = FastAPI()
app.add_middleware(DocumentGuardMiddleware)
app.include_router(router)
