import hashlib
import json
import os
import shutil
import subprocess
import tarfile
import time
from io import BytesIO
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4
from zipfile import ZipFile

import pytest

from scripts import service_backup

_native_pg = service_backup.pg


def image_fixture(path, *, oci=False):
    config = b'{"architecture":"arm64","os":"linux","config":{}}'
    digest = hashlib.sha256(config).hexdigest()
    entries = [('manifest.json', json.dumps([{'Config': digest + '.json'}]).encode()), (digest + '.json', config)]
    image_id = 'sha256:' + digest
    if oci:
        manifest = json.dumps({'schemaVersion': 2, 'config': {'digest': image_id}}).encode()
        manifest_hash = hashlib.sha256(manifest).hexdigest()
        index = json.dumps({'schemaVersion': 2, 'manifests': [{'digest': 'sha256:' + manifest_hash}]}).encode()
        index_hash = hashlib.sha256(index).hexdigest()
        image_id = 'sha256:' + index_hash
        entries.extend([('blobs/sha256/' + manifest_hash, manifest), ('blobs/sha256/' + index_hash, index),
                        ('index.json', json.dumps({'manifests': [{'digest': image_id}]}).encode())])
    with tarfile.open(path, 'w') as archive:
        for name, data in entries:
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            archive.addfile(entry, BytesIO(data))
    return image_id


@pytest.mark.parametrize('oci', [False, True])
def test_image_identity_supports_classic_docker_and_oci_indexes(tmp_path, oci):
    image = tmp_path / 'image.tar'
    image_id = image_fixture(image, oci=oci)
    service_backup.check_image(image, image_id)
    with pytest.raises((ValueError, KeyError)):
        service_backup.check_image(image, 'sha256:' + 'b' * 64)


def test_image_archive_rejects_a_corrupt_layer_even_when_config_id_matches(tmp_path):
    config = json.dumps({'rootfs': {'diff_ids': ['sha256:' + hashlib.sha256(b'original').hexdigest()]}}).encode()
    archive = tmp_path / 'corrupt-image.tar'
    with tarfile.open(archive, 'w') as output:
        for name, payload in [('manifest.json', b'[{"Config":"config.json","Layers":["layer.tar"]}]'),
                              ('config.json', config), ('layer.tar', b'corrupt')]:
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            output.addfile(info, BytesIO(payload))
    with pytest.raises(ValueError, match='layer checksum'):
        service_backup.check_image(archive, 'sha256:' + hashlib.sha256(config).hexdigest())


def test_bundle_rejects_corruption_extra_files_and_links_before_restore(tmp_path):
    bundle = tmp_path / 'bundle'
    bundle.mkdir()
    (bundle / 'database.dump').write_bytes(b'dump')
    (bundle / 'config.env').write_text('private fixture')
    (bundle / 'files').mkdir()
    (bundle / 'files/object').write_bytes(b'preserved')
    manifest = service_backup.manifest(bundle, image=image_fixture(bundle / 'image.tar'), snapshot=1)
    (bundle / 'manifest.json').write_text(json.dumps(manifest))
    assert service_backup.verify(bundle)['snapshotUnix'] == 1
    (bundle / 'files/object').write_bytes(b'corrupt')
    with pytest.raises(ValueError, match='checksum'):
        service_backup.verify(bundle)
    (bundle / 'files/object').write_bytes(b'preserved')
    (bundle / 'files/extra').write_bytes(b'unexpected')
    with pytest.raises(ValueError, match='inventory'):
        service_backup.verify(bundle)
    (bundle / 'files/extra').unlink()
    (bundle / 'files/link').symlink_to(tmp_path)
    with pytest.raises(ValueError, match='regular|symlink'):
        service_backup.verify(bundle)


def test_backup_metrics_preserve_last_success_when_attempt_fails(tmp_path):
    metrics = tmp_path / 'backup.prom'
    service_backup.metrics(metrics, success=True, snapshot=1792119000.125)
    service_backup.metrics(metrics, success=False)
    text = metrics.read_text()
    assert 'practiq_backup_last_success_timestamp_seconds 1792119000.125000\n' in text
    assert 'practiq_backup_last_attempt_success 0\n' in text
    assert 'private' not in text


def test_backup_destination_must_be_new_and_outside_storage(tmp_path):
    store = tmp_path / 'store'
    store.mkdir()
    with pytest.raises(ValueError, match='outside'):
        service_backup.destination(store / 'backup', store)
    outside = tmp_path / 'new'
    service_backup.destination(outside, store)
    assert outside.stat().st_mode & 0o777 == 0o700
    with pytest.raises(FileExistsError):
        service_backup.destination(outside, store)


