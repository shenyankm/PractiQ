"""Inventory local release notices; missing texts fail, SPDX declarations are not texts."""
import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from desktop_package import read_manifest
from android_licenses import runtime_notices

ROOT = Path(__file__).resolve().parents[2]


def license_files(directory: Path) -> list[Path]:
    return sorted(path for path in directory.rglob('*') if path.is_file()
                  and not any(part in {'node_modules', '.git', 'target'} for part in path.relative_to(directory).parts[:-1])
                  and any(part.lower().startswith(('license', 'licence', 'copying', 'notice', 'copyright')) for part in path.relative_to(directory).parts))


def inventory(bundle: Path, android_runtime_inventory: Path | None = None) -> dict:
    rows = []
    runtime_bytes = android_runtime_inventory.read_bytes() if android_runtime_inventory else None
    supplements = json.loads((ROOT/'app/licenses/supplemental.json').read_text(encoding='utf-8'))

    def add(ecosystem, name, version, declaration, source, files):
        for item in supplements.get(f'{ecosystem}:{name}@{version}', []):
            path = ROOT/'app/licenses'/item['file']
            if hashlib.sha256(path.read_bytes()).hexdigest() != item['sha256']:
                raise ValueError(f'Altered license text: {name}')
            if (evidence := item.get('evidence')) and hashlib.sha256((ROOT/'app/licenses'/evidence['file']).read_bytes()).hexdigest() != evidence['sha256']:
                raise ValueError(f'Altered license evidence: {name}')
            files.append(path)
        rows.append({'ecosystem':ecosystem, 'name':name, 'version':version, 'declaration':declaration,
                     'source':source, 'supplementalSources':supplements.get(f'{ecosystem}:{name}@{version}', []),
                     'texts':[{'path':str(p), 'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in files]})

    platform = json.loads((bundle/'build-manifest.json').read_text(encoding='utf-8')).get('platform')
    manifest = read_manifest(bundle, platform)
    lock = json.loads((ROOT/'app/package-lock.json').read_text(encoding='utf-8'))
    for path, package in lock['packages'].items():
        if not path or package.get('dev'):
            continue
        add('npm', path.split('node_modules/')[-1], package['version'], package.get('license'), package.get('resolved'), license_files(ROOT/'app'/path))
    target = ({'arm64':'aarch64-linux-android', 'x86_64':'x86_64-linux-android'}[manifest['architecture']]
              if platform == 'android' else next(line.split(': ', 1)[1] for line in subprocess.check_output(['rustc', '-vV'], text=True, encoding="utf-8").splitlines() if line.startswith('host: ')))
    metadata = json.loads(subprocess.check_output(['cargo', 'metadata', '--manifest-path', str(ROOT/'app/src-tauri/Cargo.toml'), '--locked', '--offline', '--format-version', '1', '--filter-platform', target], text=True, encoding="utf-8"))
    resolved = {node['id'] for node in metadata['resolve']['nodes']}
    for package in metadata['packages']:
        if package['id'] not in resolved or package['name'] == 'practiq-desktop':
            continue
        add('cargo', package['name'], package['version'], package.get('license'), package.get('repository'), license_files(Path(package['manifest_path']).parent))
    if platform == 'android':
        rows.extend(runtime_notices(ROOT, android_runtime_inventory, manifest['architecture'], metadata['packages'], raw_inventory=runtime_bytes, cargo_notices=rows))
    missing = [f'{r["ecosystem"]}:{r["name"]}@{r["version"]}' for r in rows if not r['texts']]
    unverified = [f'{r["ecosystem"]}:{r["name"]}@{r["version"]}' for r in rows if any(s.get('note') for s in r['supplementalSources'])]
    return {'target':target, 'androidRuntimeInventorySha256':hashlib.sha256(runtime_bytes).hexdigest() if platform == 'android' and runtime_bytes is not None else None, 'scope':'Practice-client target Cargo packages (including build dependencies), npm production closure and, on Android, the exact resolved Maven runtime. Local Android Tauri projects use their locked Cargo source licenses. The independently deployed AI service is outside this notice scope. Human obligations review remains required.',
            'passed':not missing and not unverified, 'missingTexts':missing, 'unverifiedSources':unverified, 'packages':rows}


def write_notices(report: dict, destination: Path) -> None:
    with destination.open('w', encoding='utf-8') as output:
        output.write('PractiQ third-party notices\n\n'+report['scope']+'\n')
        for package in report['packages']:
            output.write(f'\n=== {package["ecosystem"]}: {package["name"]} {package["version"]} ===\n')
            output.write(f'Declaration: {package["declaration"]}\nSource: {package["source"]}\n')
            for source in package['supplementalSources']:
                output.write(f'Supplemental source: {source["source"]}\n')
                if source.get('note'):
                    output.write(source['note']+'\n')
                if source.get('verification'):
                    output.write('Verification: '+source['verification']+'\n')
                if evidence := source.get('evidence'):
                    path = ROOT/'app/licenses'/evidence['file']
                    raw = path.read_bytes()
                    if hashlib.sha256(raw).hexdigest() != evidence['sha256']:
                        raise ValueError('License evidence changed during notice generation')
                    output.write(f'Verification evidence (SHA-256 {evidence["sha256"]}):\n'+raw.decode('utf-8')+'\n')
            for item in package['texts']:
                path = Path(item['path'])
                raw = path.read_bytes()
                if hashlib.sha256(raw).hexdigest() != item['sha256']:
                    raise ValueError('License changed during notice generation')
                output.write(f'\n--- {path.name} (SHA-256 {item["sha256"]}) ---\n')
                output.write(raw.decode('utf-8', errors='replace')+'\n')
        if report['missingTexts']:
            output.write('\nUNRESOLVED NOTICE TEXTS:\n'+'\n'.join(report['missingTexts'])+'\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--notices', type=Path)
    parser.add_argument('--android-runtime-inventory', type=Path)
    args = parser.parse_args()
    report = inventory(args.bundle, args.android_runtime_inventory)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x', encoding='utf-8') as output:
        json.dump(report, output, ensure_ascii=False, indent=2)
    if args.notices:
        write_notices(report, args.notices)
    print(json.dumps({'packages':len(report['packages']), 'missingTexts':report['missingTexts'], 'unverifiedSources':report['unverifiedSources']}))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
