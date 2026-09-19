"""Exercise the shared storage contract with an offline OSS SDK substitute."""

from dataclasses import replace
from types import SimpleNamespace

import alibabacloud_oss_v2 as oss
import pytest
from httpx import ASGITransport, AsyncClient

from practiq_ai import storage, webapp
from practiq_ai.config import load
from practiq_ai.errors import DocumentProcessingError
from tests.support import upload


class Body:
    def __init__(self, payload):
        self.payload = payload
        self.closed = False

    def iter_bytes(self, **kwargs):
        yield self.payload

    def close(self):
        self.closed = True


class Client:
    def __init__(self, cfg):
        self.cfg = cfg
        self.objects = {}
        self.body = None

    def head_object(self, request):
        assert request.bucket == 'test-bucket'
        if request.key not in self.objects:
            raise oss.exceptions.OperationError(name='HeadObject', error=oss.exceptions.ServiceError(status_code=404, code='NoSuchKey', message='', request_id='', ec='', timestamp='', request_target=''))
        return oss.HeadObjectResult(content_length=len(self.objects[request.key]))

    def put_object(self, request):
        self.objects[request.key] = request.body

    def get_object(self, request):
        self.body = Body(self.objects[request.key])
        return SimpleNamespace(body=self.body)


@pytest.fixture
def store(monkeypatch):
    monkeypatch.setattr(storage.oss, 'Client', Client)
    return storage.OSSObjectStore(replace(load(), storage_backend='oss',
        oss_region='cn-hangzhou', oss_bucket='test-bucket',
        oss_access_key_id='fake-id', oss_access_key_secret='fake-secret'))


async def test_oss_upload_download_and_shared_validation(store, monkeypatch):
    monkeypatch.setattr(webapp, 'get_object_store', lambda: store)
    assert store.client.cfg.retry_max_attempts == 1
    async with AsyncClient(transport=ASGITransport(app=webapp.app), base_url='http://test',
                           headers={'Authorization': 'Bearer test-token'}) as client:
        prepared = await client.post('/api/uploads', json=upload().model_dump())
        assert prepared.status_code == 201
        url = prepared.json()['upload']['url']
        assert url.startswith('/api/uploads/content?')
        assert 'fake-secret' not in prepared.text
        assert (await client.put(url, content=b'wrong')).status_code == 413
        assert (await client.put(url, content=b'oops')).status_code == 409
        response = await client.put(url, content=b'quiz')
        assert response.status_code == 200
        assert (await client.post('/api/uploads', json=upload().model_dump())).json()['upload'] is None
        artifact = await store.put_artifact(b'text', source_sha256=upload().sha256,
                                          kind='chunk', index=0, media_type='text/plain')
        response = await client.post('/api/artifacts/read', json=artifact.model_dump())
        assert response.status_code == 200 and response.content == b'text'
        assert store.client.body.closed
        forged = artifact.model_copy(update={'objectKey': '../private'})
        with pytest.raises(DocumentProcessingError, match='namespace'):
            await store.get_verified(forged)
        store.client.objects[artifact.objectKey] = b'oops'
        with pytest.raises(DocumentProcessingError, match='checksum'):
            await store.get_verified(artifact)
        store.client.objects[artifact.objectKey] = b'larger'
        with pytest.raises(DocumentProcessingError, match='size'):
            await store.get_verified(artifact)
        del store.client.objects[artifact.objectKey]
        with pytest.raises(DocumentProcessingError) as error:
            await store.get_verified(artifact)
        assert error.value.code == 'OBJECT_NOT_FOUND'


@pytest.mark.parametrize('status,code', [(403, 'AccessDenied'), (404, 'NoSuchBucket'), (500, 'InternalError')])
async def test_oss_failures_are_not_missing_objects(store, monkeypatch, status, code):
    def fail(request):
        raise oss.exceptions.OperationError(name='HeadObject', error=oss.exceptions.ServiceError(status_code=status, code=code, message='private detail', request_id='', ec='', timestamp='', request_target=''))
    monkeypatch.setattr(store.client, 'head_object', fail)
    with pytest.raises(DocumentProcessingError) as error:
        await store.prepare_document(upload())
    assert error.value.code == 'OBJECT_STORE_UNAVAILABLE'
    assert 'private detail' not in str(error.value)


async def test_oss_stream_is_bounded_and_closed(store, monkeypatch):
    ref = await store.put_document(b'quiz', upload())
    # Object grows between HEAD and GET; do not buffer beyond declared size.
    monkeypatch.setattr(store.client, 'head_object', lambda _: oss.HeadObjectResult(content_length=4))
    store.client.objects[ref.objectKey] = b'quizzes'
    with pytest.raises(DocumentProcessingError, match='size'):
        await store.get_verified(ref)
    assert store.client.body.closed


async def test_oss_write_and_timeout_failures(store, monkeypatch):
    def fail(request):
        raise TimeoutError('connection timed out')
    monkeypatch.setattr(store.client, 'put_object', fail)
    with pytest.raises(DocumentProcessingError) as error:
        await store.put_document(b'quiz', upload())
    assert error.value.code == 'OBJECT_STORE_UNAVAILABLE'
    assert not store.client.objects


def test_storage_selection(monkeypatch, tmp_path):
    monkeypatch.setattr(storage.oss, 'Client', Client)
    cfg = replace(load(), storage_dir=tmp_path)
    try:
        for mode, expected in [('local', storage.ObjectStore), ('oss', storage.OSSObjectStore)]:
            storage.get_object_store.cache_clear()
            monkeypatch.setattr(storage, 'load', lambda mode=mode: replace(cfg, storage_backend=mode))
            assert type(storage.get_object_store()) is expected
    finally:
        storage.get_object_store.cache_clear()


async def test_real_sdk_signs_and_transfers_without_network(monkeypatch):
    import base64
    from urllib.parse import unquote, urlsplit

    import requests

    objects = {}
    methods = []

    def send(session, request, **kwargs):
        assert request.headers['Authorization'].startswith('OSS4-HMAC-SHA256')
        assert request.headers['x-oss-security-token'] == 'test-sts-token'
        assert urlsplit(request.url).hostname == 'test-bucket.oss-cn-hangzhou.aliyuncs.com'
        methods.append(request.method)
        key = unquote(urlsplit(request.url).path.lstrip('/'))
        response = requests.Response()
        response.request = request
        response.headers["Date"] = "Fri, 18 Sep 2026 02:00:00 GMT"
        response.status_code = 200
        response._content = b''
        response._content_consumed = True
        if request.method == 'PUT':
            body = request.body
            objects[key] = body if isinstance(body, bytes) else b''.join(body)
        elif key not in objects:
            response.status_code = 404
            response.headers['x-oss-err'] = base64.b64encode(b'<Error><Code>NoSuchKey</Code></Error>').decode()
        else:
            response.headers['Content-Length'] = str(len(objects[key]))
            if request.method == 'GET':
                response._content = objects[key]
        return response

    monkeypatch.setattr(requests.Session, 'send', send)
    store = storage.OSSObjectStore(replace(load(), storage_backend='oss',
        oss_region='cn-hangzhou', oss_bucket='test-bucket',
        oss_access_key_id='fake-id', oss_access_key_secret='fake-secret',
        oss_security_token='test-sts-token'))
    ref = await store.put_document(b'quiz', upload())
    assert await store.get_verified(ref) == b'quiz'
    assert set(methods) == {'HEAD', 'PUT', 'GET'}
