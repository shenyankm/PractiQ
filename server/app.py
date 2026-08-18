"""FastAPI application assembly."""

import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from psycopg_pool import AsyncConnectionPool

from . import config, db as db_mod, envelope, middleware
from .routes import ai, auth, billing, content, health, imports, media, not_found, practice, reference, study_groups


def create_app(
    cfg: config.Config | None = None,
    pool: AsyncConnectionPool | None = None,
) -> FastAPI:
    if cfg is None:
        cfg = config.load()
    if pool is None:
        pool = db_mod.open_pool()
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await pool.open()
        yield
        await db_mod.close_pool()

    app = FastAPI(lifespan=lifespan)
    app.state.pool = pool
    app.state.started_at = time.time()
    app.state.config = cfg

    @app.exception_handler(envelope.APIError)
    async def api_error_handler(request: Request, exc: envelope.APIError):
        return envelope.error_response(request, exc)

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(request: Request, exc: RequestValidationError):
        errors = exc.errors()
        invalid_json_types = {'extra_forbidden', 'json_invalid', 'model_attributes_type'}
        missing_body = any(
            error['type'] == 'missing' and tuple(error['loc']) == ('body',)
            for error in errors
        )
        if missing_body or any(error['type'] in invalid_json_types for error in errors):
            return envelope.error_response(request, envelope.invalid_json())

        def field_name(error: dict) -> str:
            parts = []
            for part in error['loc']:
                if part == 'body':
                    continue
                if isinstance(part, str) and '_' in part:
                    head, *tail = part.split('_')
                    part = head + ''.join(value.capitalize() for value in tail)
                parts.append(str(part))
            return '.'.join(parts)

        details = [
            {'field': field_name(error), 'message': error['msg']}
            for error in errors
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

    # Middleware order (outermost added last): SecurityHeaders -> RequestID ->
    # RequestLog -> RateLimit -> SameOriginProtection -> Idempotency -> JSON body limit.
    app.add_middleware(middleware.JsonBodyLimitMiddleware)
    app.add_middleware(middleware.IdempotencyMiddleware)
    app.add_middleware(middleware.SameOriginProtectionMiddleware, app_origin=cfg.app_origin)
    app.add_middleware(middleware.RateLimitMiddleware)
    app.add_middleware(middleware.RequestLogMiddleware)
    app.add_middleware(middleware.RequestIDMiddleware)
    app.add_middleware(middleware.SecurityHeadersMiddleware, node_env=cfg.node_env)

    app.include_router(health.router)
    app.include_router(auth.router)
    app.include_router(billing.router)
    app.include_router(reference.router)
    app.include_router(media.router)
    app.include_router(content.router)
    app.include_router(imports.router)
    app.include_router(ai.router)
    app.include_router(practice.router)
    app.include_router(study_groups.router)
    app.include_router(not_found.router)  # catch-all last
    return app
