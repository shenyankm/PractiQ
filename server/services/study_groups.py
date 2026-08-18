"""Study group service: organization-tier study groups with members and linked banks."""

from psycopg_pool import AsyncConnectionPool

from .. import envelope
from ..auth.runtime import User
from . import analytics, helpers
from .users import require_organization_entitlement

GROUP_COLUMNS = 'id, name, description, created_by, created_at, updated_at'


def _scan_group(row: tuple) -> dict:
    return {
        'id': row[0],
        'name': row[1],
        'description': row[2],
        'createdBy': row[3],
        'createdAt': helpers.format_timestamp(row[4]),
        'updatedAt': helpers.format_timestamp(row[5]),
    }


async def _member_role(conn, group_id: int, user_id: int) -> str | None:
    cursor = await conn.execute(
        'SELECT m.role FROM study_group_members m WHERE m.group_id = %s AND m.user_id = %s LIMIT 1',
        (group_id, user_id),
    )
    row = await cursor.fetchone()
    return row[0] if row is not None else None


async def _require_group_member(conn, user: User, group_id: int) -> str:
    role = await _member_role(conn, group_id, user.id)
    if role is None:
        raise envelope.new_error(404, 'STUDY_GROUP_NOT_FOUND', 'Study group not found')
    return role


async def _require_group_owner(conn, user: User, group_id: int) -> None:
    role = await _member_role(conn, group_id, user.id)
    if role is None:
        raise envelope.new_error(404, 'STUDY_GROUP_NOT_FOUND', 'Study group not found')
    if role != 'owner':
        raise envelope.new_error(403, 'FORBIDDEN', 'Study group owner access required')
    await require_organization_entitlement(conn, user, 'Study group management')


async def create_group(pool: AsyncConnectionPool, user: User, name: str, description: str | None) -> dict:
    async with pool.connection() as conn:
        await require_organization_entitlement(conn, user, 'Study groups')
        async with conn.transaction():
            cursor = await conn.execute(
                f"""
                INSERT INTO study_groups (name, description, created_by)
                VALUES (%s, %s, %s)
                RETURNING {GROUP_COLUMNS}
                """,
                (name.strip(), description, user.id),
            )
            row = await cursor.fetchone()
            if row is None:
                raise RuntimeError('Study group creation returned no row')
            created = _scan_group(row)
            await conn.execute(
                "INSERT INTO study_group_members (group_id, user_id, role) VALUES (%s, %s, 'owner')",
                (created['id'], user.id),
            )
    return created


