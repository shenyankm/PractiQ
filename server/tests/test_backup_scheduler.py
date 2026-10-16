import json
import os
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.parametrize('running,payment,filesystem,result', [
    ('true', 'false', 'nfs', 1),
    ('false', 'false', 'nfs', 0),
    ('true', 'true', 'nfs', 1),
    ('true', 'true', 'ext4', 0),
])
def test_backup_scheduler_preserves_stopped_services_and_recovers_after_failure(tmp_path, running, payment, filesystem, result):
    (tmp_path / 'server').mkdir()
    (tmp_path / '.env').write_text('AI_STORAGE_DIR=/wrong/env-file-path\nAI_MAINTENANCE_MODE=false\n')
    commands = tmp_path / 'bin'
    commands.mkdir()
    log = tmp_path / 'commands.jsonl'
    program = f'''#!{sys.executable}
import json,os,sys
from pathlib import Path
name=Path(sys.argv[0]).name
args=sys.argv[1:]
with open(os.environ['COMMAND_LOG'],'a') as stream:
    stream.write(json.dumps([name,*args])+'\\n')
if name=='docker' and 'ps' in args: print('container')
if name=='docker' and '{{{{.Image}}}}' in args: print(os.environ['PRACTIQ_BACKUP_IMAGE_ID'])
if name=='docker' and '{{{{.State.Running}}}}' in args: print(os.environ['AI_RUNNING'])
if name=='findmnt': print(os.environ['FILESYSTEM'])
if name=='systemctl' and 'is-active' in args: sys.exit(0 if os.environ['PAYMENT_RUNNING']=='true' else 1)
if name=='python' and args[:2]==['-m','dotenv']:
    os.execv(sys.executable,[sys.executable,*args])
if name=='python' and args[:2]==['-m','scripts.service_backup']:
    assert os.environ['AI_STORAGE_DIR']=='/private/storage'
    assert os.environ['AI_MAINTENANCE_MODE']=='true'
    sys.exit(int(os.environ['DUMP_RESULT']))
'''
    for name in ('python', 'docker', 'findmnt', 'mountpoint', 'systemctl'):
        file = commands / name
        file.write_text(program)
        file.chmod(0o755)
    environment = os.environ | {
        'PATH': str(commands) + os.pathsep + os.environ['PATH'], 'COMMAND_LOG': str(log),
        'PRACTIQ_PROJECT_DIR': str(tmp_path), 'PRACTIQ_STORAGE_DIR': '/private/storage',
        'PRACTIQ_BACKUP_ROOT': '/mounted/offhost', 'PRACTIQ_BACKUP_IMAGE_ARCHIVE': '/private/image.tar',
        'PRACTIQ_BACKUP_IMAGE_ID': 'sha256:' + 'a' * 64, 'PRACTIQ_BACKUP_PYTHON': str(commands / 'python'),
        'PRACTIQ_BACKUP_METRICS': '/private/backup.prom', 'PRACTIQ_PAYMENT_UNIT': 'checkout.service',
        'PRACTIQ_BACKUP_PAYMENT_CONFIG': '/private/payments.env', 'AI_RUNNING': running,
        'PAYMENT_RUNNING': payment, 'FILESYSTEM': filesystem, 'DUMP_RESULT': str(result),
    }
    script = Path(__file__).parents[1] / 'deploy/backup-offline.sh'
    process = subprocess.run(['/bin/sh', str(script)], env=environment, capture_output=True, timeout=10, check=False)
    calls = [json.loads(line) for line in log.read_text().splitlines()]
    permitted = filesystem == 'nfs'
    assert process.returncode == (result if permitted else 1)
    starts = [call for call in calls if 'start' in call]
    stops = [call for call in calls if 'stop' in call]
    assert len(starts) == len(stops) == (int(running == 'true') + int(payment == 'true') if permitted else 0)
    if running == 'false':
        assert not any(call[0] == 'docker' and 'start' in call for call in calls)
    if not permitted:
        assert not any(call[0] == 'python' and '-m' in call for call in calls)
