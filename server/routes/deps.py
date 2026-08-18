"""Shared route dependencies and request types."""

from datetime import datetime
from typing import Annotated

from fastapi import Path, Query, Request
from psycopg_pool import AsyncConnectionPool
from pydantic import BaseModel, ConfigDict

from ..auth import runtime as auth_runtime

PositiveId = Annotated[int, Path(gt=0)]
PageLimit100 = Annotated[int | None, Query(gt=0, le=100)]
PageLimit200 = Annotated[int | None, Query(gt=0, le=200)]
UpdatedSince = Annotated[datetime | None, Query()]


def _camel_case(value: str) -> str:
    head, *tail = value.split('_')
    return head + ''.join(part.capitalize() for part in tail)


class RequestBody(BaseModel):
    model_config = ConfigDict(
        alias_generator=_camel_case,
        extra='forbid',
        populate_by_name=True,
        strict=True,
    )


def pool(request: Request) -> AsyncConnectionPool:
    return request.app.state.pool


async def current_user(request: Request) -> auth_runtime.User:
    return await auth_runtime.require_user(request, pool(request))
