"""Read only the unique synthetic namespace created for this performance QA."""
import hashlib
import json
import re
import sqlite3
import sys
from pathlib import Path
from zipfile import ZipFile

IDENTIFIER = 'com.practiq.perf-loop-20261013-01a13529'
QA_ROOT = Path.home() / 'Library/Application Support' / IDENTIFIER / 'v4'
TEMP_ROOT = Path('/var/folders/1b/b19xbzjx7xqc4kl0k9x_y4y80000gp/T/practiq-perf-loop-qrdu2192')
EVIDENCE = Path(__file__).resolve().parent


def logical(conn):
    assert conn.execute('PRAGMA user_version').fetchone()[0] == 11
    tables = [row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name")]
    rows = {}
    for table in tables:
        assert re.fullmatch('[a-z_]+', table)
        rows[table] = [[{'type': type(value).__name__, 'value': value.hex() if isinstance(value, bytes) else value}
                        for value in row] for row in conn.execute(f'SELECT * FROM {table} ORDER BY rowid')]
    encoded = json.dumps(rows, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
    return {'sha256': hashlib.sha256(encoded).hexdigest(), 'tableCounts': {table: len(values) for table, values in rows.items()}, 'schemaVersion': 11}


phase = sys.argv[1]
assert phase in {'before-restore', 'after-restore', 'reopen'}
assert QA_ROOT.parent.name == IDENTIFIER and QA_ROOT.is_dir()
with ZipFile(TEMP_ROOT / 'native-qa-backup.zip') as archive:
    assert archive.testzip() is None
    manifest = json.loads(archive.read('manifest.json'))
    assert (manifest['format'], manifest['version'], manifest['schemaVersion']) == ('practiq-backup', 4, 11)
    assert 'serviceSettings' not in manifest
    for entry in [manifest['database'], *manifest['assets']]:
        payload = archive.read(entry['file'])
        assert len(payload) == entry['sizeBytes']
        assert hashlib.sha256(payload).hexdigest() == entry['sha256']
    expected_db = sqlite3.connect(':memory:')
    expected_db.deserialize(archive.read(manifest['database']['file']))
    expected = logical(expected_db)
    expected_db.close()
with sqlite3.connect((QA_ROOT / 'practiq.sqlite').as_uri() + '?mode=ro', uri=True) as current:
    actual = logical(current)
    assert actual['tableCounts']['sessions'] == expected['tableCounts']['sessions'] == 1
    if phase == 'before-restore':
        assert actual['tableCounts']['banks'] == 2 and expected['tableCounts']['banks'] == 1
    else:
        assert actual == expected
        for asset in manifest['assets']:
            payload = (QA_ROOT / asset['file']).read_bytes()
            assert len(payload) == asset['sizeBytes'] and hashlib.sha256(payload).hexdigest() == asset['sha256']
report = {'phase': phase, 'qaRoot': str(QA_ROOT), 'backupSha256': hashlib.sha256((TEMP_ROOT / 'native-qa-backup.zip').read_bytes()).hexdigest(),
          'bankZipSha256': hashlib.sha256((TEMP_ROOT / 'native-qa-bank.zip').read_bytes()).hexdigest(), 'expected': expected, 'actual': actual,
          'assetChecks': manifest['assets'], 'scope': 'Read-only synthetic QA data and archives; no real user database or performance measurement'}
(EVIDENCE / f'native-qa-{phase}.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
