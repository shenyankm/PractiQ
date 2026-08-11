"""Media asset service. Mirrors backend/internal/services/media.go."""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from pathlib import Path

from psycopg_pool import AsyncConnectionPool

from .. import envelope
from ..auth.runtime import User
from . import helpers
from .imports_upload import resolve_storage_path

MAX_MEDIA_UPLOAD_BYTES = 10 * 1024 * 1024

MEDIA_TYPES = {
    'image/gif': '.gif',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
}


def _detect_image_content_type(content: bytes) -> str:
    """Minimal sniffing equivalent to http.DetectContentType for the four image types."""
    if content.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png'
    if content.startswith(b'\xff\xd8\xff'):
        return 'image/jpeg'
    if content[:6] in (b'GIF87a', b'GIF89a'):
        return 'image/gif'
    if len(content) >= 12 and content[:4] == b'RIFF' and content[8:12] == b'WEBP':
        return 'image/webp'
    return 'application/octet-stream'


def _scan_media_asset(row: tuple) -> dict:
    return {
        'id': row[0],
        'created_by': row[1],
        'external_url': row[4],
        'content_url': f'/api/v1/media/{row[0]}/content',
        'original_name': row[5],
        'mime_type': row[6],
        'width': row[7],
        'height': row[8],
        'size_bytes': row[9],
        'duration_ms': row[10],
        'created_at': helpers.format_timestamp(row[11]),
        '_storage_path': row[2],
    }


def _public_asset(asset: dict) -> dict:
    return {key: value for key, value in asset.items() if not key.startswith('_')}


@dataclass
class UploadedMediaFile:
    name: str
    content: bytes


async def create_uploaded_media(pool: AsyncConnectionPool, user: User, file: UploadedMediaFile) -> dict:
    if not file.content:
        raise envelope.new_error(400, 'EMPTY_FILE', 'Upload file is empty')
    if len(file.content) > MAX_MEDIA_UPLOAD_BYTES:
        raise envelope.new_error(413, 'FILE_TOO_LARGE', 'Media file exceeds 10 MiB')
    name = Path(file.name.strip()).name
    if not name or len(name.encode()) > 255:
        raise envelope.new_error(400, 'INVALID_FILE_NAME', 'Media file name must be 1-255 bytes')
    mime_type = _detect_image_content_type(file.content)
    extension = MEDIA_TYPES.get(mime_type)
    if extension is None:
        raise envelope.new_error(
            400, 'UNSUPPORTED_FILE_TYPE', 'Only PNG, JPEG, GIF, and WebP images are supported'
        )
    relative_path = f'media/{user.id}/{secrets.token_hex(12)}{extension}'
    absolute_path = resolve_storage_path(relative_path)
    absolute_path.parent.mkdir(parents=True, exist_ok=True)
    absolute_path.write_bytes(file.content)
    try:
        async with pool.connection() as conn:
            cursor = await conn.execute(
                """
                INSERT INTO media_assets (created_by, storage_path, original_name, mime_type, size_bytes)
                VALUES (%s, %s, %s, %s, %s)
                RETURNING id, created_by, storage_path, storage_disk, external_url, original_name, mime_type, width, height, size_bytes, duration_ms, created_at
                """,
                (user.id, relative_path, name, mime_type, len(file.content)),
            )
            asset = _scan_media_asset(await cursor.fetchone())
    except Exception:
        absolute_path.unlink(missing_ok=True)
        raise
    return _public_asset(asset)


