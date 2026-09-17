from __future__ import annotations

import base64
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, Request
from psycopg import Connection
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, ConfigDict, Field


@dataclass(frozen=True)
class Settings:
    database_url: str = "postgresql://practiq:practiq@127.0.0.1:54322/practiq_personal"
    app_origin: str = "http://127.0.0.1:5173"
    media_dir: Path = Path(".local/media")
    ai_url: str = "http://127.0.0.1:8090"
    ai_token: str = ""
    web_dist: Path = Path(__file__).resolve().parents[3] / "web/dist"

    @classmethod
    def load(cls):
        return cls(
            database_url=os.getenv("DATABASE_URL", cls.database_url),
            app_origin=os.getenv("APP_ORIGIN", cls.app_origin),
            media_dir=Path(os.getenv("MEDIA_DIR", str(cls.media_dir))).resolve(),
            ai_url=os.getenv("AI_SERVICE_URL", cls.ai_url).rstrip("/"),
            ai_token=os.getenv("AI_SERVICE_TOKEN", ""),
        )


def pool_for(settings: Settings):
    return ConnectionPool(
        settings.database_url, min_size=1, max_size=10, kwargs={"row_factory": dict_row}, open=False
    )


class Error(Exception):
    def __init__(self, status: int, code: str, message: str, details=None):
        self.status, self.code, self.message = status, code, message
        self.details = details


def invalid(message: str):
    raise Error(422, "VALIDATION_ERROR", message)


def required(value: Any, message="Resource not found"):
    if value is None:
        raise Error(404, "NOT_FOUND", message)
    return value


def one(db: Connection, sql: str, args=()):
    return required(db.execute(sql, args).fetchone())


def ok(data=None, meta=None):
    result = {"data": data}
    if meta is not None:
        result["meta"] = meta
    return result


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, strict=True)


Name = Annotated[str, Field(min_length=1, max_length=100)]
Positive = Annotated[int, Field(gt=0)]


class Paging:
    def __init__(self, cursor: str = "", limit: Annotated[int, Field(ge=1, le=100)] = 30):
        self.limit = limit
        try:
            self.offset = int(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))) if cursor else 0
            if self.offset < 0:
                raise ValueError()
        except (ValueError, TypeError):
            invalid("Invalid cursor")

    def result(self, rows):
        more = len(rows) > self.limit
        cursor = base64.urlsafe_b64encode(str(self.offset + self.limit).encode()).decode().rstrip("=")
        return ok(
            rows[: self.limit],
            {"pagination": {"cursor": cursor if more else "", "limit": self.limit, "hasMore": more}},
        )


Page = Annotated[Paging, Depends()]


def connection(request: Request):
    # Writes are coordinated by middleware and share its transaction.
    if hasattr(request.state, "db"):
        yield request.state.db
    else:
        with request.app.state.pool.connection() as db:
            yield db


DB = Annotated[Connection, Depends(connection)]


def bank(db, bank_id):
    return one(db, "select * from question_banks where id=%s and deleted_at is null", (bank_id,))


def question(db, question_id):
    return one(
        db,
        "select q.* from questions q join question_banks b on b.id=q.bank_id "
        "where q.id=%s and q.deleted_at is null and b.deleted_at is null",
        (question_id,),
    )
