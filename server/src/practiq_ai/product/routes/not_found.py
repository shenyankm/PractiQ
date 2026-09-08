"""Structured fallback for unknown API routes."""

from fastapi import APIRouter, Request

from .. import envelope

router = APIRouter()


@router.api_route('/api/{path:path}', methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'], include_in_schema=False)
async def api_not_found(request: Request, path: str):
    return envelope.error_response(request, envelope.new_error(404, 'NOT_FOUND', 'Endpoint not found'))
