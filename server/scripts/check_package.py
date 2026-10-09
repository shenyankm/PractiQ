"""Check actual service archives against the source modules and locked dependencies."""

import hashlib
import json
import tarfile
import tomllib
import zipfile
from pathlib import Path


def check_package(root: Path, output: Path) -> dict[str, str | int]:
    project = tomllib.loads((root / 'pyproject.toml').read_text())['project']
    prefix = f"{project['name'].replace('-', '_')}-{project['version']}"
    wheels = list(output.glob(f'{prefix}-*.whl'))
    if len(wheels) != 1:
        raise ValueError('Expected one wheel for the current project version')
    wheel = wheels[0]
    sdist = output / f'{prefix}.tar.gz'
    modules = {path.relative_to(root / 'src').as_posix(): path.read_bytes()
               for path in (root / 'src').rglob('*.py')}
    if not modules:
        raise ValueError('Service source modules are missing')
    lock = (root / 'uv.lock').read_bytes()
    with zipfile.ZipFile(wheel) as archive:
        for name, content in {**modules, 'practiq_ai/uv.lock': lock}.items():
            if name not in archive.namelist() or archive.read(name) != content:
                raise ValueError(f'Wheel source/lock mismatch: {name}')
    with tarfile.open(sdist) as archive:
        for name, content in {**{f'src/{name}': data for name, data in modules.items()},
                              'uv.lock': lock, 'pyproject.toml': (root / 'pyproject.toml').read_bytes()}.items():
            target = f'{prefix}/{name}'
            if target not in archive.getnames():
                raise ValueError(f'Source archive is missing: {name}')
            member = archive.extractfile(target)
            if member is None or member.read() != content:
                raise ValueError(f'Source archive content mismatch: {name}')
    return {'sourceFiles': len(modules),
            'wheelSha256': hashlib.sha256(wheel.read_bytes()).hexdigest(),
            'sdistSha256': hashlib.sha256(sdist.read_bytes()).hexdigest()}


if __name__ == '__main__':
    root = Path(__file__).parents[1]
    print(json.dumps(check_package(root, root / 'dist'), indent=2))
