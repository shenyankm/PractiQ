from __future__ import annotations

import hashlib
import re
import uuid
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from psycopg import IntegrityError, OperationalError
from psycopg_pool import PoolTimeout
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .core import DB, Error, Settings, ok, pool_for


class RollbackResponse(Exception):
    def __init__(self, response):
        self.response = response


def error_response(request, status, code, message, details=None):
    return JSONResponse(
        {
            "error": {
                "code": code,
                "message": message,
                "details": details,
                "requestId": getattr(request.state, "request_id", ""),
            }
        },
        status_code=status,
    )


def create_app(settings: Settings | None = None):
    settings = settings or Settings.load()
    pool = pool_for(settings)

    @asynccontextmanager
    async def lifespan(app):
        pool.open(wait=True)
        settings.media_dir.mkdir(parents=True, exist_ok=True)
        yield
        pool.close()

    app = FastAPI(title="PractiQ Personal API", version="1.0.0", lifespan=lifespan)
    app.state.pool, app.state.settings = pool, settings
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "[::1]", "testserver"])

    @app.exception_handler(Error)
    async def business_error(request, exc):
        return error_response(request, exc.status, exc.code, exc.message)

    @app.exception_handler(RequestValidationError)
    async def validation(request, exc):
        return error_response(
            request,
            422,
            "VALIDATION_ERROR",
            "Invalid request",
            [{"field": ".".join(map(str, e["loc"])), "message": e["msg"]} for e in exc.errors()],
        )

    @app.exception_handler(IntegrityError)
    async def constraint(request, exc):
        return error_response(
            request,
            409,
            "CONSTRAINT_VIOLATION",
            "This change conflicts with related data or a business constraint",
        )

    @app.exception_handler(OperationalError)
    async def unavailable(request, exc):
        return error_response(
            request, 503, "DATABASE_UNAVAILABLE", "Database is unavailable; retry with the same request key"
        )

    @app.exception_handler(HTTPException)
    async def http_error(request, exc):
        return error_response(
            request, exc.status_code, "NOT_FOUND" if exc.status_code == 404 else "HTTP_ERROR", str(exc.detail)
        )

    @app.middleware("http")
    async def boundary(request: Request, call_next):
        request.state.request_id = str(uuid.uuid4())
        path = request.url.path
        raw = request.scope.get("raw_path", b"").decode("ascii", "replace")
        bad_path = (
            ";" in path
            or "//" in path
            or any(p in (".", "..") for p in path.split("/"))
            or any(ord(c) < 32 for c in path)
            or re.search(r"%[0-7][0-9a-f]", raw, re.IGNORECASE)
        )
        if bad_path:
            return error_response(request, 400, "INVALID_PATH", "A canonical path is required")
        write = request.method in {"POST", "PUT", "PATCH", "DELETE"}
        if write:
            supplied = request.headers.get("origin") or request.headers.get("referer")
            expected = urlsplit(settings.app_origin)
            if supplied and (urlsplit(supplied).scheme, urlsplit(supplied).netloc) != (
                expected.scheme,
                expected.netloc,
            ):
                return error_response(request, 403, "INVALID_ORIGIN", "Cross-site writes are not allowed")
            if request.headers.get("sec-fetch-site") == "cross-site":
                return error_response(request, 403, "INVALID_ORIGIN", "Cross-site writes are not allowed")
        try:
            if write and path.startswith("/api/v1/"):
                response = await coordinated(request, call_next)
            else:
                response = await call_next(request)
        except Error as exc:
            response = error_response(request, exc.status, exc.code, exc.message)
        except (OperationalError, IntegrityError, PoolTimeout):
            response = error_response(
                request, 503, "WRITE_FAILED", "Transaction did not commit; retry with the same request key"
            )
        response.headers.update(
            {
                "X-Request-ID": request.state.request_id,
                "X-Content-Type-Options": "nosniff",
                "X-Frame-Options": "DENY",
                "Referrer-Policy": "same-origin",
            }
        )
        if path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        else:
            response.headers["Content-Security-Policy"] = (
                "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'"
            )
        return response

    @asynccontextmanager
    async def write_connection():
        db = await run_in_threadpool(pool.getconn)
        try:
            yield db
        finally:
            await run_in_threadpool(pool.putconn, db)

    async def coordinated(request, call_next):
        key = request.headers.get("idempotency-key", "")
        if not key.strip() or len(key) > 128 or any(ord(c) < 32 for c in key):
            raise Error(422, "VALIDATION_ERROR", "A stable Idempotency-Key of 1–128 characters is required")
        maximum = (
            26 * 1024 * 1024
            if request.headers.get("content-type", "").startswith("multipart/form-data")
            else 1024 * 1024
        )
        chunks, length = [], 0
        async for chunk in request.stream():
            length += len(chunk)
            if length > maximum:
                raise Error(413, "REQUEST_TOO_LARGE", "Request exceeds the upload limit")
            chunks.append(chunk)
        body = b"".join(chunks)
        request._body = body
        fingerprint = hashlib.sha256()
        fingerprint.update(request.url.query.encode())
        content_type = request.headers.get("content-type", "")
        if content_type.startswith("multipart/form-data"):
            # The random multipart boundary must not change a retry's identity.
            form = await request.form(max_files=1, max_fields=10, max_part_size=maximum)
            for name, value in form.multi_items():
                if hasattr(value, "read"):
                    fingerprint.update(repr((name, value.filename, value.content_type)).encode())
                    fingerprint.update(await value.read())
                    await value.seek(0)
                else:
                    fingerprint.update(repr((name, value)).encode())
        else:
            fingerprint.update(content_type.encode())
            fingerprint.update(body)
        route = request.method + " " + request.url.path
        digest = fingerprint.digest()

        def lock(db):
            if not db.execute(
                "select pg_try_advisory_xact_lock(hashtextextended(%s,0)) acquired", (route + ":" + key,)
            ).fetchone()["acquired"]:
                raise Error(409, "REQUEST_IN_PROGRESS", "An identical request is in progress")

        async with write_connection() as db:
            with db.transaction():
                lock(db)
                db.execute(
                    "delete from request_idempotency where route=%s and idempotency_key=%s and expires_at<=now()",
                    (route, key),
                )
                db.execute(
                    "insert into request_idempotency(route,idempotency_key,request_hash) values(%s,%s,%s) on conflict do nothing",
                    (route, key, digest),
                )
                old = db.execute(
                    "select request_hash from request_idempotency where route=%s and idempotency_key=%s",
                    (route, key),
                ).fetchone()
                if bytes(old["request_hash"]) != digest:
                    raise Error(409, "IDEMPOTENCY_KEY_REUSED", "Request key was used with different content")
            # Commit admission independently, preserving the fingerprint if business work fails.
            db.commit()
            try:
                with db.transaction():
                    lock(db)
                    db.execute("set local lock_timeout='5s'")
                    old = db.execute(
                        "select * from request_idempotency where route=%s and idempotency_key=%s",
                        (route, key),
                    ).fetchone()
                    if old["response_status"] is not None:
                        return Response(
                            bytes(old["response_body"]),
                            status_code=old["response_status"],
                            media_type=old["response_type"],
                        )
                    request.state.db = db
                    response = await call_next(request)
                    data = b"".join([chunk async for chunk in response.body_iterator])
                    result = Response(data, status_code=response.status_code, headers=dict(response.headers))
                    if response.status_code >= 400:
                        raise RollbackResponse(result)
                    db.execute(
                        "update request_idempotency set response_status=%s,response_body=%s,response_type=%s where route=%s and idempotency_key=%s",
                        (response.status_code, data, response.headers.get("content-type"), route, key),
                    )
                return result
            except RollbackResponse as exc:
                return exc.response

    from . import content, media, practice, tasks

    for module in (content, practice, tasks, media):
        app.include_router(module.router)

    @app.get("/api/health")
    def health():
        return ok({"status": "ok"})

    @app.get("/api/health/live")
    def live():
        return ok({"status": "ok"})

    @app.get("/api/health/ready")
    def ready(db: DB):
        db.execute("select 1")
        return ok({"status": "ready"})

    @app.get("/api/v1/capabilities")
    def capabilities():
        return ok({"ai": bool(settings.ai_token), "uploads": True})

    @app.get("/{path:path}", include_in_schema=False)
    def frontend(path: str):
        if path == "api" or path.startswith("api/"):
            raise Error(404, "NOT_FOUND", "API endpoint not found")
        target = (settings.web_dist / path).resolve()
        if not target.is_relative_to(settings.web_dist.resolve()):
            raise Error(404, "NOT_FOUND", "File not found")
        if target.is_file():
            return FileResponse(target)
        if path and "." in path.rsplit("/", 1)[-1]:
            raise Error(404, "NOT_FOUND", "File not found")
        index = settings.web_dist / "index.html"
        if not index.exists():
            raise Error(404, "WEB_NOT_BUILT", "Build web/ first or use the Vite development server")
        return FileResponse(index)

    return app


app = create_app()
