"""Offline matching service backups; restore only to a new database/file root."""

import argparse
import asyncio
import hashlib
import json
import os
import posixpath
import re
import shutil
import stat
import subprocess
import tarfile
import time
from collections.abc import Sequence
from functools import partial
from math import isfinite
from pathlib import Path, PurePosixPath
from tempfile import NamedTemporaryFile

from psycopg import Error as DatabaseError
from psycopg import pq
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from practiq_ai.config import database_uri, load
from practiq_ai.database import Database
from practiq_ai.execution import code_version, runtime_version
from practiq_ai.extractors.isolated import _thread_io
from practiq_ai.manage import exclusive


def inventory(root: Path, *, skip_manifest: bool = False) -> dict[str, dict]:
    result = {}
    if root.is_symlink() or not root.is_dir():
        raise ValueError('Backup root must be a directory, not a symlink')
    for path in sorted(root.rglob('*')):
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode):
            continue
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('Backup requires regular files without symlinks')
        key = path.relative_to(root).as_posix()
        if not skip_manifest or key != 'manifest.json':
            with path.open('rb') as stream:
                result[key] = {'size': info.st_size, 'sha256': hashlib.file_digest(stream, 'sha256').hexdigest()}
    return result


def atomic(path: Path, payload: bytes, mode: int = 0o600) -> None:
    with NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            os.fchmod(stream.fileno(), mode)
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
            stream.close()
            os.replace(temporary, path)
            if os.name != 'nt':
                descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
        finally:
            temporary.unlink(missing_ok=True)


def manifest(root: Path, *, image: str, snapshot: float) -> dict:
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', image):
        raise ValueError('An immutable Docker image ID is required')
    return {'version': 1, 'snapshotUnix': snapshot, 'image': image, 'toolCodeHash': code_version(),
            'toolRuntime': runtime_version(), 'files': inventory(root, skip_manifest=True)}


def check_image(path: Path, image: str) -> None:
    """Check docker-save metadata without extracting or loading executable contents."""
    with tarfile.open(path, 'r:') as archive:
        def read(name: str, maximum: int) -> bytes:
            entry = archive.getmember(name)
            if not entry.isfile() or not 0 < entry.size <= maximum:
                raise ValueError('Invalid image archive metadata')
            stream = archive.extractfile(entry)
            if stream is None:
                raise ValueError('Missing image archive metadata')
            with stream:
                return stream.read(maximum + 1)
        entries = json.loads(read('manifest.json', 1024 * 1024))
        if (not isinstance(entries, list) or len(entries) != 1 or not isinstance(entries[0], dict)
                or not isinstance(entries[0].get('Config'), str)):
            raise ValueError('Image archive does not match the immutable image ID')
        config_bytes = read(entries[0]['Config'], 16 * 1024 * 1024)
        config = 'sha256:' + hashlib.sha256(config_bytes).hexdigest()
        layers = entries[0].get('Layers', [])
        if not isinstance(layers, list) or any(not isinstance(name, str) for name in layers):
            raise ValueError('Invalid image layers')
        diff_ids = json.loads(config_bytes).get('rootfs', {}).get('diff_ids', [])
        if not isinstance(diff_ids, list) or len(diff_ids) != len(layers):
            raise ValueError('Invalid image layer inventory')
        for name, diff_id in zip(layers, diff_ids, strict=True):
            layer = archive.getmember(name)
            stream = archive.extractfile(layer) if layer.isfile() else None
            if stream is None:
                raise ValueError('Missing image layer')
            expected = 'sha256:' + name.removeprefix('blobs/sha256/') if name.startswith('blobs/sha256/') else diff_id
            with stream:
                checksum = hashlib.sha256()
                while chunk := stream.read(1024 * 1024):
                    checksum.update(chunk)
                if 'sha256:' + checksum.hexdigest() != expected:
                    raise ValueError('Image layer checksum does not match')
        if image == config:
            return  # Classic Docker uses the configuration digest as its image ID.
        def contains_config(digest: str, depth: int = 0) -> bool:
            if depth > 3 or re.fullmatch(r'sha256:[a-f0-9]{64}', digest) is None:
                return False
            data = read('blobs/sha256/' + digest.removeprefix('sha256:'), 1024 * 1024)
            if 'sha256:' + hashlib.sha256(data).hexdigest() != digest:
                return False
            descriptor = json.loads(data)
            if not isinstance(descriptor, dict):
                return False
            if isinstance(descriptor.get('config'), dict) and descriptor['config'].get('digest') == config:
                return [entry.get('digest') for entry in descriptor.get('layers', [])] == [
                    'sha256:' + name.removeprefix('blobs/sha256/') for name in layers]
            children = descriptor.get('manifests', [])
            return isinstance(children, list) and len(children) <= 16 and any(
                isinstance(child, dict) and contains_config(child.get('digest', ''), depth + 1) for child in children)
        # Modern containerd Docker uses an OCI index/manifest digest instead.
        index = json.loads(read('index.json', 1024 * 1024))
        if (not isinstance(index, dict) or not isinstance(index.get('manifests'), list)
                or not any(isinstance(entry, dict) and entry.get('digest') == image for entry in index['manifests'])
                or not contains_config(image)):
            raise ValueError('Image archive does not match the immutable image ID')


