"""Offset cursor pagination. Mirrors backend/internal/services/pagination.go."""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
from typing import Any, Generic, TypeVar

from .. import envelope

T = TypeVar('T')


@dataclass
class PageInfo:
    cursor: str
    limit: int
    has_more: bool

    def as_meta(self) -> dict[str, Any]:
        return {
            'pagination': {
                'cursor': self.cursor,
                'limit': self.limit,
                'hasMore': self.has_more,
            }
        }


@dataclass
class Page(Generic[T]):
    items: list[T] = field(default_factory=list)
    page_info: PageInfo = field(default_factory=lambda: PageInfo('', 0, False))


def parse_page_cursor(value: str) -> int:
    if not value.strip():
        return 0
    invalid = envelope.validation_error([envelope.ValidationDetail('cursor', 'is invalid')])
    try:
        decoded = base64.urlsafe_b64decode(value + '=' * (-len(value) % 4)).decode()
        offset = int(decoded)
    except Exception as exc:
        raise invalid from exc
    if offset < 0:
        raise invalid
    return offset


def clamp_positive(value: int, fallback: int, maximum: int) -> int:
    if value <= 0:
        value = fallback
    return min(value, maximum)


def build_page(items: list[T], limit: int, offset: int) -> Page[T]:
    has_more = len(items) > limit
    if has_more:
        items = items[:limit]
    next_cursor = ''
    if has_more:
        # ponytail: opaque offset cursors are enough at the current 100-row page cap;
        # switch to per-query keysets if deep paging becomes measurable.
        next_cursor = base64.urlsafe_b64encode(str(offset + limit).encode()).rstrip(b'=').decode()
    return Page(items=items, page_info=PageInfo(cursor=next_cursor, limit=limit, has_more=has_more))
