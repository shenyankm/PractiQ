"""FastAPI application assembly. Mirrors backend/cmd/practiq-api/main.go."""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from psycopg_pool import AsyncConnectionPool

from . import config, db as db_mod, envelope, middleware
from .auth import runtime as auth_runtime
from .routes import ai, auth, content, health, imports, media, practice, reference, spa


def create_app(
    cfg: config.Config | None = None,
    pool: AsyncConnectionPool | None = None,
    dist_dir: Path | None = None,
) -> FastAPI:
    if cfg is None:
        cfg = config.load()
    if pool is None:
        pool = db_mod.open_pool()
    if dist_dir is None:
        dist_dir = Path('../frontend/dist')

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await pool.open()
        yield
        await db_mod.close_pool()

    app = FastAPI(lifespan=lifespan)
    app.state.pool = pool
    app.state.started_at = time.time()
    app.state.dist_dir = dist_dir
    app.state.config = cfg

    @app.exception_handler(envelope.APIError)
    async def api_error_handler(request: Request, exc: envelope.APIError):
        return envelope.error_response(request, exc)

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(request: Request, exc: RequestValidationError):
        details = [
            {'field': '.'.join(str(part) for part in error['loc'] if part != 'body'), 'message': error['msg']}
            for error in exc.errors()
        ]
        return envelope.error_response(
            request, envelope.new_error(422, 'VALIDATION_ERROR', 'Invalid request', details)
        )

    @app.exception_handler(Exception)
    async def unhandled_error_handler(request: Request, exc: Exception):
        logging.getLogger('practiq.http').exception(
            'unhandled error method=%s path=%s requestId=%s',
            request.method, request.url.path, envelope.request_id(request),
        )
        return envelope.error_response(request, exc)

    async def verify_spa_session(token: str) -> bool:
        try:
            user = await auth_runtime.current_user_from_request_token(token, pool)
        except Exception:
            return False
        return user is not None and user.is_active

    # Middleware order (outermost added last): SecurityHeaders -> RequestID ->
    # RequestLog -> Recovery -> RateLimit -> SameOriginProtection -> Idempotency -> SPAGuard.
    app.add_middleware(middleware.SPAGuardMiddleware, app_origin=cfg.app_origin, verify_session=verify_spa_session)
    app.add_middleware(middleware.IdempotencyMiddleware)
    app.add_middleware(middleware.SameOriginProtectionMiddleware, app_origin=cfg.app_origin)
    app.add_middleware(middleware.RateLimitMiddleware)
    app.add_middleware(middleware.RecoveryMiddleware)
    app.add_middleware(middleware.RequestLogMiddleware)
    app.add_middleware(middleware.RequestIDMiddleware)
    app.add_middleware(middleware.SecurityHeadersMiddleware, node_env=cfg.node_env)

    app.include_router(health.router)
    app.include_router(auth.router)
    app.include_router(reference.router)
    app.include_router(media.router)
    app.include_router(content.router)
    app.include_router(imports.router)
    app.include_router(ai.router)
    app.include_router(practice.router)
    app.include_router(spa.router)  # catch-all last
    return app
