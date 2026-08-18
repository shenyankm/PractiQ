
import time

from fastapi import APIRouter, Request

from .. import db as db_mod
from .. import envelope, redisx

router = APIRouter()


async def _readiness_data(request: Request) -> dict:
    started = time.time()
    postgres_err = None
    try:
        await db_mod.check_postgres(request.app.state.pool)
    except Exception as exc:
        postgres_err = exc
    postgres_latency = (time.time() - started) * 1000

    started = time.time()
    redis_configured, redis_err = await redisx.check_redis()
    redis_latency = (time.time() - started) * 1000

    uptime = int(time.time() - request.app.state.started_at)
    return {
        'ok': postgres_err is None and redis_configured and redis_err is None,
        'uptimeSeconds': uptime,
        'latencyMs': max(postgres_latency, redis_latency),
        'services': {
            'postgres': {'ok': postgres_err is None, 'latencyMs': postgres_latency},
            'redis': {
                'configured': redis_configured,
                'ok': redis_err is None,
                'latencyMs': redis_latency,
            },
        },
    }


@router.get('/api/health')
async def health(request: Request):
    response = envelope.ok(request, await _readiness_data(request))
    response.headers['Cache-Control'] = 'no-store'
    return response


@router.get('/api/health/ready')
async def health_ready(request: Request):
    data = await _readiness_data(request)
    response = envelope.envelope(request, 200 if data['ok'] else 503, data)
    response.headers['Cache-Control'] = 'no-store'
    return response


@router.get('/api/health/live')
async def health_live(request: Request):
    uptime = int(time.time() - request.app.state.started_at)
    response = envelope.ok(request, {'ok': True, 'uptimeSeconds': uptime})
    response.headers['Cache-Control'] = 'no-store'
    return response
