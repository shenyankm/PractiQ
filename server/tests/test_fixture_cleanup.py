import subprocess

import pytest

from tests import db_support, mq_support


@pytest.mark.parametrize('module,entrypoint,cache', [
    (db_support, 'test_uri', 'TEST_URI'),
    (mq_support, 'broker', 'URI'),
])
@pytest.mark.parametrize('failure', [subprocess.TimeoutExpired, subprocess.CalledProcessError])
def test_container_start_failure_retains_cleanup(monkeypatch, module, entrypoint, cache, failure):
    monkeypatch.setattr(module, cache, None)
    monkeypatch.setattr(module, 'CONTAINER', None)
    monkeypatch.setattr(mq_support, 'MANAGEMENT', None)
    for variable in ('TEST_DATABASE_URI', 'TEST_RABBITMQ_URI', 'TEST_RABBITMQ_MANAGEMENT_URL'):
        monkeypatch.delenv(variable, raising=False)
    callbacks, commands = [], []
    monkeypatch.setattr(module.atexit, 'register', callbacks.append)

    def run(command, **kwargs):
        commands.append(command)
        if command[1] == 'run':
            raise failure(command, 120) if failure is subprocess.TimeoutExpired else failure(1, command)
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(module.subprocess, 'run', run)
    with pytest.raises(failure):
        getattr(module, entrypoint)()
    assert len(callbacks) == 1
    callbacks[0]()
    assert commands[1] == ['docker', 'rm', '--force', commands[0][commands[0].index('--name') + 1]]
