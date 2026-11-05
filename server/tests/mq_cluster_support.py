"""Only explicitly requested cluster tests create this uniquely named disposable deployment."""

import os
import subprocess
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx


class Cluster:
    def __init__(self):
        self.project = 'practiq-mq-cluster-test-' + uuid4().hex
        self.password = uuid4().hex
        self.env = {**os.environ, 'RABBITMQ_ADMIN_USER': 'cluster-test', 'RABBITMQ_ADMIN_PASSWORD': self.password,
                    'RABBITMQ_CLUSTER_COOKIE': uuid4().hex}
        for node in range(1, 4):
            for port in ('AMQP', 'MANAGEMENT', 'METRICS'):
                self.env[f'RABBITMQ_NODE{node}_{port}_PORT'] = '0'
        self.command = ['docker', 'compose', '--env-file', os.devnull, '--project-name', self.project,
                        '--file', str(Path(__file__).parents[1] / 'deploy/rabbitmq-cluster.compose.yml')]
        self.management: list[str] = []

    def compose(self, *args):
        return subprocess.check_output([*self.command, *args], env=self.env, text=True, stderr=subprocess.PIPE, timeout=180).strip()

    def port(self, node, port):
        return self.compose('port', f'rabbitmq-{node}', str(port)).rsplit(':', 1)[1]

    def uri(self, node, vhost):
        return f'amqp://cluster-test:{self.password}@127.0.0.1:{self.port(node, 5672)}/{vhost}'

    def api(self, method, path, data=None) -> Any:
        for endpoint in self.management:
            try:
                response = httpx.request(method, endpoint + path, auth=('cluster-test', self.password), json=data, trust_env=False, timeout=5)
                response.raise_for_status()
                return response.json() if response.content else None
            except httpx.TransportError:
                continue
        raise RuntimeError('No disposable cluster management endpoint is reachable')


@contextmanager
def cluster():
    instance = Cluster()
    try:
        instance.compose('up', '--detach', '--wait', '--wait-timeout', '120')
        instance.management = [f'http://127.0.0.1:{instance.port(node, 15672)}' for node in range(1, 4)]
        deadline = time.monotonic() + 60
        while True:
            nodes = instance.api('GET', '/api/nodes')
            if len(nodes) == 3 and all(node['running'] for node in nodes):
                break
            if time.monotonic() >= deadline:
                raise TimeoutError('Disposable RabbitMQ cluster did not form')
            time.sleep(.2)
        yield instance
    finally:
        instance.compose('down', '--volumes', '--remove-orphans')