async def get_media_asset(pool: AsyncConnectionPool, user: User, media_id: int) -> dict:
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            WITH accessible_questions AS (
                SELECT DISTINCT item.question_id
                FROM v_bank_question_items item
                JOIN question_banks b ON b.id = item.bank_id
                LEFT JOIN user_bank_links ubl ON ubl.bank_id = b.id AND ubl.user_id = %s
                WHERE COALESCE(ubl.is_owner, false)
                   OR ((b.is_public OR ubl.id IS NOT NULL) AND item.bank_link_status = 'active' AND item.question_status = 'active')
            ),
            accessible_groups AS (
                SELECT DISTINCT bgl.group_id
                FROM bank_group_links bgl
                JOIN question_banks b ON b.id = bgl.bank_id
                LEFT JOIN user_bank_links ubl ON ubl.bank_id = b.id AND ubl.user_id = %s
                WHERE COALESCE(ubl.is_owner, false)
                   OR ((b.is_public OR ubl.id IS NOT NULL) AND bgl.status = 'active')
            )
            SELECT m.id, m.created_by, m.storage_path, m.storage_disk, m.external_url, m.original_name, m.mime_type,
                   m.width, m.height, m.size_bytes, m.duration_ms, m.created_at
            FROM media_assets m
            WHERE m.id = %s
              AND (
                m.created_by = %s
                OR %s = 'admin'
                OR EXISTS (SELECT 1 FROM question_media_links l JOIN accessible_questions q ON q.question_id = l.question_id WHERE l.media_id = m.id)
                OR EXISTS (SELECT 1 FROM question_option_media_links l JOIN question_options o ON o.id = l.option_id JOIN accessible_questions q ON q.question_id = o.question_id WHERE l.media_id = m.id)
                OR EXISTS (SELECT 1 FROM question_group_media_links l JOIN accessible_groups g ON g.group_id = l.group_id WHERE l.media_id = m.id)
                OR EXISTS (SELECT 1 FROM question_content_blocks b JOIN accessible_questions q ON q.question_id = b.question_id WHERE b.media_id = m.id)
                OR EXISTS (SELECT 1 FROM question_content_blocks b JOIN accessible_groups g ON g.group_id = b.group_id WHERE b.media_id = m.id)
                OR EXISTS (SELECT 1 FROM question_content_blocks b JOIN question_options o ON o.id = b.option_id JOIN accessible_questions q ON q.question_id = o.question_id WHERE b.media_id = m.id)
              )
            LIMIT 1
            """,
            (user.id, user.id, media_id, user.id, user.role),
        )
        row = await cursor.fetchone()
    if row is None:
        raise envelope.new_error(404, 'NOT_FOUND', 'Media asset not found')
    return _scan_media_asset(row)


async def read_media_asset_content(
    pool: AsyncConnectionPool, user: User, media_id: int
) -> tuple[dict, bytes]:
    asset = await get_media_asset(pool, user, media_id)
    absolute_path = resolve_storage_path(asset['_storage_path'])
    try:
        content = absolute_path.read_bytes()
    except FileNotFoundError as exc:
        raise envelope.new_error(404, 'MEDIA_CONTENT_NOT_FOUND', 'Media content not found') from exc
    return asset, content


async def delete_media_asset(pool: AsyncConnectionPool, user: User, media_id: int) -> None:
    helpers.require_admin_role(user)
    async with pool.connection() as conn:
        cursor = await conn.execute(
            'DELETE FROM media_assets WHERE id = %s RETURNING storage_path', (media_id,)
        )
        row = await cursor.fetchone()
    if row is None:
        raise envelope.new_error(404, 'NOT_FOUND', 'Media asset not found')
    absolute_path = resolve_storage_path(row[0])
    try:
        absolute_path.unlink()
    except FileNotFoundError:
        pass


async def ensure_media_owned(pool: AsyncConnectionPool, user: User, media_id: int) -> None:
    async with pool.connection() as conn:
        cursor = await conn.execute(
            "SELECT id FROM media_assets WHERE id = %s AND (created_by = %s OR %s = 'admin') LIMIT 1",
            (media_id, user.id, user.role),
        )
        if await cursor.fetchone() is None:
            raise envelope.new_error(403, 'FORBIDDEN', 'Media owner access required')


async def _option_question_id(conn, option_id: int) -> int:
    cursor = await conn.execute(
        'SELECT question_id FROM question_options WHERE id = %s LIMIT 1', (option_id,)
    )
    row = await cursor.fetchone()
    if row is None:
        raise envelope.new_error(404, 'NOT_FOUND', 'Option not found')
    return row[0]


def _link_sort_order(value: int | None) -> int:
    if value is None or value < 1:
        return 1
    return value


async def link_question_media(
    pool: AsyncConnectionPool, user: User, question_id: int,
    media_id: int, media_kind: str, sort_order: int | None,
) -> dict:
    from .questions import ensure_question_editable

    await ensure_question_editable(pool, user, question_id)
    await ensure_media_owned(pool, user, media_id)
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            INSERT INTO question_media_links (question_id, media_id, media_kind, sort_order)
            VALUES (%s, %s, %s, %s)
            RETURNING id, question_id, media_id, media_kind, sort_order, created_at
            """,
            (question_id, media_id, media_kind, _link_sort_order(sort_order)),
        )
        row = await cursor.fetchone()
    return {
        'id': row[0], 'question_id': row[1], 'media_id': row[2],
        'media_kind': row[3], 'sort_order': row[4],
        'created_at': helpers.format_timestamp(row[5]),
    }


