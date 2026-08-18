"""FastAPI application assembly for the internal AI service."""

import logging
import time
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError

from . import config, envelope, middleware
from .routes.ai import router as ai_router
from .routes.health import router as health_router
from .routes.not_found import router as not_found_router
from .services.ai import AIService


def create_app(cfg: config.Config | None = None, service: Any = None) -> FastAPI:
    cfg = cfg or config.load()
    app = FastAPI()
    app.state.started_at = time.time()
    app.state.config = cfg
    app.state.ai_service = service or AIService(cfg)

    @app.exception_handler(envelope.APIError)
    async def api_error_handler(request: Request, exc: envelope.APIError):
        return envelope.error_response(request, exc)

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(request: Request, exc: RequestValidationError):
        errors = exc.errors()
        missing_body = any(
            error['type'] == 'missing' and tuple(error['loc']) == ('body',)
            for error in errors
        )
        if missing_body or any(
            error['type'] in {'extra_forbidden', 'json_invalid', 'model_attributes_type'}
            for error in errors
        ):
            return envelope.error_response(request, envelope.invalid_json())
        return envelope.error_response(
            request,
            envelope.validation_error([
                envelope.ValidationDetail('.'.join(map(str, error['loc'][1:])), error['msg'])
                for error in errors
            ]),
        )

    @app.exception_handler(Exception)
    async def unhandled_error_handler(request: Request, exc: Exception):
        logging.getLogger('practiq.ai').exception('unhandled request=%s', request.url.path)
        return middleware.apply_security_headers(envelope.error_response(request, exc))

    app.add_middleware(middleware.JsonBodyLimitMiddleware)
    app.add_middleware(middleware.RequestLogMiddleware)
    app.add_middleware(middleware.RequestIDMiddleware)
    app.add_middleware(middleware.SecurityHeadersMiddleware)
    app.include_router(health_router)
    app.include_router(ai_router)
    app.include_router(not_found_router)
    return app
