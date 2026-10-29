"""Conservative estimated-cost reservations in the existing PostgreSQL Store."""

import hashlib
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any, cast

from langgraph.runtime import Runtime
from langgraph.store.base import GetOp, Item, PutOp
from langgraph.store.postgres.aio import AsyncPostgresStore

from .config import Config, load
from .database import Database
from .errors import DocumentProcessingError

NAMESPACE = ("practiq_cost_v1",)
_evaluation_database: ContextVar[Database | None] = ContextVar("cost_evaluation_database", default=None)


@asynccontextmanager
async def evaluation_database() -> AsyncIterator[Database | None]:
    if not load().cost_enabled:
        yield None
        return
    from .manage import exclusive
    db = Database()
    try:
        await db.open()
        await db.check_schema()
        async with exclusive(db):
            token = _evaluation_database.set(db)
            try:
                yield db
            finally:
                _evaluation_database.reset(token)
    finally:
        await db.close()


def now() -> datetime:
    return datetime.now(UTC)


def model_estimate(input_bytes: int, settings: Config) -> int:
    # Serialized UTF-8/Base64 bytes deliberately overestimate ordinary input tokens.
    return (input_bytes * settings.cost_input_per_million + settings.model_max_tokens * settings.cost_output_per_million + 999_999) // 1_000_000


def page_estimate(pages: int, settings: Config) -> int:
    return pages * settings.cost_tencent_per_page


def database(runtime: Runtime[Any] | None) -> Database:
    if runtime and isinstance(runtime.context, dict) and runtime.context.get("runDatabase"):
        return runtime.context["runDatabase"]
    if db := _evaluation_database.get():
        return db
    from .runtime import current
    if current is None:
        raise DocumentProcessingError(503, "Cost admission requires the running service database", "COST_STORE_REQUIRED")
    return current.db


async def reserve(scope: str | None, call_key: str, amount: int, kind: str,
                  runtime: Runtime[Any] | None = None) -> dict[str, Any] | None:
    settings = load()
    if not settings.cost_enabled:
        return None
    if not scope or type(amount) is not int or amount < 0:
        raise DocumentProcessingError(503, "Cost admission requires a durable task or grading identity", "COST_STORE_REQUIRED")
    prices = {name: getattr(settings, name) for name in ("cost_currency", "cost_input_per_million", "cost_output_per_million", "cost_tencent_per_page")}
    pricing_hash = hashlib.sha256(json.dumps(prices, sort_keys=True).encode()).hexdigest()
    keys = [f"call:{call_key}", f"scope:{scope}", f"day:{now().date().isoformat()}"]
    receipt = {"currency": settings.cost_currency, "reservedMicros": amount, "scope": scope, "kind": kind, "pricingHash": pricing_hash}
    try:
        # The existing admission lock serializes all reservations. The Store uses
        # this transaction's connection, so receipt and both totals commit together.
        async with database(runtime).transaction() as connection:
            store = AsyncPostgresStore(connection)
            previous, task, day = cast(list[Item | None], await store.abatch([GetOp(NAMESPACE, key, refresh_ttl=False) for key in keys]))
            if previous:
                if previous.value != receipt:
                    raise DocumentProcessingError(409, "Cost reservation identity changed", "COST_RESERVATION_CONFLICT")
                return previous.value
            updates = [PutOp(NAMESPACE, keys[0], receipt, index=False)]
            for key, item, limit in zip(keys[1:], (task, day), (settings.cost_task_limit, settings.cost_daily_limit), strict=True):
                if item and item.value.get("currency") != settings.cost_currency:
                    raise DocumentProcessingError(409, "Retained cost budget uses a different currency", "COST_CURRENCY_CONFLICT")
                spent = (item.value["reservedMicros"] if item else 0) + amount
                if limit is not None and spent > limit:
                    raise DocumentProcessingError(429, "Estimated cost budget exhausted; inspect reservations before explicit retry", "COST_BUDGET_EXCEEDED")
                updates.append(PutOp(NAMESPACE, key, {"currency": settings.cost_currency, "reservedMicros": spent}, index=False))
            await store.abatch(updates)
    except DocumentProcessingError:
        raise
    except Exception as exc:
        raise DocumentProcessingError(503, "Cost reservation could not be persisted", "COST_STORE_UNAVAILABLE") from exc
    return receipt
