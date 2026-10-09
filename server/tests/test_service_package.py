"""Archive guards reject builds that omit or change service modules and the lock."""

import io
import runpy
import tarfile
import zipfile
from pathlib import Path

import pytest

CHECK = runpy.run_path(str(Path(__file__).parents[1] / 'scripts/check_package.py'))['check_package']


@pytest.mark.parametrize('archive_kind,mutation', [
    ('wheel', None), ('sdist', None),
    ('wheel', 'missing-source'), ('sdist', 'missing-source'),
    ('wheel', 'changed-source'), ('sdist', 'changed-source'),
    ('wheel', 'missing-lock'), ('sdist', 'missing-lock'),
])
def test_service_archive_guard(tmp_path, archive_kind, mutation):
    root = tmp_path / 'service'
    output = tmp_path / 'dist'
    (root / 'src/practiq_ai').mkdir(parents=True)
    output.mkdir()
    project = b'[project]\nname="practiq-ai-service"\nversion="0.3.0"\n'
    (root / 'pyproject.toml').write_bytes(project)
    (root / 'uv.lock').write_bytes(b'locked dependencies')
    source = b'"""Service source."""\n'
    (root / 'src/practiq_ai/__init__.py').write_bytes(source)
    wheel_files = {'practiq_ai/__init__.py': source, 'practiq_ai/uv.lock': b'locked dependencies'}
    source_files = {'src/practiq_ai/__init__.py': source, 'uv.lock': b'locked dependencies', 'pyproject.toml': project}
    files = wheel_files if archive_kind == 'wheel' else source_files
    name = 'practiq_ai/__init__.py' if archive_kind == 'wheel' else 'src/practiq_ai/__init__.py'
    if mutation == 'missing-source':
        del files[name]
    elif mutation == 'changed-source':
        files[name] = b'changed module'
    elif mutation == 'missing-lock':
        del files['practiq_ai/uv.lock' if archive_kind == 'wheel' else 'uv.lock']
    with zipfile.ZipFile(output / 'practiq_ai_service-0.3.0-py3-none-any.whl', 'w') as archive:
        for name, data in wheel_files.items():
            archive.writestr(name, data)
    with tarfile.open(output / 'practiq_ai_service-0.3.0.tar.gz', 'w:gz') as archive:
        for name, data in source_files.items():
            member = tarfile.TarInfo(f'practiq_ai_service-0.3.0/{name}')
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
    if mutation:
        with pytest.raises(ValueError, match='Wheel source/lock mismatch|Source archive is missing|Source archive content mismatch'):
            CHECK(root, output)
    else:
        assert CHECK(root, output)['sourceFiles'] == 1
