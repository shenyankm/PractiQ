"""User record + Plus entitlement. Mirrors backend/internal/services/users.go."""

from __future__ import annotations

from datetime import datetime, timezone

from .. import envelope
from ..auth.runtime import User
from . import helpers

USER_RECORD_COLUMNS = (
    'id, username, email, avatar_url, is_active, role, membership, '
    'plus_trial_ends_at, plus_expires_at, created_at, updated_at'
)


def scan_user_record(row: tuple) -> dict:
    return {
        'id': row[0],
        'username': row[1],
        'email': row[2],
        'avatar_url': row[3],
        'is_active': row[4],
        'role': row[5],
        'membership': row[6],
        'plus_trial_ends_at': helpers.format_nullable_timestamp(row[7]),
        'plus_expires_at': helpers.format_nullable_timestamp(row[8]),
        'created_at': helpers.format_timestamp(row[9]),
        'updated_at': helpers.format_timestamp(row[10]),
    }


async def require_plus_entitlement(conn, user: User, feature: str) -> None:
    cursor = await conn.execute(
        """
        SELECT username, role, membership, plus_trial_ends_at, plus_expires_at
        FROM users
        WHERE id = %s
        LIMIT 1
        """,
        (user.id,),
    )
    row = await cursor.fetchone()
    if row is None:
        raise envelope.new_error(404, 'NOT_FOUND', 'User not found')
    _, role, membership, plus_trial_ends_at, plus_expires_at = row
    now = datetime.now(timezone.utc)
    if role == 'admin':
        return
    if membership in ('plus', 'enterprise'):
        if plus_expires_at is None or plus_expires_at > now:
            return
    elif plus_trial_ends_at is not None and plus_trial_ends_at > now:
        return
    raise envelope.new_error(403, 'PLUS_REQUIRED', f'{feature} requires Plus or Enterprise membership')
