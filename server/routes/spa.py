"""SPA static file serving + /api/ 404 fallback.

Mirrors notFoundHandler / serveStaticOrSPA in router.go + server.go.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse

from .. import envelope

router = APIRouter()


@router.api_route('/api/{path:path}', methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
async def api_not_found(request: Request, path: str):
    response = envelope.error_response(
        request, envelope.new_error(404, 'NOT_FOUND', 'Endpoint not found')
    )
    response.headers['Cache-Control'] = 'no-store'
    return response


@router.get('/{path:path}')
async def serve_spa(request: Request, path: str):
    dist_dir: Path = request.app.state.dist_dir
    cleaned = path.strip('/')
    candidate = (dist_dir / cleaned).resolve() if cleaned else dist_dir / 'index.html'
    try:
        candidate.relative_to(dist_dir.resolve())
    except ValueError:
        candidate = dist_dir / 'index.html'
    if candidate.is_file():
        return FileResponse(candidate)
    return FileResponse(dist_dir / 'index.html', media_type='text/html')
