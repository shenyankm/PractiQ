import json
import os
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.parametrize('running,payment,filesystem,result,invalid', [
    ('true', 'false', 'nfs', 1, None),
    ('false', 'false', 'nfs', 0, None),
    ('true', 'true', 'nfs', 1, None),
    ('true', 'true', 'ext4', 0, None),
    ('true', 'true', 'nfs', 0, 'unit_only'),
    ('true', 'true', 'nfs', 0, 'config_only'),
    ('true', 'false', 'nfs', 0, 'database'),
    ('true', 'false', 'nfs', 0, 'storage'),
])
def test_backup_scheduler_preserves_stopped_services_and_recovers_after_failure(tmp_path, running, payment, filesystem, result, invalid):
    (tmp_path / 'server').mkdir()
    (tmp_path / '.env').write_text('DATABASE_URI=postgresql://backup:fixture@localhost/service\nAI_STORAGE_DIR=/wrong/env-file-path\nAI_MAINTENANCE_MODE=false\n')
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
if name=='docker' and args==['inspect','container']: print(os.environ['DEPLOYED_CONTAINER'])
if name=='findmnt': print(os.environ['FILESYSTEM'])
if name=='systemctl' and 'is-active' in args: sys.exit(0 if os.environ['PAYMENT_RUNNING']=='true' else 1)
if name=='python' and args[:2]==['-m','dotenv']:
    os.execv(sys.executable,[sys.executable,*args])
if name=='python' and args[:1]==['-c'] and 'check_deployment' in args[1]:
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
        'PYTHONPATH': str(Path(__file__).parents[1]) + os.pathsep + os.environ.get('PYTHONPATH', ''),
    }
    environment.pop('DATABASE_URI', None)
    if invalid == 'unit_only':
        environment.pop('PRACTIQ_BACKUP_PAYMENT_CONFIG')
    if invalid == 'config_only':
        environment.pop('PRACTIQ_PAYMENT_UNIT')
    environment['DEPLOYED_CONTAINER'] = json.dumps([{
        'Image': environment['PRACTIQ_BACKUP_IMAGE_ID'],
        'HostConfig': {'NetworkMode': 'host'},
        'Config': {'Env': ['DATABASE_URI=postgresql://backup:fixture@localhost/' + ('wrong' if invalid == 'database' else 'service'),
                           'AI_STORAGE_DIR=/var/lib/practiq']},
        'Mounts': [{'Type': 'bind', 'Destination': '/var/lib/practiq',
                    'Source': '/wrong/storage' if invalid == 'storage' else '/private/storage'}],
    }])
    script = Path(__file__).parents[1] / 'deploy/backup-offline.sh'
    process = subprocess.run(['/bin/sh', str(script)], env=environment, capture_output=True, timeout=10, check=False)
    calls = [json.loads(line) for line in log.read_text().splitlines()]
    permitted = filesystem == 'nfs' and invalid is None
    assert process.returncode == (result if permitted else 1)
    starts = [call for call in calls if 'start' in call]
    stops = [call for call in calls if 'stop' in call]
    assert len(starts) == len(stops) == (int(running == 'true') + int(payment == 'true') if permitted else 0)
    if running == 'false':
        assert not any(call[0] == 'docker' and 'start' in call for call in calls)
    if not permitted:
        assert not any(call[0] == 'python' and 'scripts.service_backup' in call for call in calls)
    for call in calls:
        if call[:2] == ['docker', 'compose']:
            assert call[call.index('--env-file') + 1] == str(tmp_path / '.env')