def verify(root: Path) -> dict:
    path = root / 'manifest.json'
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError('Invalid backup manifest')
    value = json.loads(path.read_bytes())
    if (not isinstance(value, dict) or value.get('version') != 1
            or not isinstance(value.get('snapshotUnix'), (int, float))
            or not isfinite(value['snapshotUnix']) or value['snapshotUnix'] <= 0
            or not isinstance(value.get('image'), str)
            or re.fullmatch(r'sha256:[a-f0-9]{64}', value['image']) is None
            or not isinstance(value.get('files'), dict)):
        raise ValueError('Invalid backup manifest')
    actual = inventory(root, skip_manifest=True)
    if set(actual) != set(value['files']) or not {'database.dump', 'config.env', 'image.tar'} <= set(actual) or not (root / 'files').is_dir():
        raise ValueError('Backup inventory does not match')
    if actual != value['files']:
        raise ValueError('Backup checksum does not match')
    check_image(root / 'image.tar', value['image'])
    return value


def destination(path: Path, storage: Path) -> None:
    if path.resolve().is_relative_to(storage.resolve()) or storage.resolve().is_relative_to(path.resolve()):
        raise ValueError('Backup destination must be outside storage')
    path.mkdir(mode=0o700, parents=False, exist_ok=False)


def pg_environment(uri: str) -> dict[str, str]:
    names = {option.keyword.decode(): option.envvar.decode() if option.envvar else None for option in pq.Conninfo.get_defaults()}
    environment = dict(os.environ)
    for key, value in conninfo_to_dict(uri).items():
        name = names.get(key)
        if not name:
            raise ValueError('Connection option has no libpq environment equivalent')
        environment[name] = str(value)
    return environment


def pg(tool: str, uri: str, *arguments: str) -> None:
    # Expand URI options into libpq variables; credentials never enter argv/logs.
    try:
        subprocess.run([tool, *arguments], env=pg_environment(uri),
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                       check=True, timeout=1800)
    except (OSError, subprocess.SubprocessError):
        raise RuntimeError('PostgreSQL backup/restore command failed; inspect private operator diagnostics') from None


def copy_files(source: Path, target: Path) -> None:
    before = inventory(source)
    target.mkdir(mode=0o700)
    for name in before:
        destination_file = target / name
        destination_file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with (source / name).open('rb') as reader, destination_file.open('xb') as writer:
            os.fchmod(writer.fileno(), 0o600)
            shutil.copyfileobj(reader, writer, length=1024 * 1024)
            writer.flush()
            os.fsync(writer.fileno())
    if inventory(target) != before or inventory(source) != before:
        raise ValueError('Storage changed during offline copy')
    if os.name != 'nt':
        for directory, _, _ in os.walk(target, topdown=False):
            descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)


