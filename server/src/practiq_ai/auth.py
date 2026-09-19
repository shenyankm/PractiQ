"""Shared service-token authentication."""

import secrets

from fastapi import HTTPException

from .config import service_token


def authenticate(authorization: str | None) -> None:
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not secrets.compare_digest(token, service_token()):
        raise HTTPException(401, "Invalid service token")
