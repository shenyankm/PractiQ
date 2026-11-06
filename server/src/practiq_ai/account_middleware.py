"""Default-deny HTTP authorization before business handlers."""
import hmac
import re
from uuid import UUID

from fastapi import HTTPException
from fastapi.exceptions import RequestValidationError
from psycopg import Error as DatabaseError
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from . import identity as auth

PUBLIC = {'/api/auth/session', '/api/auth/login', '/api/auth/register', '/api/auth/reset-password'}


class AccountMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        path = request.url.path
        if path in {'/docs', '/redoc', '/openapi.json'}:
            return JSONResponse({'detail': 'Not found'}, 404)
        if not path.startswith('/api/'):
            return await call_next(request)
        actor_token = owner_token = None
        try:
            user = await auth.authenticate(request)
            if path not in PUBLIC and user is None:
                raise HTTPException(401, {'code': 'LOGIN_REQUIRED'})
            if request.method not in {'GET', 'HEAD', 'OPTIONS'} and not request.headers.get('authorization'):
                raw = request.cookies.get(auth.cookie_name(request), '')
                if not raw or len(raw) > 256 or not hmac.compare_digest(request.headers.get('x-csrf-token', '').encode(), auth.csrf(raw).encode()):
                    raise HTTPException(403, {'code': 'CSRF_INVALID'})
            actor_token = auth.actor.set(user)
            owner_token = auth.owner.set(user['id'] if user else None)
            admin = path.startswith('/api/admin/')
            if (admin or path == '/api/metrics') and (not user or user['role'] != 'admin'):
                raise HTTPException(403, {'code': 'ADMIN_REQUIRED'})
            if admin and path.startswith(('/api/admin/document-tasks', '/api/admin/artifacts/')):
                path = path.replace('/api/admin/', '/api/', 1)
                auth.owner.set(None)
                request.scope['path'] = path
                request.scope['raw_path'] = path.encode()
            match = re.fullmatch(r'/api/document-tasks/([^/]+)(?:/.*)?', path)
            target = match.group(1) if match else request.query_params.get('thread_id') if path == '/api/artifacts/read' else None
            if target:
                target = str(UUID(target))
                if admin:
                    rows = await auth.db().rows('SELECT owner_id FROM document_tasks WHERE thread_id=%s', (target,))
                    if not rows:
                        raise HTTPException(404, {'code': 'TASK_NOT_FOUND'})
                    auth.owner.set(rows[0]['owner_id'])
                    if not rows[0]['owner_id'] and request.method not in {'GET', 'HEAD'}:
                        raise HTTPException(409, {'code': 'HISTORICAL_OWNERSHIP_REQUIRED'})
                else:
                    await auth.require_task(target)
            if path.startswith('/api/document-tasks'):
                for key in ('answer_task_id',):
                    if reference := request.query_params.get(key):
                        await auth.require_task(reference)
                if request.method in {'POST', 'PUT'}:
                    body = await request.json()
                    if isinstance(body, dict):
                        references = [body.get('parentThreadId')]
                        answer = body.get('answerSource')
                        if isinstance(answer, dict):
                            references.append(answer.get('taskId'))
                        for reference in references:
                            if reference is not None:
                                await auth.require_task(str(UUID(str(reference))))
            response = await call_next(request)
            if admin:
                await auth.audit('admin_request', request.scope.get('raw_path', b'').decode(), {'method': request.method, 'status': response.status_code})
            response.headers['Cache-Control'] = 'no-store'
            return response
        except HTTPException as exc:
            return JSONResponse({'detail': exc.detail}, exc.status_code, headers=exc.headers)
        except ValueError:
            return JSONResponse({'detail': {'code': 'INVALID_REQUEST'}}, 422)
        except DatabaseError:
            return JSONResponse({'detail': {'code': 'AUTH_UNAVAILABLE'}}, 503)
        finally:
            if owner_token is not None:
                auth.owner.reset(owner_token)
            if actor_token is not None:
                auth.actor.reset(actor_token)


async def private_validation_error(request, exc: Exception):
    assert isinstance(exc, RequestValidationError)
    if not request.url.path.startswith(('/api/auth/', '/api/me/', '/api/admin/')):
        from fastapi.exception_handlers import request_validation_exception_handler
        return await request_validation_exception_handler(request, exc)
    # Never echo password/token values from Pydantic validation errors.
    return JSONResponse({'detail': [{'loc': list(e['loc']), 'type': e['type']} for e in exc.errors()]}, 422)
