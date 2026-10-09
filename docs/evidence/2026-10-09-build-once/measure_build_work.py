"""Paired existing Makefile commands; warm Docker/dependencies, clean or warm frontend cache."""
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
output = Path(sys.argv[1])
assert not output.exists()
report = {
    'baselineSha': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
    'environment': {'os': platform.platform(), 'node': subprocess.check_output(['node', '--version'], text=True).strip(),
                    'npm': subprocess.check_output(['npm', '--version'], text=True).strip(),
                    'docker': subprocess.check_output(['docker', 'version', '--format', '{{.Server.Version}}'], text=True).strip()},
    'scope': 'Exact build-command subsequence: baseline web-build then image-check; candidate image-check only. Docker layers/dependencies/OS cache warm. Clean means deleted frontend output/Vite/TypeScript build state; not a cold image build. Live evaluation runs independently in the primary checkout; no other local build/test runs.',
    'inputs': {name: hashlib.sha256((root/name).read_bytes()).hexdigest() for name in ['Makefile', '.github/workflows/server.yml', 'Dockerfile.server', 'server/uv.lock', 'web/package-lock.json', 'web/vite.config.ts']},
    'samples': [],
}
def inventory():
    return {str(p.relative_to(root/'web/dist')): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted((root/'web/dist').rglob('*')) if p.is_file()}
def build(commands, name):
    began = time.perf_counter()
    log = ''
    for command in commands:
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        log += result.stdout + result.stderr
        (output.parent/f'{name}.log').write_text(log)
        assert result.returncode == 0, name
    return time.perf_counter() - began, log
build([['make', 'image-check']], 'build-warmup')
expected = inventory()
for cache in ['clean-frontend', 'incremental']:
    for repeat in range(1, 4):
        for phase in (['before', 'after'] if repeat % 2 else ['after', 'before']):
            if cache == 'clean-frontend':
                for p in [root/'web/dist', root/'web/node_modules/.vite']:
                    shutil.rmtree(p, ignore_errors=True)
                for p in (root/'web').glob('*.tsbuildinfo'):
                    p.unlink()
            commands = ([['make', 'web-build']] if phase == 'before' else []) + [['make', 'image-check']]
            elapsed, log = build(commands, f'build-{cache}-{repeat}-{phase}')
            builds = log.count('npm --prefix web run build')
            assert builds == (2 if phase == 'before' else 1), builds
            assert inventory() == expected, 'Static output changed'
            image = json.loads(subprocess.check_output(['docker', 'image', 'inspect', 'practiq-ai:ci'], text=True))[0]
            platform_digest, = re.findall(r'exporting manifest (sha256:[a-f0-9]{64})', log)
            config_digest, = re.findall(r'exporting config (sha256:[a-f0-9]{64})', log)
            row = {'cache': cache, 'repeat': repeat, 'phase': phase, 'seconds': elapsed, 'webBuildInvocations': builds,
                   'staticBytes': sum(p.stat().st_size for p in (root/'web/dist').rglob('*') if p.is_file()),
                   'imageId': image['Id'], 'imageBytes': image['Size'], 'platformManifest': platform_digest, 'imageConfig': config_digest}
            report['samples'].append(row)
            print(row, flush=True)
report['assetHashes'] = expected
report['summary'] = {cache: {phase: {'medianSeconds': statistics.median(values := [s['seconds'] for s in report['samples'] if s['cache']==cache and s['phase']==phase]),
                                  'minSeconds': min(values), 'maxSeconds': max(values)} for phase in ['before','after']} for cache in ['clean-frontend','incremental']}
assert len(report['samples']) == 12
assert len({s['platformManifest'] for s in report['samples']}) == 1, 'Platform image content changed'
assert len({s['imageConfig'] for s in report['samples']}) == 1, 'Image configuration changed'
report['firstMeasurementFailure'] = 'The original assertion compared OCI indexes containing timestamped build attestations. Raw samples/logs are retained separately. These repetitions compare stable platform manifests/configuration and all static hashes; proof generation remains enabled.'
output.write_text(json.dumps(report, indent=2)+'\n')