@pytest.mark.parametrize('mismatch', [None, 'database', 'storage', 'image', 'mount', 'network', 'hostaddr', 'service', 'configuration', 'extra_setting'])
def test_deployment_preflight_matches_database_image_and_storage_without_leaking_secrets(tmp_path, monkeypatch, mismatch):
    storage = tmp_path / 'files'
    monkeypatch.setenv('AI_STORAGE_DIR', str(storage))
    monkeypatch.setenv('DATABASE_URI', 'postgresql://backup:fixture-secret@localhost/service')
    if mismatch == 'hostaddr':
        monkeypatch.setenv('PGHOSTADDR', '192.0.2.10')
    if mismatch == 'service':
        monkeypatch.setenv('PGSERVICE', 'unverified-profile')
    image = 'sha256:' + 'a' * 64
    deployed = {
        'Image': 'sha256:' + 'b' * 64 if mismatch == 'image' else image,
        'HostConfig': {'NetworkMode': 'bridge' if mismatch == 'network' else 'host'},
        'Config': {'Env': ['DATABASE_URI=postgresql://backup:fixture-secret@localhost/' + ('wrong' if mismatch == 'database' else 'service'),
                           'AI_STORAGE_DIR=/var/lib/practiq/files', 'LLM_MODEL=original']},
        'Mounts': [{'Type': 'volume' if mismatch == 'mount' else 'bind', 'Destination': '/var/lib/practiq',
                    'Source': str(tmp_path / 'wrong') if mismatch == 'storage' else str(tmp_path)}],
    }
    expected = dict(entry.split('=', 1) for entry in deployed['Config']['Env'])
    if mismatch == 'configuration':
        expected['LLM_MODEL'] = 'edited-after-startup'
    if mismatch == 'extra_setting':
        deployed['Config']['Env'].append('AI_SOURCE_MAX_BYTES=1048576')
    recorded = []
    def inspect(argv, **options):
        recorded.append(argv)
        value = {'services': {'ai': {'environment': expected}}} if 'compose' in argv else [{'Config': {'Env': []}}] if 'image' in argv else [deployed]
        return subprocess.CompletedProcess(argv, 0, stdout=json.dumps(value))
    monkeypatch.setattr(service_backup.subprocess, 'run', inspect)
    if mismatch is None:
        service_backup.check_deployment('container', image, tmp_path)
    else:
        with pytest.raises(RuntimeError, match='deployed') as error:
            service_backup.check_deployment('container', image, tmp_path)
        assert 'fixture-secret' not in str(error.value) and 'postgresql://' not in str(error.value)
    assert recorded[0] == ['docker', 'inspect', 'container']
    assert all('fixture-secret' not in part for call in recorded for part in call)



@pytest.mark.parametrize('mismatch', [None, 'path', 'override', 'stale', 'extra', 'stopped', 'database', 'hostaddr', 'port', 'service', 'matching_libpq'])
def test_checkout_preflight_verifies_unit_file_and_running_environment(tmp_path, monkeypatch, mismatch):
    monkeypatch.setenv('DATABASE_URI', 'postgresql://backup:fixture-secret@localhost/' + ('wrong' if mismatch == 'database' else 'service'))
    config = tmp_path / 'payments.env'
    config.write_text('DATABASE_URI=postgresql://backup:fixture-secret@localhost/service\nPAYMENT_APP_ID=original\n')
    properties = {'EnvironmentFiles': str(config) + ' (ignore_errors=no)', 'Environment': '',
                  'PassEnvironment': '', 'UnsetEnvironment': '', 'MainPID': '0' if mismatch == 'stopped' else '4242'}
    if mismatch == 'path':
        properties['EnvironmentFiles'] = '/different/payments.env (ignore_errors=no)'
    if mismatch == 'override':
        properties['Environment'] = 'PAYMENT_APP_ID=overridden'
    environment = b'DATABASE_URI=postgresql://backup:fixture-secret@localhost/service\0PAYMENT_APP_ID=' + (b'stale' if mismatch == 'stale' else b'original') + b'\0'
    if mismatch == 'extra':
        environment += b'PAYMENT_SELLER_ID=unrecorded\0'
    extra = {'hostaddr': ('PGHOSTADDR', '192.0.2.10'), 'port': ('PGPORT', '5433'), 'service': ('PGSERVICE', 'unverified'), 'matching_libpq': ('PGHOSTADDR', '192.0.2.10')}.get(mismatch)
    if extra:
        key, value = extra
        config.write_text(config.read_text() + key + '=' + value + '\n')
        environment += (key + '=' + value + '\0').encode()
        if mismatch == 'matching_libpq':
            monkeypatch.setenv(key, value)
    original = type(config).read_bytes
    monkeypatch.setattr(type(config), 'read_bytes', lambda path: environment if str(path) == '/proc/4242/environ' else original(path))
    calls = []
    def show(argv, **options):
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, stdout='\n'.join(key + '=' + value for key, value in properties.items()))
    monkeypatch.setattr(service_backup.subprocess, 'run', show)
    if mismatch in {None, 'stopped', 'matching_libpq'}:
        service_backup.check_checkout('checkout.service', config)
    else:
        with pytest.raises(RuntimeError, match='checkout') as error:
            service_backup.check_checkout('checkout.service', config)
        assert 'fixture-secret' not in str(error.value)
    assert len(calls) == 1 and calls[0][:3] == ['systemctl', 'show', 'checkout.service']