async def link_group_media(
    pool: AsyncConnectionPool, user: User, group_id: int,
    media_id: int, media_kind: str, sort_order: int | None,
) -> dict:
    from .groups import ensure_group_editable

    await ensure_group_editable(pool, user, group_id)
    await ensure_media_owned(pool, user, media_id)
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            INSERT INTO question_group_media_links (group_id, media_id, media_kind, sort_order)
            VALUES (%s, %s, %s, %s)
            RETURNING id, group_id, media_id, media_kind, sort_order, created_at
            """,
            (group_id, media_id, media_kind, _link_sort_order(sort_order)),
        )
        row = await cursor.fetchone()
    return {
        'id': row[0], 'group_id': row[1], 'media_id': row[2],
        'media_kind': row[3], 'sort_order': row[4],
        'created_at': helpers.format_timestamp(row[5]),
    }


async def link_option_media(
    pool: AsyncConnectionPool, user: User, option_id: int,
    media_id: int, media_kind: str, sort_order: int | None,
) -> dict:
    from .questions import ensure_question_editable

    async with pool.connection() as conn:
        question_id = await _option_question_id(conn, option_id)
    await ensure_question_editable(pool, user, question_id)
    await ensure_media_owned(pool, user, media_id)
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            INSERT INTO question_option_media_links (option_id, media_id, media_kind, sort_order)
            VALUES (%s, %s, %s, %s)
            RETURNING id, option_id, media_id, media_kind, sort_order, created_at
            """,
            (option_id, media_id, media_kind, _link_sort_order(sort_order)),
        )
        row = await cursor.fetchone()
    return {
        'id': row[0], 'option_id': row[1], 'media_id': row[2],
        'media_kind': row[3], 'sort_order': row[4],
        'created_at': helpers.format_timestamp(row[5]),
    }


async def _delete_media_link(conn, statement: str, owner_id: int, media_id: int) -> None:
    result = await conn.execute(statement, (owner_id, media_id))
    if result.rowcount == 0:
        raise envelope.new_error(404, 'NOT_FOUND', 'Media link not found')


async def unlink_question_media(pool: AsyncConnectionPool, user: User, question_id: int, media_id: int) -> None:
    from .questions import ensure_question_editable

    await ensure_question_editable(pool, user, question_id)
    async with pool.connection() as conn:
        await _delete_media_link(
            conn, 'DELETE FROM question_media_links WHERE question_id = %s AND media_id = %s',
            question_id, media_id,
        )


async def unlink_group_media(pool: AsyncConnectionPool, user: User, group_id: int, media_id: int) -> None:
    from .groups import ensure_group_editable

    await ensure_group_editable(pool, user, group_id)
    async with pool.connection() as conn:
        await _delete_media_link(
            conn, 'DELETE FROM question_group_media_links WHERE group_id = %s AND media_id = %s',
            group_id, media_id,
        )


async def unlink_option_media(pool: AsyncConnectionPool, user: User, option_id: int, media_id: int) -> None:
    from .questions import ensure_question_editable

    async with pool.connection() as conn:
        question_id = await _option_question_id(conn, option_id)
    await ensure_question_editable(pool, user, question_id)
    async with pool.connection() as conn:
        await _delete_media_link(
            conn, 'DELETE FROM question_option_media_links WHERE option_id = %s AND media_id = %s',
            option_id, media_id,
        )