def copy_private(source: Path, target: Path) -> None:
    if source.is_symlink() or not source.is_file():
        raise ValueError('Configuration and image snapshots must be regular files')
    with source.open('rb') as reader, target.open('xb') as writer:
        os.fchmod(writer.fileno(), 0o600)
        shutil.copyfileobj(reader, writer, length=1024 * 1024)
        writer.flush()
        os.fsync(writer.fileno())


def check_deployment(container: str, image: str) -> None:
    """Fail closed before stopping writers; Docker metadata can contain secrets."""
    try:
        inspected = subprocess.run(['docker', 'inspect', container], capture_output=True, text=True,
                                   check=True, timeout=30)
        deployed = json.loads(inspected.stdout)[0]
        environment = dict(entry.split('=', 1) for entry in deployed['Config']['Env'])
        options = conninfo_to_dict(database_uri())
        if (deployed['Image'] != image or conninfo_to_dict(environment['DATABASE_URI']) != options
                or deployed['HostConfig']['NetworkMode'] != 'host'
                or options.get('service') or os.environ.get('PGSERVICE') or environment.get('PGSERVICE')):
            raise ValueError('Deployment mismatch')
        for option in pq.Conninfo.get_defaults():
            if option.envvar and option.keyword.decode() not in options:
                name = option.envvar.decode()
                if os.environ.get(name) != environment.get(name):
                    raise ValueError('Connection environment mismatch')
        storage = PurePosixPath(posixpath.normpath(environment['AI_STORAGE_DIR']))
        roots = [Path(mount['Source']).joinpath(*storage.relative_to(mount['Destination']).parts)
                 for mount in deployed['Mounts'] if mount['Type'] == 'bind'
                 and storage.is_relative_to(mount['Destination'])]
        if not storage.is_absolute() or len(roots) != 1 or roots[0].resolve() != load().storage_dir.resolve():
            raise ValueError('Storage mismatch')
    except (OSError, ValueError, KeyError, IndexError, TypeError, DatabaseError, subprocess.SubprocessError):
        raise RuntimeError('Backup settings must match the deployed AI database, storage and image') from None


async def backup(db: Database, output: Path, config: Path, image: str, *, pg_bin: Path | None = None,
                 image_archive: Path | None = None, extra_config: Sequence[Path] = ()) -> dict:
    settings = load()
    if not settings.maintenance:
        raise RuntimeError('Backup requires AI_MAINTENANCE_MODE=true and stopped writers')
    async with exclusive(db):
        await db.check_schema()
        if config.is_symlink() or not config.is_file():
            raise ValueError('A private service configuration snapshot is required')
        if not re.fullmatch(r'sha256:[a-f0-9]{64}', image):
            raise ValueError('An immutable Docker image ID is required')
        if image_archive is None:
            raise ValueError('A matching docker-save image archive is required')
        await _thread_io(check_image, image_archive, image)
        await _thread_io(destination, output, settings.storage_dir)
        snapshot = time.time()
        await _thread_io(pg, str(pg_bin / 'pg_dump') if pg_bin else 'pg_dump', db.uri,
                         '--format=custom', '--no-owner', '--no-acl', '--file', str(output / 'database.dump'))
        (output / 'database.dump').chmod(0o600)
        await _thread_io(copy_files, settings.storage_dir, output / 'files')
        await _thread_io(atomic, output / 'config.env', config.read_bytes())
        await _thread_io(copy_private, image_archive, output / 'image.tar')
        for index, path in enumerate(extra_config):
            await _thread_io(copy_private, path, output / f'config-extra-{index}.env')
        value = await _thread_io(partial(manifest, output, image=image, snapshot=snapshot))
        await _thread_io(atomic, output / 'manifest.json', json.dumps(value).encode())
        await _thread_io(verify, output)
        return value