def test_pg_tools_keep_passwords_out_of_argv_and_preserve_tls(monkeypatch):
    monkeypatch.setenv('PGHOSTADDR', '192.0.2.10')
    monkeypatch.setenv('PGSSLROOTCERT', '/private/ca.pem')
    recorded = []
    monkeypatch.setattr(service_backup.subprocess, 'run', lambda argv, **kwargs: recorded.append((argv, kwargs)))
    service_backup.pg('pg_dump', 'postgresql://backup:private%20password@db.example/service?sslmode=verify-full', '--format=custom')
    argv, options = recorded[0]
    assert argv == ['pg_dump', '--format=custom']
    assert options['env']['PGPASSWORD'] == 'private password'
    assert options['env']['PGDATABASE'] == 'service'
    assert options['env']['PGSSLMODE'] == 'verify-full'
    assert options['env']['PGHOST'] == 'db.example'
    assert options['env']['PGHOSTADDR'] == '192.0.2.10'
    assert options['env']['PGSSLROOTCERT'] == '/private/ca.pem'


def test_failed_pg_command_sanitizes_driver_diagnostics():
    # PostgreSQL command failures carry no URI, password or raw driver stderr.
    from unittest.mock import patch
    with patch.object(service_backup.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, ['pg_dump'], stderr=b'raw-fixture-secret')), pytest.raises(RuntimeError, match='PostgreSQL backup/restore') as error:
        service_backup.pg('pg_dump', 'postgresql://backup:secret@localhost/service')
    assert 'raw-fixture-secret' not in str(error.value) and 'secret' not in str(error.value)


@pytest.mark.usefixtures('disposable_databases')
async def test_failed_dump_preserves_original_files_without_publishing_success(tmp_path, monkeypatch):
    from practiq_ai.config import load
    from tests.db_support import new_database
    db = await new_database()
    root = load().storage_dir
    root.mkdir()
    (root / 'original').write_bytes(b'preserve')
    config = tmp_path / 'private.env'
    config.write_text('private fixture')
    image = tmp_path / 'image.tar'
    image_id = image_fixture(image)
    monkeypatch.setenv('AI_MAINTENANCE_MODE', 'true')
    monkeypatch.setattr(service_backup, 'pg', lambda *_: (_ for _ in ()).throw(OSError('disk full')))
    with pytest.raises(OSError):
        await service_backup.backup(db, tmp_path / 'failed', config, image_id, image_archive=image)
    assert not (tmp_path / 'failed/manifest.json').exists()
    assert (root / 'original').read_bytes() == b'preserve'
    for slot in (1, 3):
        owner = await db.acquire(slot=slot)
        await owner.close()


@pytest.mark.usefixtures('disposable_databases')
@pytest.mark.parametrize('ddl', ["CREATE TYPE retained AS ENUM ('preserve')", 'CREATE SCHEMA retained'])
async def test_restore_refuses_targets_with_only_types_or_schemas(tmp_path, monkeypatch, ddl):
    from tests.db_support import new_database
    db = await new_database(initialize=False)
    async with db.connection() as conn:
        await conn.execute(ddl)
    monkeypatch.setenv('AI_MAINTENANCE_MODE', 'true')
    monkeypatch.setattr(service_backup, 'verify', lambda _: {'files': {}})
    with pytest.raises(ValueError, match='empty dedicated'):
        await service_backup.restore(db, tmp_path / 'bundle', tmp_path / 'target')
    assert not (tmp_path / 'target').exists()


