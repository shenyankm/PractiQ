"""Authentication routes."""

from typing import Self

from fastapi import APIRouter, Body, Request
from pydantic import field_validator, model_validator

from .. import envelope
from ..auth import email_code, handlers, runtime
from . import deps

router = APIRouter()


def _username(value: str) -> str:
    value = value.strip()
    if detail := handlers.username_validation_detail(value):
        raise ValueError(detail.message)
    return value


def _email(value: str) -> str:
    email, detail = handlers.normalize_email(value, True)
    if detail:
        raise ValueError(detail.message)
    return email or ''


def _password(field: str, value: str) -> str:
    if detail := handlers.password_validation_detail(field, value):
        raise ValueError(detail.message)
    return value


class RegisterBody(deps.RequestBody):
    username: str
    email: str
    password: str
    code: str = ''

    @field_validator('username')
    @classmethod
    def validate_username(cls, value: str) -> str:
        return _username(value)

    @field_validator('email')
    @classmethod
    def validate_email(cls, value: str) -> str:
        return _email(value)

    @field_validator('password')
    @classmethod
    def validate_password(cls, value: str) -> str:
        return _password('password', value)


class LoginBody(deps.RequestBody):
    login: str = ''
    password: str = ''


class UpdateProfileBody(deps.RequestBody):
    username: str | None = None
    email: str | None = None
    current_password: str | None = None
    new_password: str | None = None

    @field_validator('username')
    @classmethod
    def validate_username(cls, value: str | None) -> str | None:
        return _username(value) if value is not None else None

    @field_validator('email')
    @classmethod
    def validate_email(cls, value: str | None) -> str | None:
        return _email(value) if value is not None else None

    @field_validator('new_password')
    @classmethod
    def validate_new_password(cls, value: str | None) -> str | None:
        return _password('newPassword', value) if value is not None else None

    @model_validator(mode='after')
    def validate_update(self) -> Self:
        if self.new_password is not None and not self.current_password:
            raise ValueError('currentPassword is required to change the password')
        if (
            self.username is None
            and 'email' not in self.model_fields_set
            and self.new_password is None
        ):
            raise ValueError('username, email, or newPassword is required')
        return self

    def as_input(self) -> runtime.UpdateUserInput:
        return runtime.UpdateUserInput(
            username=self.username,
            email=self.email,
            email_set='email' in self.model_fields_set,
            current_password=self.current_password,
            new_password=self.new_password,
        )


class EmailCodeBody(deps.RequestBody):
    email: str

    @field_validator('email')
    @classmethod
    def validate_email(cls, value: str) -> str:
        return _email(value)


class RefreshBody(deps.RequestBody):
    refresh_token: str = ''


@router.post('/api/v1/auth/register')
async def register(request: Request, body: RegisterBody):
    await handlers.rate_limit_auth(request, '')
    await email_code.verify_email_code(body.email, body.code)
    user = await runtime.register_user(
        deps.pool(request), body.username, body.email, body.password
    )
    tokens = await runtime.issue_session(deps.pool(request), user.id)
    response = envelope.created(
        request, handlers.issued_session_response(user, tokens)
    )
    runtime.set_session_cookie(response, tokens.access_token, tokens.access_expires_at)
    runtime.set_refresh_cookie(
        response, tokens.refresh_token, tokens.refresh_expires_at
    )
    return response


@router.post('/api/v1/auth/login')
async def login(request: Request, body: LoginBody):
    await handlers.rate_limit_auth(request, body.login)
    user = await runtime.authenticate_user(
        deps.pool(request), body.login, body.password
    )
    tokens = await runtime.issue_session(deps.pool(request), user.id)
    response = envelope.ok(request, handlers.issued_session_response(user, tokens))
    runtime.set_session_cookie(response, tokens.access_token, tokens.access_expires_at)
    runtime.set_refresh_cookie(
        response, tokens.refresh_token, tokens.refresh_expires_at
    )
    return response


@router.post('/api/v1/auth/logout')
async def logout(request: Request):
    await runtime.revoke_session(request, deps.pool(request))
    response = envelope.no_content(request)
    runtime.clear_session_cookie(response)
    runtime.clear_refresh_cookie(response)
    return response


@router.get('/api/v1/auth/me')
async def me(request: Request):
    return envelope.ok(request, (await deps.current_user(request)).as_dict())


@router.patch('/api/v1/users/me')
async def update_me(request: Request, body: UpdateProfileBody):
    user = await deps.current_user(request)
    updated = await runtime.update_user(deps.pool(request), user.id, body.as_input())
    return envelope.ok(request, updated.as_dict())


@router.post('/api/v1/auth/email-code')
async def send_email_code(request: Request, body: EmailCodeBody):
    await handlers.rate_limit_auth(request, body.email)
    await email_code.send_code(body.email)
    return envelope.no_content(request)


@router.post('/api/v1/auth/refresh')
async def refresh(
    request: Request, body: RefreshBody | None = Body(default=None)
):
    raw_refresh = (body.refresh_token if body else '') or request.cookies.get(
        'refresh_token', ''
    )
    if not raw_refresh:
        raise envelope.new_error(
            401, 'INVALID_REFRESH_TOKEN', 'Invalid refresh token'
        )
    tokens = await runtime.rotate_refresh_token(deps.pool(request), raw_refresh)
    response = envelope.ok(
        request, {'tokens': handlers.session_tokens_response(tokens)}
    )
    runtime.set_session_cookie(response, tokens.access_token, tokens.access_expires_at)
    runtime.set_refresh_cookie(
        response, tokens.refresh_token, tokens.refresh_expires_at
    )
    return response
