"""Unauthenticated process health endpoints."""

import time

from fastapi import APIRouter, Request

from .. import envelope

router = APIRouter()


@router.get('/api/health/live')
async def live(request: Request):
    try:
        uptime = int(time.time() - request.app.state.started_at)
    except (AttributeError, TypeError, ValueError):
        uptime = 0
    response = envelope.ok(request, {'ok': True, 'uptimeSeconds': uptime})
    response.headers.update({'Cache-Control': 'no-store'})
    return response


@router.get('/api/health/ready')
async def ready(request: Request):
    response = envelope.ok(request, {'ok': True})
    response.headers.update({'Cache-Control': 'no-store'})
    return response