@pytest.mark.usefixtures('disposable_databases')
async def test_backup_refuses_live_ai_or_payment_owner_before_writing(tmp_path, monkeypatch):
    from tests.db_support import new_database
    db = await new_database()
    monkeypatch.setenv('AI_MAINTENANCE_MODE', 'true')
    for slot in (1, 3):
        owner = await db.acquire(slot=slot)
        try:
            with pytest.raises(RuntimeError, match='Stop'):
                await service_backup.backup(db, tmp_path / 'bundle', tmp_path / 'config.env', 'sha256:' + 'a' * 64)
            assert not (tmp_path / 'bundle').exists()
        finally:
            await owner.close()


def pg_tool(tool, uri, *arguments):
    """Use the same PostgreSQL-16 client on hosts without native PG tools."""
    from tests import db_support
    container = db_support.CONTAINER or os.environ.get('TEST_POSTGRES_CONTAINER')
    if not container:
        return _native_pg(tool, uri, *arguments)
    from pathlib import Path
    url = urlsplit(uri)
    if url.hostname not in {'127.0.0.1', 'localhost'}:
        raise RuntimeError('Configure native PostgreSQL tools for remote test databases')
    uri = urlunsplit((url.scheme, url.netloc.rsplit(':', 1)[0] + ':5432', url.path, url.query, ''))
    args = list(arguments)
    environment = service_backup.pg_environment(uri)
    command = ['docker', 'exec', '-i']
    for key in environment:
        if key.startswith('PG'):
            command.extend(['--env', key])
    command.extend([container, tool])
    if tool == 'pg_dump':
        output = Path(args[args.index('--file') + 1])
        del args[args.index('--file'):]
        with output.open('xb') as stream:
            result = subprocess.run([*command, *args], stdout=stream, stderr=subprocess.PIPE,
                                    env=environment, check=False, timeout=60)
            assert result.returncode == 0, result.stderr.decode()
    else:
        source = Path(args.pop())
        with source.open('rb') as stream:
            result = subprocess.run([*command, *args], stdin=stream, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.PIPE, env=environment, check=False, timeout=60)
            assert result.returncode == 0, result.stderr.decode()


