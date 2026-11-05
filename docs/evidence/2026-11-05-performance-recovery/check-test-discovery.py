"""Assert actual Vitest discovery preserves source tests and excludes local artifacts."""

import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[3]
app = root / 'app'
evidence = Path(__file__).resolve().parent
baseline = subprocess.check_output(
    ['git', 'show', '5973846c:app/vite.config.ts'], cwd=root, text=True,
)
expected = {str(path.resolve()) for suffix in ('ts', 'tsx') for path in (app / 'src').rglob(f'*.test.{suffix}')}
scratch = app / '.build'
scratch.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='test-discovery-', dir=scratch) as directory:
    canary = Path(directory) / 'foreign.test.ts'
    canary.write_text("throw new Error('Out-of-scope test must never load');\n")
    with tempfile.NamedTemporaryFile(mode='w', suffix='.ts', prefix='discovery-', dir=app) as config:
        config.write(baseline)
        config.flush()

        def discover(*arguments):
            output = subprocess.check_output(
                ['node', 'node_modules/vitest/vitest.mjs', 'list', '--filesOnly', '--json', *arguments],
                cwd=app, text=True,
            )
            return {row['file'] for row in json.loads(output)}

        before = discover('--config', config.name)
        after = discover()
    assert str(canary.resolve()) in before
    assert after == expected, {'missing': sorted(expected - after), 'unexpected': sorted(after - expected)}
    assert str(canary.resolve()) not in after
report = {'baseline': '5973846c', 'beforeFiles': len(before), 'afterFiles': len(after),
          'sourceFiles': len(expected), 'canaryExcluded': True, 'allSourceTestsRetained': True,
          'configSha256': hashlib.sha256((app / 'vite.config.ts').read_bytes()).hexdigest()}
(evidence / 'app-test-discovery.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
