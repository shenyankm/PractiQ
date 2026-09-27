"""Build native Python application resources on each supported desktop OS."""
import json
import platform
import shutil
import subprocess
import sys
import sysconfig
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'app/src-tauri/bundled'


def main():
    if sys.platform not in {'darwin', 'win32', 'linux'} or sys.version_info < (3,14):
        raise SystemExit('Build requires macOS, Windows or Linux and Python 3.14+')
    OUTPUT.mkdir(parents=True, exist_ok=True)
    subprocess.run([sys.executable,'-m','PyInstaller','--noconfirm','--distpath',str(OUTPUT),'--workpath',str(ROOT/'app/.build/python'),str(ROOT/'app/scripts/sidecar.spec')],check=True)
    license_path = next(path for path in (Path(sysconfig.get_path('stdlib'))/'LICENSE.txt', Path(sys.base_prefix)/'LICENSE.txt') if path.is_file())
    shutil.copyfile(license_path, OUTPUT/'PYTHON-LICENSE.txt')
    for retired in (OUTPUT/'LibreOffice.app', OUTPUT/'office'):
        if retired.exists(): shutil.rmtree(retired)
    (OUTPUT/'THIRD-PARTY.txt').write_text('Python and Python dependency licenses are retained in the bundled distribution metadata.\n')
    from importlib.metadata import distributions
    packages=sorted([{'name':d.metadata['Name'],'version':d.version} for d in distributions(path=[str(OUTPUT/'python/_internal')])],key=lambda d:d['name'].lower())
    assert not {'alibabacloud-oss-v2', 'python-docx', 'openpyxl', 'psycopg', 'psycopg-pool', 'langgraph-checkpoint-postgres', 'langgraph-api', 'langgraph-runtime-inmem', 'langgraph-grpc-common'} & {p['name'].lower() for p in packages}, 'Retired dependencies were bundled'
    (OUTPUT/'build-manifest.json').write_text(json.dumps({'platform':sys.platform,'architecture':platform.machine(),'python':sys.version,'packages':packages},indent=2), encoding='utf-8')
    print(f'Bundled resources: {OUTPUT}')

if __name__=='__main__':main()
