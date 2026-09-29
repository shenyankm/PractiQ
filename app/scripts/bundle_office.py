"""Stage the complete, checksum-pinned official LibreOffice runtime. Build time only."""
import hashlib
import json
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LOCK = Path(__file__).with_name('libreoffice.lock.json')


def architecture() -> str:
    return {'arm64': 'aarch64', 'amd64': 'x86_64'}.get(platform.machine().lower(), platform.machine().lower())


def checksum(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def validate(bundle: Path) -> dict:
    manifest = json.loads((bundle / 'office/manifest.json').read_text(encoding='utf-8'))
    lock = json.loads(LOCK.read_text(encoding='utf-8'))
    artifact = lock['artifacts'][f'{sys.platform}-{architecture()}']
    expected = dict(artifact, version=lock['version'], source=lock['source'], platform=sys.platform, architecture=architecture())
    if manifest != expected:
        raise ValueError('LibreOffice manifest does not match the locked platform/version')
    root = (bundle / 'office').resolve()
    executable = (root / manifest['executable']).resolve(strict=True)
    if not executable.is_relative_to(root) or not executable.is_file():
        raise ValueError('Invalid bundled LibreOffice executable')
    return manifest


def build(bundle: Path) -> dict:
    lock = json.loads(LOCK.read_text(encoding='utf-8'))
    artifact = lock['artifacts'][f'{sys.platform}-{architecture()}']
    manifest = dict(artifact, version=lock['version'], source=lock['source'], platform=sys.platform, architecture=architecture())
    cache = ROOT / 'app/.build/office-downloads'
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / artifact['url'].rsplit('/', 1)[1]
    if not archive.exists():
        partial = archive.with_suffix(archive.suffix + '.partial')
        try:
            with urllib.request.urlopen(artifact['url'], timeout=120) as response, partial.open('wb') as output:
                shutil.copyfileobj(response, output)
            if checksum(partial) != artifact['sha256']:
                raise ValueError('LibreOffice download checksum mismatch')
            partial.replace(archive)
        finally:
            partial.unlink(missing_ok=True)
    if checksum(archive) != artifact['sha256']:
        raise ValueError(f'LibreOffice cache checksum mismatch: {archive}')
    bundle.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='office-stage-', dir=bundle.parent) as temporary:
        stage = Path(temporary)
        output = stage / 'office'
        output.mkdir()
        if sys.platform == 'darwin':
            mount = stage / 'mount'
            subprocess.run(['hdiutil', 'attach', str(archive), '-readonly', '-nobrowse', '-mountpoint', str(mount)], check=True)
            try:
                subprocess.run(['ditto', str(mount / 'LibreOffice.app'), str(output / 'LibreOffice.app')], check=True)
            finally:
                subprocess.run(['hdiutil', 'detach', str(mount)], check=True)
        elif sys.platform == 'win32':
            extracted = stage / 'msi'
            subprocess.run(['msiexec.exe', '/a', str(archive), '/qn', f'TARGETDIR={extracted}', '/norestart'], check=True)
            engines = list(extracted.rglob('program/soffice.com'))
            if len(engines) != 1:
                raise ValueError('Unexpected LibreOffice MSI layout')
            shutil.copytree(engines[0].parent.parent, output / 'runtime', symlinks=True)
        else:
            extracted = stage / 'deb'
            with tarfile.open(archive) as tar:
                tar.extractall(extracted, filter='data')
            packages = sorted(extracted.glob('*/DEBS/*.deb'))
            if not packages:
                raise ValueError('No LibreOffice DEB packages')
            filesystem = stage / 'filesystem'
            for package in packages:
                subprocess.run(['dpkg-deb', '-x', str(package), str(filesystem)], check=True)
            engines = list(filesystem.glob('opt/libreoffice*/program/soffice'))
            if len(engines) != 1:
                raise ValueError('Unexpected LibreOffice DEB layout')
            shutil.copytree(engines[0].parent.parent, output / 'runtime', symlinks=True)
            # Fontconfig 2.13.1 otherwise creates these IDs on first use, modifying the install.
            for relative in ('share/fonts/truetype', 'program/resource/common/fonts'):
                identifier = uuid.uuid5(uuid.NAMESPACE_URL, f'{artifact["sha256"]}:{relative}')
                (output / 'runtime' / relative / '.uuid').write_text(str(identifier), encoding='ascii')
        if not (output / artifact['executable']).is_file():
            raise ValueError('LibreOffice extraction produced no executable')
        (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        destination = bundle / 'office'
        if destination.exists():
            shutil.rmtree(destination)
        output.replace(destination)
    return validate(bundle)


if __name__ == '__main__':
    build(ROOT / 'app/src-tauri/bundled')
