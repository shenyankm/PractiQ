"""Exercise the privileged image receiver with fake Docker and HTTP commands."""

import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize('failure', ['', 'update', 'probe'])
def test_deploy_success_or_rollback(tmp_path, failure):
    config = tmp_path / 'config'
    config.mkdir()
    image_env = tmp_path / 'image.env'
    image_env.write_text('PRACTIQ_IMAGE=practiq-ai:previous\n')
    log = tmp_path / 'commands'
    bin_dir = tmp_path / 'bin'
    bin_dir.mkdir()
    commands = {
        'flock': 'exit 0',
        'curl': 'test "$FAILURE" != probe',
        'docker': '''echo "$*" >> "$COMMAND_LOG"
if [ "$1 $2" = 'image load' ]; then cat >/dev/null; fi
if [ "$FAILURE" = update ] && [ "$1" = compose ] && \
   echo "$*" | grep -q 'up -d' && grep -q "$REVISION" "$IMAGE_ENV"; then exit 1; fi
''',
    }
    for name, body in commands.items():
        executable = bin_dir / name
        executable.write_text('#!/bin/sh\n' + body + '\n')
        executable.chmod(0o755)
    source = (ROOT / 'server/deploy/deploy.sh').read_text()
    source = source.replace('/opt/practiq/config', str(config))
    source = source.replace('/etc/practiq/image.env', str(image_env))
    source = source.replace('/run/lock/practiq-deploy.lock', str(tmp_path / 'lock'))
    script = tmp_path / 'deploy.sh'
    script.write_text(source)
    revision = 'a' * 40
    env = {**os.environ, 'PATH': f'{bin_dir}:{os.environ["PATH"]}',
           'COMMAND_LOG': str(log), 'IMAGE_ENV': str(image_env),
           'REVISION': revision, 'FAILURE': failure}
    result = subprocess.run(['bash', str(script), f'deploy {revision}'], input=b'image', env=env, capture_output=True)
    assert (result.returncode == 0) == (failure == '')
    expected = 'previous' if failure else revision
    assert image_env.read_text() == f'PRACTIQ_IMAGE=practiq-ai:{expected}\n'
    assert log.read_text().count('up -d') == (2 if failure else 1)


@pytest.mark.parametrize('command', ['bash', 'deploy ../main', 'deploy ' + 'a' * 40 + '; id'])
def test_deploy_rejects_arbitrary_commands(command):
    result = subprocess.run(['bash', str(ROOT / 'server/deploy/deploy.sh'), command], capture_output=True)
    assert result.returncode == 64
