"""Response envelope: {data, meta} on success, {error} on failure."""

from dataclasses import dataclass
from typing import Any

from fastapi import Request, Response
from fastapi.responses import JSONResponse

REQUEST_ID_HEADER = 'x-request-id'


@dataclass
class ValidationDetail:
    field: str
    message: str

    def as_dict(self) -> dict[str, str]:
        return {'field': self.field, 'message': self.message}


class APIError(Exception):
    def __init__(self, status: int, code: str, message: str, details: Any = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details


def new_error(status: int, code: str, message: str, details: Any = None) -> APIError:
    return APIError(status, code, message, details)


def validation_error(details: list[ValidationDetail]) -> APIError:
    return APIError(
        422, 'VALIDATION_ERROR', 'Invalid request', [d.as_dict() for d in details]
    )


def request_id(request: Request) -> str:
    return getattr(request.state, 'request_id', '') or ''


def _meta(request: Request, meta: dict[str, Any] | None) -> dict[str, Any]:
    resolved = dict(meta or {})
    rid = request_id(request)
    if rid:
        resolved['requestId'] = rid
    return resolved


def envelope(request: Request, status: int, data: Any, meta: dict[str, Any] | None = None) -> JSONResponse:
    resolved_meta = _meta(request, meta)
    body: dict[str, Any] = {'data': data}
    if resolved_meta:
        body['meta'] = resolved_meta
    headers = {}
    rid = request_id(request)
    if rid:
        headers[REQUEST_ID_HEADER] = rid
    return JSONResponse(body, status_code=status, headers=headers)


def ok(request: Request, data: Any, meta: dict[str, Any] | None = None) -> JSONResponse:
    return envelope(request, 200, data, meta)


def created(request: Request, data: Any, meta: dict[str, Any] | None = None) -> JSONResponse:
    return envelope(request, 201, data, meta)


def no_content(request: Request) -> Response:
    headers = {}
    rid = request_id(request)
    if rid:
        headers[REQUEST_ID_HEADER] = rid
    return Response(status_code=204, headers=headers)


def error_response(request: Request, err: Exception) -> JSONResponse:
    if isinstance(err, APIError):
        api_err = err
    else:
        api_err = APIError(500, 'INTERNAL_ERROR', 'Unexpected server error')
    error_body: dict[str, Any] = {'code': api_err.code, 'message': api_err.message}
    if api_err.details is not None:
        error_body['details'] = api_err.details
    rid = request_id(request)
    if rid:
        error_body['requestId'] = rid
    headers = {REQUEST_ID_HEADER: rid} if rid else {}
    return JSONResponse({'error': error_body}, status_code=api_err.status, headers=headers)


def request_too_large() -> APIError:
    return APIError(413, 'REQUEST_TOO_LARGE', 'Request body is too large')


def invalid_json() -> APIError:
    return APIError(400, 'INVALID_JSON', 'Request body must be valid JSON')
