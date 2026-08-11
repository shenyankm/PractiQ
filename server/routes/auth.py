"""Auth routes. Mirrors auth handlers + router.go auth registrations."""

from __future__ import annotations

import os

from fastapi import APIRouter, Request, Response
from fastapi.responses import RedirectResponse

from .. import envelope
from ..auth import email_code, google, handlers, runtime
from . import deps

router = APIRouter()


@router.post('/api/v1/auth/register')
async def register(request: Request):
    body = await handlers.decode_auth_request(request)
    register_body = handlers.validate_register_request(body)
    await handlers.rate_limit_auth(request, '')
    await email_code.verify_email_code(register_body.email, register_body.code)
    user = await runtime.register_user(
        deps.pool(request), register_body.username, register_body.email, register_body.password
    )
    token, expires = await runtime.issue_session(user.id)
    response = envelope.created(request, handlers.issued_session_response(user, token, expires))
    runtime.set_session_cookie(response, token, expires)
    return response


@router.post('/api/v1/auth/login')
async def login(request: Request):
    body = await handlers.decode_auth_request(request)
    login_name, password = handlers.validate_login_request(body)
    await handlers.rate_limit_auth(request, login_name)
    user = await runtime.authenticate_user(deps.pool(request), login_name, password)
    token, expires = await runtime.issue_session(user.id)
    response = envelope.ok(request, handlers.issued_session_response(user, token, expires))
    runtime.set_session_cookie(response, token, expires)
    return response


@router.post('/api/v1/auth/logout')
async def logout(request: Request):
    await runtime.revoke_session(request)
    response = envelope.no_content(request)
    runtime.clear_session_cookie(response)
    return response


@router.get('/api/v1/auth/me')
async def me(request: Request):
    user = await deps.current_user(request)
    return envelope.ok(request, user.as_dict())


@router.patch('/api/v1/users/me')
async def update_me(request: Request):
    user = await deps.current_user(request)
    body = await handlers.decode_auth_request(request)
    input = handlers.validate_update_me_request(body)
    updated = await runtime.update_user(deps.pool(request), user.id, input)
    return envelope.ok(request, updated.as_dict())


@router.post('/api/v1/auth/email-code')
async def send_email_code(request: Request):
    body = await handlers.decode_auth_request(request)
    if any(key != 'email' for key in body):
        raise envelope.invalid_json()
    email_raw = body.get('email') if isinstance(body.get('email'), str) else None
    email, detail = handlers.normalize_email(email_raw, True)
    if detail:
        raise envelope.validation_error([detail])
    await handlers.rate_limit_auth(request, email or '')
    await email_code.send_code(email or '')
    return envelope.no_content(request)


@router.get('/api/v1/auth/google/start')
async def google_start():
    url, state = google.google_start_params()
    response = RedirectResponse(url=url, status_code=302)
    google.set_state_cookie(response, state)
    return response


@router.get('/api/v1/auth/google/callback')
async def google_callback(request: Request):
    response = RedirectResponse(url=os.environ.get('APP_ORIGIN', '').strip() or '/', status_code=302)
    user = await google.google_callback(request, response, deps.pool(request))
    token, expires = await runtime.issue_session(user.id)
    runtime.set_session_cookie(response, token, expires)
    return response


@router.post('/api/v1/auth/google/token')
async def google_token(request: Request, response: Response):
    if not os.environ.get('GOOGLE_CLIENT_ID', '').strip():
        raise envelope.new_error(404, 'GOOGLE_AUTH_DISABLED', 'Google sign-in is not configured')
    body = await handlers.decode_auth_request(request)
    if any(key != 'idToken' for key in body):
        raise envelope.invalid_json()
    id_token = body.get('idToken') if isinstance(body.get('idToken'), str) else ''
    if not id_token.strip():
        raise envelope.validation_error([envelope.ValidationDetail('idToken', 'is required')])
    await handlers.rate_limit_auth(request, '')
    claims = await google.verify_google_id_token(id_token)
    user = await google.find_or_create_google_user(deps.pool(request), claims)
    token, expires = await runtime.issue_session(user.id)
    response = envelope.ok(request, handlers.issued_session_response(user, token, expires))
    runtime.set_session_cookie(response, token, expires)
    return response
