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
    ('wheel', 'missing-license'), ('sdist', 'missing-license'),
    ('wheel', 'changed-license'), ('sdist', 'changed-license'),
    ('wheel', 'wrong-license-expression'), ('sdist', 'wrong-license-expression'),
    ('wheel', 'missing-license-header'), ('sdist', 'missing-license-header'),
    ('wheel', 'missing-license-declaration'), ('sdist', 'missing-license-declaration'),
])
def test_service_archive_guard(tmp_path, archive_kind, mutation):
    root = tmp_path / 'service'
    output = tmp_path / 'dist'
    (root / 'src/practiq_ai').mkdir(parents=True)
    output.mkdir()
    project = b'[project]\nname="practiq-ai-service"\nversion="0.3.0"\nlicense="MIT"\nlicense-files=["LICENSE"]\n'
    (root / 'pyproject.toml').write_bytes(project)
    (root / 'uv.lock').write_bytes(b'locked dependencies')
    source = b'"""Service source."""\n'
    notice = b'Synthetic MIT notice\n'
    metadata = b'License-Expression: MIT\nLicense-File: LICENSE\n'
    (root / 'LICENSE').write_bytes(notice)
    (root / 'src/practiq_ai/__init__.py').write_bytes(source)
    wheel_files = {'practiq_ai/__init__.py': source, 'practiq_ai/uv.lock': b'locked dependencies'}
    source_files = {'src/practiq_ai/__init__.py': source, 'uv.lock': b'locked dependencies', 'pyproject.toml': project}
    wheel_files.update({'practiq_ai_service-0.3.0.dist-info/licenses/LICENSE': notice,
                        'practiq_ai_service-0.3.0.dist-info/METADATA': metadata})
    source_files.update({'LICENSE': notice, 'PKG-INFO': metadata})
    files = wheel_files if archive_kind == 'wheel' else source_files
    name = 'practiq_ai/__init__.py' if archive_kind == 'wheel' else 'src/practiq_ai/__init__.py'
    if mutation == 'missing-source':
        del files[name]
    elif mutation == 'changed-source':
        files[name] = b'changed module'
    elif mutation == 'missing-lock':
        del files['practiq_ai/uv.lock' if archive_kind == 'wheel' else 'uv.lock']
    elif mutation in {'missing-license', 'changed-license'}:
        name = 'practiq_ai_service-0.3.0.dist-info/licenses/LICENSE' if archive_kind == 'wheel' else 'LICENSE'
        if mutation == 'missing-license':
            del files[name]
        else:
            files[name] = b'changed notice'
    elif mutation in {'wrong-license-expression', 'missing-license-header'}:
        name = 'practiq_ai_service-0.3.0.dist-info/METADATA' if archive_kind == 'wheel' else 'PKG-INFO'
        files[name] = (metadata.replace(b'MIT', b'BSD') if mutation == 'wrong-license-expression'
                       else metadata.replace(b'License-File: LICENSE\n', b''))
    elif mutation == 'missing-license-declaration':
        project = project.replace(b'license-files=["LICENSE"]\n', b'')
        (root / 'pyproject.toml').write_bytes(project)
        source_files['pyproject.toml'] = project
    with zipfile.ZipFile(output / 'practiq_ai_service-0.3.0-py3-none-any.whl', 'w') as archive:
        for name, data in wheel_files.items():
            archive.writestr(name, data)
    with tarfile.open(output / 'practiq_ai_service-0.3.0.tar.gz', 'w:gz') as archive:
        for name, data in source_files.items():
            member = tarfile.TarInfo(f'practiq_ai_service-0.3.0/{name}')
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
    if mutation:
        with pytest.raises(ValueError, match='mismatch|Source archive is missing'):
            CHECK(root, output)
    else:
        assert CHECK(root, output)['sourceFiles'] == 1
