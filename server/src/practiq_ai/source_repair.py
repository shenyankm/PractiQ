"""Explicit, fenced repair of a retained task's immutable source object."""

import hashlib
import json
import os
import stat
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from .config import load
from .contracts import OFFICE_SOURCE_TYPES, DocumentParseInput, DocumentReference
from .database import Database
from .errors import DocumentProcessingError
from .execution import require_supported_task
from .extractors.isolated import _thread_io
from .manage import exclusive
from .storage import ObjectStore, get_object_store, validate_source_size


def _replacement(path: Path, reference: DocumentReference) -> bytes:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if path.is_symlink() or not stat.S_ISREG(info.st_mode) or info.st_size != reference.sizeBytes:
            raise ValueError('Replacement must be a regular file with the retained source size')
        payload = stream.read(reference.sizeBytes + 1)
    if len(payload) != reference.sizeBytes or hashlib.sha256(payload).hexdigest() != reference.sha256:
        raise ValueError('Replacement does not match the retained source checksum')
    if reference.sourceType in OFFICE_SOURCE_TYPES:
        ObjectStore._validate_office(payload, reference.sourceType)
    return payload


def _repair(store: ObjectStore, reference: DocumentReference, payload: bytes, thread_id: str) -> tuple[str, dict[str, Any]]:
    original = store._path(reference.objectKey)
    if os.name == 'posix':
        owner = original
        while owner != store.root and not owner.exists():
            owner = owner.parent
        if os.geteuid() != owner.stat().st_uid:
            raise PermissionError('Run source repair as the original service/file owner; repair never changes ownership')
    key = f'.quarantine/source-repair/{uuid4()}'
    for directory in ('.quarantine', '.quarantine/source-repair', key):
        store._path(directory).mkdir(mode=0o700, exist_ok=True)
    preserved = None
    try:
        descriptor = os.open(original, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    except FileNotFoundError:
        pass
    else:
        with os.fdopen(descriptor, 'rb') as reader:
            before = os.fstat(reader.fileno())
            if not stat.S_ISREG(before.st_mode):
                raise ValueError('Stored source must be a regular file')
            digest, size = hashlib.sha256(), 0
            with store._path(f'{key}/original').open('xb') as writer:
                os.fchmod(writer.fileno(), 0o600)
                while chunk := reader.read(1024 * 1024):
                    writer.write(chunk)
                    digest.update(chunk)
                    size += len(chunk)
                writer.flush()
                os.fsync(writer.fileno())
            for current in (original.stat(), os.fstat(reader.fileno())):
                if any(getattr(current, field) != getattr(before, field)
                       for field in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')):
                    raise RuntimeError('Stored source changed during preservation; stop every writer')
            preserved = {'sizeBytes': size, 'sha256': digest.hexdigest(), 'file': 'original'}
    manifest = {'version': 1, 'threadId': thread_id, 'document': reference.model_dump(mode='json'),
                'original': preserved, 'completed': False}
    # Publishing this fsynced manifest also persists the original and directory entries.
    store._write(f'{key}/manifest.json', json.dumps(manifest).encode())
    store._write(reference.objectKey, payload)
    return key, manifest


async def source_operation(db: Database, thread_id: str, replacement: Path | None = None) -> dict[str, Any]:
    """Verify or explicitly repair only the source referenced by a retained task."""
    if not load().maintenance:
        raise RuntimeError('Source maintenance requires AI_MAINTENANCE_MODE=true and stopped writers')
    if str(UUID(thread_id)) != thread_id:
        raise ValueError('A canonical task UUID is required')
    async with exclusive(db):
        await db.check_schema()
        rows = await db.rows('SELECT graph_id,document FROM document_tasks WHERE thread_id=%s', (thread_id,))
        if not rows:
            raise ValueError('Retained task was not found')
        require_supported_task(rows[0])
        reference = DocumentParseInput(document=rows[0]['document']).document
        store = get_object_store()
        if store.root.is_symlink() or not store.root.is_dir():
            raise ValueError('Source maintenance requires the existing non-symlink storage directory')
        validate_source_size(reference.sizeBytes, reference.sourceType, load())
        payload = await _thread_io(_replacement, replacement, reference) if replacement is not None else None
        result = {'threadId': thread_id, 'status': 'verified', 'errorCode': None, 'quarantine': None}
        try:
            await store.get_verified(reference)
        except DocumentProcessingError as exc:
            if exc.code not in {'DOCUMENT_CHECKSUM_MISMATCH', 'DOCUMENT_SIZE_MISMATCH', 'OBJECT_NOT_FOUND'}:
                raise
            result.update(status='missing' if exc.code == 'OBJECT_NOT_FOUND' else 'corrupt', errorCode=exc.code)
        if payload is not None and result['status'] != 'verified':
            key, manifest = await _thread_io(_repair, store, reference, payload, thread_id)
            await store.get_verified(reference)
            manifest['completed'] = True
            await _thread_io(store._write, f'{key}/manifest.json', json.dumps(manifest).encode())
            result.update(status='repaired', errorCode=None, quarantine=key)
        return result
