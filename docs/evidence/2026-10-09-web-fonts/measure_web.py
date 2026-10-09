import gzip
import hashlib
import json
import platform
import re
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path

root = Path.cwd()
web = root / 'web'
output = Path(sys.argv[1])
assert not output.exists()
report = {'baselineSha': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(), 'phase': sys.argv[2], 'environment': {'os': platform.platform(), 'node': subprocess.check_output(['node', '--version'], text=True).strip(), 'npm': subprocess.check_output(['npm', '--version'], text=True).strip()}, 'inputs': {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in [web/'package-lock.json', web/'vite.config.ts']}, 'samples': []}
for cache in ['clean', 'incremental']:
    for repeat in range(3):
        if cache == 'clean':
            shutil.rmtree(web/'dist', ignore_errors=True)
            shutil.rmtree(web/'node_modules/.vite', ignore_errors=True)
            for p in web.glob('*.tsbuildinfo'):
                p.unlink()
        before = time.perf_counter()
        completed = subprocess.run(['npm', '--prefix', 'web', 'run', 'build'], capture_output=True, text=True)
        log = output.with_name(f'{output.stem}-{cache}-{repeat+1}.log')
        log.write_text(completed.stdout + completed.stderr)
        if completed.returncode:
            raise RuntimeError(f'Build failed: {log}')
        duration = time.perf_counter() - before
        files = [p for p in (web/'dist').rglob('*') if p.is_file()]
        html = (web/'dist/index.html').read_text()
        initial = [web/'dist'/p.lstrip('/') for p in re.findall(r'(?:src|href)="([^"]+\.(?:js|css))"', html)]
        row = {'cache': cache, 'repeat': repeat+1, 'seconds': duration, 'staticBytes': sum(p.stat().st_size for p in files), 'initialJsCssBytes': sum(p.stat().st_size for p in initial), 'initialJsCssGzipBytes': sum(len(gzip.compress(p.read_bytes(), mtime=0)) for p in initial), 'fontBytes': sum(p.stat().st_size for p in files if p.suffix in ('.woff2','.woff','.ttf')), 'fontCounts': {ext: sum(p.suffix==ext for p in files) for ext in ['.woff2','.woff','.ttf']}}
        report['samples'].append(row)
        print(row, flush=True)
report['buildSeconds'] = {cache: {'median': statistics.median(r['seconds'] for r in report['samples'] if r['cache']==cache), 'min': min(r['seconds'] for r in report['samples'] if r['cache']==cache), 'max': max(r['seconds'] for r in report['samples'] if r['cache']==cache)} for cache in ['clean','incremental']}
report['assetHashes'] = {str(p.relative_to(web/'dist')): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((web/'dist').rglob('*')) if p.is_file()}
output.write_text(json.dumps(report, indent=2)+'\n')
