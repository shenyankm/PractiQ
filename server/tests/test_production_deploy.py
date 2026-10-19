"""Exercise the privileged image receiver with fake Docker and HTTP commands."""

import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize('failure', ['', 'update', 'probe', 'hup', 'int', 'term'])
@pytest.mark.parametrize('same_tag', [False, True])
def test_deploy_success_or_rollback(tmp_path, failure, same_tag):
    config = tmp_path / 'config'
    config.mkdir()
    image_env = tmp_path / 'image.env'
    revision = 'a' * 40
    old_image = 'sha256:' + '1' * 64
    new_image = 'sha256:' + '2' * 64
    image_env.write_text(f'PRACTIQ_IMAGE=practiq-ai:{revision if same_tag else "previous"}\n')
    log = tmp_path / 'commands'
    bin_dir = tmp_path / 'bin'
    bin_dir.mkdir()
    commands = {
        'flock': 'exit 0',
        'curl': '''case "$FAILURE" in
hup) kill -HUP "$PPID"; exit 1;;
int) kill -INT "$PPID"; exit 1;;
term) kill -TERM "$PPID"; exit 1;;
probe) exit 1;;
esac''',
        'docker': '''echo "$*" >> "$COMMAND_LOG"
if [ "$1 $2" = 'image load' ]; then cat >/dev/null; touch "$LOADED"; fi
if [ "$1 $2" = 'image inspect' ]; then
    if [ -f "$LOADED" ]; then echo "$NEW_IMAGE"; else echo "$OLD_IMAGE"; fi
fi
if [ "$FAILURE" = update ] && [ "$1" = compose ] && \
   echo "$*" | grep -q 'up -d' && grep -q "$NEW_IMAGE" "$IMAGE_ENV"; then exit 1; fi
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
    env = {**os.environ, 'PATH': f'{bin_dir}:{os.environ["PATH"]}',
           'COMMAND_LOG': str(log), 'IMAGE_ENV': str(image_env),
           'LOADED': str(tmp_path / 'loaded'), 'OLD_IMAGE': old_image,
           'NEW_IMAGE': new_image, 'FAILURE': failure}
    result = subprocess.run(['bash', str(script), f'deploy {revision}'], input=b'image', env=env, capture_output=True, check=False)
    assert (result.returncode == 0) == (failure == '')
    if failure in {'hup', 'int', 'term'}:
        assert result.returncode == {'hup': 129, 'int': 130, 'term': 143}[failure]
    expected = old_image if failure else new_image
    assert image_env.read_text() == f'PRACTIQ_IMAGE={expected}\n'
    assert image_env.stat().st_mode & 0o777 == 0o600
    assert log.read_text().count('up -d') == (2 if failure else 1)


@pytest.mark.parametrize('command', ['bash', 'deploy ../main', 'deploy ' + 'a' * 40 + '; id'])
def test_deploy_rejects_arbitrary_commands(command):
    result = subprocess.run(['bash', str(ROOT / 'server/deploy/deploy.sh'), command], capture_output=True, check=False)
    assert result.returncode == 64