async def list_my_groups(pool: AsyncConnectionPool, user: User) -> list[dict]:
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT
                g.id, g.name, g.description, g.created_by, g.created_at, g.updated_at,
                m.role,
                (SELECT COUNT(*)::int FROM study_group_members cm WHERE cm.group_id = g.id) AS member_count,
                (SELECT COUNT(*)::int FROM study_group_banks cb WHERE cb.group_id = g.id) AS bank_count
            FROM study_groups g
            JOIN study_group_members m ON m.group_id = g.id AND m.user_id = %s
            ORDER BY g.created_at DESC, g.id DESC
            """,
            (user.id,),
        )
        groups = []
        for row in await cursor.fetchall():
            group = _scan_group(row)
            group['role'] = row[6]
            group['memberCount'] = row[7]
            group['bankCount'] = row[8]
            groups.append(group)
    return groups


async def get_group(pool: AsyncConnectionPool, user: User, group_id: int) -> dict:
    async with pool.connection() as conn:
        role = await _require_group_member(conn, user, group_id)
        cursor = await conn.execute(
            f'SELECT {GROUP_COLUMNS} FROM study_groups WHERE id = %s LIMIT 1',
            (group_id,),
        )
        row = await cursor.fetchone()
        if row is None:
            raise envelope.new_error(404, 'STUDY_GROUP_NOT_FOUND', 'Study group not found')
        group = _scan_group(row)
        group['role'] = role
        cursor = await conn.execute(
            """
            SELECT m.user_id, u.username, m.role, m.joined_at
            FROM study_group_members m
            JOIN users u ON u.id = m.user_id
            WHERE m.group_id = %s
            ORDER BY m.joined_at, m.id
            """,
            (group_id,),
        )
        group['members'] = [
            {
                'userId': member[0],
                'username': member[1],
                'role': member[2],
                'joinedAt': helpers.format_timestamp(member[3]),
            }
            for member in await cursor.fetchall()
        ]
        cursor = await conn.execute(
            """
            SELECT b.id, b.name, b.subject, sb.linked_at
            FROM study_group_banks sb
            JOIN question_banks b ON b.id = sb.bank_id
            WHERE sb.group_id = %s
            ORDER BY sb.linked_at, sb.id
            """,
            (group_id,),
        )
        group['banks'] = [
            {
                'bankId': bank[0],
                'name': bank[1],
                'subject': bank[2],
                'linkedAt': helpers.format_timestamp(bank[3]),
            }
            for bank in await cursor.fetchall()
        ]
    return group


async def update_group(
    pool: AsyncConnectionPool, user: User, group_id: int, name: str | None, description: str | None
) -> dict:
    if name is None and description is None:
        raise envelope.validation_error(
            [envelope.ValidationDetail('body', 'must include a field to update')]
        )
    async with pool.connection() as conn:
        await _require_group_owner(conn, user, group_id)
        cursor = await conn.execute(
            f"""
            UPDATE study_groups
            SET name = COALESCE(%s, name),
                description = COALESCE(%s, description)
            WHERE id = %s
            RETURNING {GROUP_COLUMNS}
            """,
            (name, description, group_id),
        )
        row = await cursor.fetchone()
        if row is None:
            raise envelope.new_error(404, 'STUDY_GROUP_NOT_FOUND', 'Study group not found')
        return _scan_group(row)


async def delete_group(pool: AsyncConnectionPool, user: User, group_id: int) -> None:
    async with pool.connection() as conn:
        await _require_group_owner(conn, user, group_id)
        await conn.execute('DELETE FROM study_groups WHERE id = %s', (group_id,))


async def add_member(pool: AsyncConnectionPool, user: User, group_id: int, username: str) -> dict:
    async with pool.connection() as conn:
        await _require_group_owner(conn, user, group_id)
        cursor = await conn.execute(
            'SELECT id, username FROM users WHERE lower(username) = lower(%s) AND is_active = true LIMIT 1',
            (username.strip(),),
        )
        row = await cursor.fetchone()
        if row is None:
            raise envelope.new_error(404, 'MEMBER_NOT_FOUND', 'User not found or not active')
        member_user_id, member_username = row[0], row[1]
        cursor = await conn.execute(
            """
            INSERT INTO study_group_members (group_id, user_id, role)
            VALUES (%s, %s, 'member')
            ON CONFLICT (group_id, user_id) DO NOTHING
            RETURNING joined_at
            """,
            (group_id, member_user_id),
        )
        inserted = await cursor.fetchone()
        if inserted is None:
            raise envelope.new_error(409, 'MEMBER_CONFLICT', 'User is already a member of this group')
    return {
        'userId': member_user_id,
        'username': member_username,
        'role': 'member',
        'joinedAt': helpers.format_timestamp(inserted[0]),
    }


async def _get_member_user(conn, group_id: int, member_user_id: int) -> tuple | None:
    cursor = await conn.execute(
        """
        SELECT u.id, u.username, u.email, u.is_active, u.role, u.membership, u.trial_ends_at, m.role
        FROM study_group_members m
        JOIN users u ON u.id = m.user_id
        WHERE m.group_id = %s AND m.user_id = %s
        LIMIT 1
        """,
        (group_id, member_user_id),
    )
    return await cursor.fetchone()


async def remove_member(pool: AsyncConnectionPool, user: User, group_id: int, member_user_id: int) -> None:
    async with pool.connection() as conn:
        await _require_group_owner(conn, user, group_id)
        row = await _get_member_user(conn, group_id, member_user_id)
        if row is None:
            raise envelope.new_error(404, 'MEMBER_NOT_FOUND', 'Member not found')
        if row[7] == 'owner':
            raise envelope.new_error(409, 'CANNOT_REMOVE_OWNER', 'The group owner cannot be removed')
        await conn.execute(
            'DELETE FROM study_group_members WHERE group_id = %s AND user_id = %s',
            (group_id, member_user_id),
        )


async def link_bank(pool: AsyncConnectionPool, user: User, group_id: int, bank_id: int) -> dict:
    async with pool.connection() as conn:
        await _require_group_owner(conn, user, group_id)
        cursor = await conn.execute(
            """
            SELECT ubl.bank_id
            FROM user_bank_links ubl
            WHERE ubl.bank_id = %s AND ubl.user_id = %s AND ubl.is_owner = true
            LIMIT 1
            """,
            (bank_id, user.id),
        )
        if await cursor.fetchone() is None:
            raise envelope.new_error(403, 'BANK_NOT_OWNED', 'You can only link banks you own')
        cursor = await conn.execute(
            """
            INSERT INTO study_group_banks (group_id, bank_id, linked_by)
            VALUES (%s, %s, %s)
            ON CONFLICT (group_id, bank_id) DO NOTHING
            RETURNING linked_at
            """,
            (group_id, bank_id, user.id),
        )
        inserted = await cursor.fetchone()
        if inserted is None:
            raise envelope.new_error(409, 'BANK_LINK_CONFLICT', 'Bank is already linked to this group')
    return {
        'groupId': group_id,
        'bankId': bank_id,
        'linkedAt': helpers.format_timestamp(inserted[0]),
    }


async def unlink_bank(pool: AsyncConnectionPool, user: User, group_id: int, bank_id: int) -> None:
    async with pool.connection() as conn:
        await _require_group_owner(conn, user, group_id)
        result = await conn.execute(
            'DELETE FROM study_group_banks WHERE group_id = %s AND bank_id = %s',
            (group_id, bank_id),
        )
        if result.rowcount != 1:
            raise envelope.new_error(404, 'BANK_LINK_NOT_FOUND', 'Bank is not linked to this group')


async def get_member_stats(pool: AsyncConnectionPool, user: User, group_id: int, member_user_id: int) -> dict:
    async with pool.connection() as conn:
        await _require_group_owner(conn, user, group_id)
        row = await _get_member_user(conn, group_id, member_user_id)
    if row is None:
        raise envelope.new_error(404, 'MEMBER_NOT_FOUND', 'Member not found')
    member = User(
        id=row[0], username=row[1], email=row[2], is_active=row[3], role=row[4],
        membership=row[5], trial_ends_at=row[6],
    )
    return await analytics.get_user_stats_snapshot(pool, member)
