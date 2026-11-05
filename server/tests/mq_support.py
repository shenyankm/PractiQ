"""Disposable RabbitMQ vhosts; only integration fixtures call this module."""
import atexit
import os
import socket
import subprocess
import time
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit
from uuid import uuid4

import httpx

IMAGE = 'rabbitmq:4.3.6-management@sha256:8dd6e3570ddaa2ef82a6c3a8950e79c1f73893adfbdddbc374fc1f1ac8a0f5dd'
URI = None
MANAGEMENT = None
CONTAINER = None
PROMETHEUS = None
VHOSTS = []


def broker():
    global URI, MANAGEMENT, CONTAINER, PROMETHEUS
    if URI is not None:
        return URI, MANAGEMENT
    URI = os.environ.get('TEST_RABBITMQ_URI')
    MANAGEMENT = os.environ.get('TEST_RABBITMQ_MANAGEMENT_URL')
    PROMETHEUS = os.environ.get('TEST_RABBITMQ_PROMETHEUS_URL')
    if URI:
        if not MANAGEMENT:
            raise ValueError('TEST_RABBITMQ_MANAGEMENT_URL is required with TEST_RABBITMQ_URI')
        return URI, MANAGEMENT
    name = 'practiq-mq-tests-' + uuid4().hex
    CONTAINER = name
    def available_port():
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            return sock.getsockname()[1]
    amqp_port, management_port, metrics_port = (available_port() for _ in range(3))
    deploy = Path(__file__).parents[1] / 'deploy'
    atexit.register(lambda: subprocess.run(['docker', 'rm', '--force', name], capture_output=True, check=False, timeout=20))
    subprocess.run(['docker', 'run', '--detach', '--name', name, '--hostname', name,
                    '--publish', f'127.0.0.1:{amqp_port}:5672', '--publish', f'127.0.0.1:{management_port}:15672',
                    '--publish', f'127.0.0.1:{metrics_port}:15692',
                    '--mount', f'type=bind,source={deploy / "rabbitmq.conf"},target=/etc/rabbitmq/conf.d/20-practiq.conf,readonly',
                    '--mount', f'type=bind,source={deploy / "rabbitmq-enabled-plugins"},target=/etc/rabbitmq/enabled_plugins,readonly',
                    '--env', 'RABBITMQ_DEFAULT_USER=practiq-test', '--env', 'RABBITMQ_DEFAULT_PASS=practiq-test',
                    IMAGE], check=True, capture_output=True, timeout=120)
    def port(number):
        return subprocess.check_output(['docker', 'port', name, f'{number}/tcp'], text=True, timeout=10).strip().rsplit(':', 1)[1]
    URI = f'amqp://practiq-test:practiq-test@127.0.0.1:{port(5672)}/'
    MANAGEMENT = f'http://127.0.0.1:{port(15672)}'
    PROMETHEUS = f'http://127.0.0.1:{port(15692)}'
    deadline = time.monotonic() + 60
    while True:
        try:
            api('GET', '/api/overview')
            return URI, MANAGEMENT
        except (httpx.HTTPError, OSError):
            if time.monotonic() >= deadline:
                raise
            time.sleep(.2)


def api(method, path, data=None):
    uri, management = broker()
    url = urlsplit(uri)
    response = httpx.request(method, str(management) + path, auth=(url.username or '', url.password or ''),
                            json=data, trust_env=False, timeout=10)
    response.raise_for_status()
    return response


def new_vhost():
    uri, _ = broker()
    name = 'practiq_test_' + uuid4().hex
    api('PUT', '/api/vhosts/' + name, {})
    user = urlsplit(uri).username or ''
    api('PUT', '/api/permissions/' + name + '/' + quote(user, safe=''), {'configure': '.*', 'write': '.*', 'read': '.*'})
    VHOSTS.append(name)
    url = urlsplit(uri)
    return urlunsplit((url.scheme, url.netloc, '/' + name, '', ''))


def cleanup():
    while VHOSTS:
        api('DELETE', '/api/vhosts/' + VHOSTS.pop())
