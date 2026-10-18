"""Stage the repository license only while Hatchling runs a packaging hook."""

from functools import wraps
from pathlib import Path

from hatchling import build


def _with_license(hook):
    @wraps(hook)
    def run(*args, **kwargs):
        notice = Path(__file__).parent / 'LICENSE'
        if notice.exists():
            return hook(*args, **kwargs)
        # Source archives already carry LICENSE; repository builds use the root copy.
        content = (notice.parent.parent / 'LICENSE').read_bytes()
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