@pytest.mark.usefixtures('disposable_databases')
async def test_full_backup_restore_preserves_accounts_checkpoints_files_and_readonly_export(tmp_path, monkeypatch):
    import httpx
    from psycopg import sql

    from practiq_ai import execution, payments, runtime, saas, storage, task_api, webapp
    from practiq_ai.contracts import DocumentTaskControl, DocumentTaskCreate
    from practiq_ai.graphs import document
    from tests.db_support import SERVICES, new_database, seed_account, setup_api
    from tests.support import object_store, upload

    monkeypatch.setenv('AI_INPUT_POINTS_PER_1K', '1')
    monkeypatch.setenv('AI_OUTPUT_POINTS_PER_1K', '1')
    service, _, model = await setup_api(monkeypatch)
    root = storage.load().storage_dir
    files = object_store(root)
    for module in (runtime, task_api, execution, webapp, storage, document):
        monkeypatch.setattr(module, 'get_object_store', lambda: files)
    source = await files.put_document(b'1. First', upload(b'1. First'))
    credential = await seed_account(service.db)
    account = await saas.identity('13800138000', credential)
    token = saas.ACCOUNT.set(account)
    try:
        await saas.store_upload(files, b'1. First', upload(b'1. First'))
        receipt = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=source))
        await service.wait_idle()
        async with service.delivery_lock:
            paused = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=source))
            await task_api.control_task(paused['threadId'], DocumentTaskControl(requestId=uuid4(), action='pause', runId=paused['runId']))
        await service.wait_idle()
        assert (await task_api.get_task(paused['threadId']))['state'] == 'PAUSED'
    finally:
        saas.ACCOUNT.reset(token)
    assert len(model.calls) == 1
    await service.stop(timeout=0)
    # Include optional archived/active payment tables without contacting a gateway.
    async with service.db.connection() as conn:
        await conn.execute(payments.DDL, prepare=False)
        await conn.execute("INSERT INTO payment_schema VALUES (3,'test-merchant')")
        await conn.execute("INSERT INTO import_products VALUES ('pack','Points',100,'https://checkout.example/purchase',true)")
        await conn.execute("INSERT INTO payment_products VALUES ('pack',100,true)")
        await conn.execute("INSERT INTO payment_orders(order_id,account_id,request_id,product_id,name,price_cents,points,status,paid_at,expires_at,refund_evidence) VALUES ('order-fixture',%s,'request-fixture','pack','Points',100,100,'paid',now(),now()+interval '1 day','{\"refund_fee\":\"1.00\"}')", (account,))
        await conn.execute("INSERT INTO import_calls(call_key,account_id,thread_id,rates,status,dispatched) VALUES ('unknown-fixture',%s,'retained-task','{\"inputMicropointsPer1k\":1,\"outputMicropointsPer1k\":1}','unknown',true)", (account,))
        await conn.execute("INSERT INTO grades VALUES ('grade-fixture','digest','{\"status\":\"unknown\"}')")
        await conn.execute("INSERT INTO grade_calls(grade_id,call_key,record) VALUES ('grade-fixture','call-fixture','{\"usageStatus\":\"unknown\"}')")
    async def rows(db):
        result = {}
        for item in await db.rows("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"):
            async with db.connection() as conn:
                records = await (await conn.execute(sql.SQL('SELECT row_to_json(t)::text AS value FROM {} t ORDER BY row_to_json(t)::text').format(sql.Identifier(item['tablename'])))).fetchall()
                result[item['tablename']] = [row['value'] for row in records]
        return result
    before = await rows(service.db)
    sequence = await service.db.rows('SELECT last_value,is_called FROM grade_calls_sequence_seq')
    config = tmp_path / 'private.env'
    config.write_text('AI_SERVICE_TOKEN=private-fixture\n')
    bundle = tmp_path / 'bundle'
    monkeypatch.setattr(service_backup, 'pg', pg_tool)
    monkeypatch.setenv('AI_MAINTENANCE_MODE', 'true')
    image_path = tmp_path / 'image.tar'
    value = await service_backup.backup(service.db, bundle, config, image_fixture(image_path), image_archive=image_path)
    assert value['files'] and (bundle / 'config.env').stat().st_mode & 0o777 == 0o600
    # Source is no longer available for reads: restore uses the bundle alone.
    shutil.rmtree(root)
    target = await new_database(initialize=False)
    restored = tmp_path / 'restored'
    started = time.monotonic()
    await service_backup.restore(target, bundle, restored)
    elapsed = time.monotonic() - started
    assert await rows(target) == before
    assert await target.rows('SELECT last_value,is_called FROM grade_calls_sequence_seq') == sequence
    with pytest.raises(ValueError, match='empty'):
        await service_backup.restore(target, bundle, tmp_path / 'second-restore')
    with pytest.raises(ValueError, match='checksum'):
        (bundle / 'config.env').write_text('tampered')
        await service_backup.restore(await new_database(initialize=False), bundle, tmp_path / 'corrupt-restore')
    monkeypatch.setenv('AI_STORAGE_DIR', str(restored / 'files'))
    monkeypatch.setenv('AI_READ_ONLY', '1')
    monkeypatch.setenv('AI_MAINTENANCE_MODE', 'false')
    restored_files = object_store(restored / 'files')
    for module in (runtime, task_api, execution, webapp, storage, document):
        monkeypatch.setattr(module, 'get_object_store', lambda: restored_files)
    recovered = runtime.Service(target)
    await recovered.start()
    SERVICES.append(recovered)
    monkeypatch.setattr(runtime, 'current', recovered)
    assert await recovered.ready()
    assert await saas.identity('13800138000', credential, database=target) == account
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webapp.app), base_url='http://test',
                                 headers={'Authorization': 'Account ' + credential, 'X-Practiq-Phone': '13800138000'}) as client:
        detail = (await client.get('/api/document-tasks/' + receipt['threadId'])).json()
        exported = await client.get('/api/document-tasks/' + receipt['threadId'] + '/export', params={'checkpoint_id': detail['checkpointId']})
        assert exported.status_code == 200
        with ZipFile(BytesIO(exported.content)) as archive:
            assert archive.testzip() is None
        assert (await client.get('/api/account')).status_code == 200
        assert (await client.get('/api/document-tasks/' + paused['threadId'])).json()['state'] == 'PAUSED'
    assert await rows(target) == before and len(model.calls) == 1
    print(json.dumps({'tables': len(before), 'rows': sum(map(len, before.values())), 'restoreSeconds': elapsed,
                      'readyExportSeconds': time.monotonic() - started,
                      'snapshotAgeSeconds': time.time() - value['snapshotUnix'],
                      'fileInventorySha256': hashlib.sha256(json.dumps(value['files'], sort_keys=True).encode()).hexdigest()}))