async def restore(db: Database, bundle: Path, output: Path, *, pg_bin: Path | None = None) -> dict:
    if not load().maintenance:
        raise RuntimeError('Restore requires AI_MAINTENANCE_MODE=true and fenced writers')
    value = await _thread_io(verify, bundle)
    async with exclusive(db):
        # Include routines/types, not just tables, before running an operator-owned SQL dump.
        objects = await db.rows("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname!='information_schema' UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname!='information_schema' UNION ALL SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname !~ '^pg_' AND n.nspname!='information_schema' UNION ALL SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('public','information_schema')")
        if objects or output.exists() or output.is_symlink():
            raise ValueError('Restore requires an empty dedicated database and new file destination')
        await _thread_io(destination, output, bundle)
        await _thread_io(copy_files, bundle / 'files', output / 'files')
        await _thread_io(atomic, output / 'config.env', (bundle / 'config.env').read_bytes())
        for name in value['files']:
            if re.fullmatch(r'config-extra-[0-9]+\.env', name):
                await _thread_io(copy_private, bundle / name, output / name)
        await _thread_io(pg, str(pg_bin / 'pg_restore') if pg_bin else 'pg_restore', db.uri,
                         '--dbname', make_conninfo(dbname=conninfo_to_dict(db.uri)['dbname']),
                         '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', str(bundle / 'database.dump'))
        await db.check_schema()
    return value


def metrics(path: Path, *, success: bool, snapshot: float | None = None) -> None:
    previous = 0.0
    if path.exists():
        match = re.search(r'^practiq_backup_last_success_timestamp_seconds ([0-9.]+)$', path.read_text(), re.MULTILINE)
        if match:
            previous = float(match[1])
    payload = (f'practiq_backup_last_success_timestamp_seconds {snapshot if success and snapshot is not None else previous:.6f}\n'
               f'practiq_backup_last_attempt_success {int(success)}\n')
    atomic(path, payload.encode(), 0o644)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['backup', 'verify', 'restore'])
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--config', type=Path)
    parser.add_argument('--image')
    parser.add_argument('--image-archive', type=Path)
    parser.add_argument('--extra-config', type=Path, action='append', default=[])
    parser.add_argument('--output', type=Path)
    parser.add_argument('--metrics', type=Path)
    parser.add_argument('--pg-bin', type=Path, help='Trusted directory with matching pg_dump/pg_restore')
    args = parser.parse_args()
    if args.action == 'backup' and (not args.config or not args.image or not args.image_archive):
        parser.error('backup requires --config, --image and --image-archive')
    if args.action == 'restore' and not args.output:
        parser.error('restore requires --output')
    success, snapshot = False, None
    try:
        if args.action == 'verify':
            value = verify(args.bundle)
        else:
            async def run():
                db = Database()
                await db.open()
                try:
                    if args.action == 'backup':
                        return await backup(db, args.bundle, args.config, args.image, pg_bin=args.pg_bin,
                                            image_archive=args.image_archive, extra_config=args.extra_config)
                    return await restore(db, args.bundle, args.output, pg_bin=args.pg_bin)
                finally:
                    await db.close()
            value = asyncio.run(run())
        success, snapshot = True, value['snapshotUnix']
        print(json.dumps({'status': 'PASSED', 'snapshotUnix': snapshot, 'image': value['image']}))
    except (OSError, ValueError, RuntimeError, tarfile.TarError, KeyError, DatabaseError):
        parser.exit(1, 'Backup operation failed; preserve the incomplete bundle and inspect private configuration/permissions\n')
    finally:
        if args.metrics and args.action == 'backup':
            metrics(args.metrics, success=success, snapshot=snapshot)


if __name__ == '__main__':
    main()
