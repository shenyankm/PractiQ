"""Stage the repository license only while Hatchling runs a packaging hook."""

import hashlib
import sqlite3
import tempfile
from contextlib import closing
from functools import wraps
from pathlib import Path

from hatchling import build


def _with_license(hook):
    @wraps(hook)
    def run(*args, **kwargs):
        notice = Path(__file__).resolve().parent / 'LICENSE'
        key = hashlib.sha256(str(notice).encode()).hexdigest()
        lock = Path(tempfile.gettempdir()) / f'practiq-build-{key}.sqlite3'
        # SQLite provides process-safe locks on all build hosts without a dependency.
        with closing(sqlite3.connect(lock, timeout=600)) as connection, connection:
            connection.execute('BEGIN EXCLUSIVE')
            # PKG-INFO identifies an extracted sdist; repository copies are temporary.
            if (notice.parent / 'PKG-INFO').is_file():
                notice.read_bytes()
                return hook(*args, **kwargs)
            content = (notice.parent.parent / 'LICENSE').read_bytes()
            notice.unlink(missing_ok=True)
            stream = notice.open('xb')
            try:
                with stream:
                    stream.write(content)
                return hook(*args, **kwargs)
            finally:
                notice.unlink()

    return run


get_requires_for_build_sdist = build.get_requires_for_build_sdist
get_requires_for_build_wheel = build.get_requires_for_build_wheel
get_requires_for_build_editable = build.get_requires_for_build_editable
build_sdist = _with_license(build.build_sdist)
build_wheel = _with_license(build.build_wheel)
build_editable = _with_license(build.build_editable)

if hasattr(build, 'prepare_metadata_for_build_wheel'):
    prepare_metadata_for_build_wheel = _with_license(build.prepare_metadata_for_build_wheel)
    prepare_metadata_for_build_editable = _with_license(build.prepare_metadata_for_build_editable)
