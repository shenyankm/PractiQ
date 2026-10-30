import json
import os
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.parametrize('running,filesystem,result,invalid', [
    ('true', 'nfs', 0, None),
    ('true', 'nfs', 1, None),
    ('false', 'nfs', 0, None),
    ('true', 'ext4', 0, None),
    ('true', 'nfs', 0, 'database'),
    ('true', 'nfs', 0, 'storage'),
    ('true', 'nfs', 0, 'restart_ai'),
    ('true', 'nfs', 0, 'not_ready'),
    ('false', 'nfs', 0, 'not_ready'),
])
def test_backup_scheduler_preserves_stopped_services_and_recovers_after_failure(tmp_path, running, filesystem, result, invalid):
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
if name=='docker' and args[:2]==['image','inspect']: print(json.dumps([dict(Config=dict(Env=[]))]))
if name=='docker' and 'config' in args: print(os.environ['COMPOSE_CONFIG'])
if 'start' in args and os.environ['INVALID']=='restart_ai': sys.exit(1)
if 'start' in args and '--wait' in args and os.environ['INVALID']=='not_ready': sys.exit(1)
if name=='findmnt': print(os.environ['FILESYSTEM'])
if name=='python' and args[:2]==['-m','dotenv']:
    os.execv(sys.executable,[sys.executable,*args])
if name=='python' and args[:1]==['-c'] and ('check_deployment' in args[1] or 'metrics' in args[1]):
    os.execv(sys.executable,[sys.executable,*args])
if name=='python' and args[:2]==['-m','scripts.service_backup']:
    assert os.environ['AI_STORAGE_DIR']=='/private/storage'
    assert os.environ['AI_MAINTENANCE_MODE']=='true'
    from scripts.service_backup import metrics
    metrics(Path(os.environ['PRACTIQ_BACKUP_METRICS']),success=os.environ['DUMP_RESULT']=='0',snapshot=123)
    sys.exit(int(os.environ['DUMP_RESULT']))
'''
    for name in ('python', 'docker', 'findmnt', 'mountpoint'):
        file = commands / name
        file.write_text(program)
        file.chmod(0o755)
    environment = os.environ | {
        'PATH': str(commands) + os.pathsep + os.environ['PATH'], 'COMMAND_LOG': str(log),
        'PRACTIQ_PROJECT_DIR': str(tmp_path), 'PRACTIQ_STORAGE_DIR': '/private/storage',
        'PRACTIQ_BACKUP_ROOT': '/mounted/offhost', 'PRACTIQ_BACKUP_IMAGE_ARCHIVE': '/private/image.tar',
        'PRACTIQ_BACKUP_IMAGE_ID': 'sha256:' + 'a' * 64, 'PRACTIQ_BACKUP_PYTHON': str(commands / 'python'),
        'PRACTIQ_BACKUP_METRICS': str(tmp_path / 'backup.prom'), 'AI_RUNNING': running,
        'FILESYSTEM': filesystem, 'DUMP_RESULT': str(result),
        'PYTHONPATH': os.pathsep.join((str(Path(__file__).parents[1]), str(Path(__file__).parents[1] / 'src'), os.environ.get('PYTHONPATH', ''))),
    }
    environment['INVALID'] = invalid or ''
    environment.pop('DATABASE_URI', None)
    environment['DEPLOYED_CONTAINER'] = json.dumps([{
        'Image': environment['PRACTIQ_BACKUP_IMAGE_ID'],
        'HostConfig': {'NetworkMode': 'host'},
        'Config': {'Env': ['DATABASE_URI=postgresql://backup:fixture@localhost/' + ('wrong' if invalid == 'database' else 'service'),
                           'AI_STORAGE_DIR=/var/lib/practiq']},
        'Mounts': [{'Type': 'bind', 'Destination': '/var/lib/practiq',
                    'Source': '/wrong/storage' if invalid == 'storage' else '/private/storage'}],
    }])
    deployed = json.loads(environment['DEPLOYED_CONTAINER'])[0]
    environment['COMPOSE_CONFIG'] = json.dumps({'services': {'ai': {'environment': dict(entry.split('=',1) for entry in deployed['Config']['Env'])}}})
    script = Path(__file__).parents[1] / 'deploy/backup-offline.sh'
    process = subprocess.run(['/bin/sh', str(script)], env=environment, capture_output=True, timeout=10, check=False)
    calls = [json.loads(line) for line in log.read_text().splitlines()]
    permitted = filesystem == 'nfs' and invalid in {None, 'restart_ai', 'not_ready'}
    failed = not permitted or result or invalid == 'restart_ai' or (invalid == 'not_ready' and running == 'true')
    assert process.returncode == int(bool(failed))
    assert f'practiq_backup_last_attempt_success {int(not failed)}\n' in (tmp_path / 'backup.prom').read_text()
    starts = [call for call in calls if 'start' in call]
    stops = [call for call in calls if 'stop' in call]
    assert len(starts) == len(stops) == (int(running == 'true') if permitted else 0)
    for call in starts:
        assert call[call.index('start'):] == ['start', '--wait', '--wait-timeout', '90', 'ai']
    if permitted and not result:
        assert 'practiq_backup_last_success_timestamp_seconds 123.000000\n' in (tmp_path / 'backup.prom').read_text()
    if running == 'false':
        assert not any(call[0] == 'docker' and 'start' in call for call in calls)
    if not permitted:
        assert not any(call[0] == 'python' and 'scripts.service_backup' in call for call in calls)
    for call in calls:
        if call[:2] == ['docker', 'compose']:
            assert call[call.index('--env-file') + 1] == str(tmp_path / '.env')
