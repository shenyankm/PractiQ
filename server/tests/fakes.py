"""Shared fake DB primitives for service tests (no real database required).

FakePool/FakeConn match registered responses by SQL substring, so a single
pool can back any number of execute() calls per connection. Every call is
recorded as (sql, params) for assertions.
"""

from __future__ import annotations


class FakeCursor:
    def __init__(self, rows=(), rowcount: int | None = None):
        self.rows = list(rows)
        self.rowcount = 1 if rowcount is None else rowcount
        self._index = 0

    async def fetchone(self):
        if self._index >= len(self.rows):
            return None
        row = self.rows[self._index]
        self._index += 1
        return row

    async def fetchall(self):
        return list(self.rows)


class FakeConn:
    def __init__(self, responses=(), record=None):
        self.responses = list(responses)
        self.executed = [] if record is None else record

    async def execute(self, sql, params=None):
        self.executed.append((sql, params))
        for needle, result in self.responses:
            if needle in sql:
                if isinstance(result, Exception):
                    raise result
                if isinstance(result, FakeCursor):
                    # fresh cursor per execute: registered cursors are shared across connections
                    return FakeCursor(result.rows, result.rowcount)
                return result
        return FakeCursor()

    def transaction(self):
        return _Transaction()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _Transaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class FakePool:
    def __init__(self, responses=(), record=None):
        self.responses = responses
        self.record = [] if record is None else record

    def connection(self):
        return FakeConn(self.responses, self.record)
