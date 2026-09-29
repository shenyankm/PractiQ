"""The build must reject altered downloads and mismatched bundled resources."""
import importlib.util
import io
import json
import tarfile
import uuid
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parents[2] / 'app/scripts/bundle_office.py'
spec = importlib.util.spec_from_file_location('bundle_office', SCRIPT)
assert spec is not None and spec.loader is not None
bundle_office = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle_office)


def test_bundle_manifest_requires_pinned_platform_and_present_engine(tmp_path):
    lock = json.loads(bundle_office.LOCK.read_text())
    platform = bundle_office.sys.platform
    architecture = bundle_office.architecture()
    artifact = lock['artifacts'][f'{platform}-{architecture}']
    manifest = dict(artifact, version=lock['version'], source=lock['source'], platform=platform, architecture=architecture)
    root = tmp_path / '中文 Program Files' / 'office'
    root.mkdir(parents=True)
    path = root / 'manifest.json'
    path.write_text(json.dumps(manifest))
    with pytest.raises(FileNotFoundError):
        bundle_office.validate(root.parent)
    engine = root / artifact['executable']
    engine.parent.mkdir(parents=True)
    engine.touch()
    assert bundle_office.validate(root.parent) == manifest
    for field, value in [('architecture', 'wrong'), ('version', '0'), ('executable', '../outside'), ('sha256', '0' * 64)]:
        path.write_text(json.dumps({**manifest, field: value}))
        with pytest.raises(ValueError, match='manifest'):
            bundle_office.validate(root.parent)


def test_cached_download_is_checked_before_extraction(tmp_path, monkeypatch):
    monkeypatch.setattr(bundle_office, 'ROOT', tmp_path)
    lock = json.loads(bundle_office.LOCK.read_text())
    artifact = lock['artifacts'][f'{bundle_office.sys.platform}-{bundle_office.architecture()}']
    cached = tmp_path / 'app/.build/office-downloads' / artifact['url'].rsplit('/', 1)[1]
    cached.parent.mkdir(parents=True)
    cached.write_bytes(b'truncated download')
    monkeypatch.setattr(bundle_office.subprocess, 'run', lambda *args, **kwargs: pytest.fail('must reject before extraction'))
    with pytest.raises(ValueError, match='checksum mismatch'):
        bundle_office.build(tmp_path / 'bundle')


def test_linux_bundle_seeds_stable_distinct_fontconfig_ids(tmp_path, monkeypatch):
    monkeypatch.setattr(bundle_office, 'ROOT', tmp_path)
    monkeypatch.setattr(bundle_office.sys, 'platform', 'linux')
    monkeypatch.setattr(bundle_office, 'architecture', lambda: 'x86_64')
    lock = json.loads(bundle_office.LOCK.read_text(encoding='utf-8'))
    artifact = lock['artifacts']['linux-x86_64']
    cached = tmp_path / 'app/.build/office-downloads' / artifact['url'].rsplit('/', 1)[1]
    cached.parent.mkdir(parents=True)
    with tarfile.open(cached, 'w:gz') as archive:
        package = tarfile.TarInfo('LibreOffice/DEBS/runtime.deb')
        package.size = 3
        archive.addfile(package, io.BytesIO(b'deb'))
    artifact['sha256'] = bundle_office.checksum(cached)
    lock_path = tmp_path / 'lock.json'
    lock_path.write_text(json.dumps(lock), encoding='utf-8')
    monkeypatch.setattr(bundle_office, 'LOCK', lock_path)
    font_dirs = ('share/fonts/truetype', 'program/resource/common/fonts')

    def extract(command, *, check):
        assert command[:2] == ['dpkg-deb', '-x'] and check
        runtime = Path(command[3]) / 'opt/libreoffice26.8'
        for relative in font_dirs:
            (runtime / relative).mkdir(parents=True)
            (runtime / relative / 'sample.ttf').write_bytes(b'font')
        (runtime / 'program/soffice').touch()

    monkeypatch.setattr(bundle_office.subprocess, 'run', extract)
    snapshots = []
    for name in ('first build', '中文 relocated build'):
        bundle = tmp_path / name
        bundle_office.build(bundle)
        runtime = bundle / 'office/runtime'
        ids = [(runtime / relative / '.uuid').read_text(encoding='ascii') for relative in font_dirs]
        assert len({uuid.UUID(value) for value in ids}) == len(font_dirs)
        assert all((runtime / relative / 'sample.ttf').read_bytes() == b'font' for relative in font_dirs)
        snapshots.append(ids)
    assert snapshots[0] == snapshots[1]
