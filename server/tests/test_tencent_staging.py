"""Opt-in private COS staging, signed requests and paid-submit recovery boundaries."""

import hashlib
import json
from dataclasses import replace
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from langgraph.store.memory import InMemoryStore

from practiq_ai import config, tencent, tencent_staging
from practiq_ai.contracts import DocumentReference
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.execution import namespace
from tests.support import FakeObjectStore

provider = cast(Any, tencent)


@pytest.fixture
def cos_job(monkeypatch):
    for key, value in {'AI_TENCENT_SECRET_ID': 'synthetic-id', 'AI_TENCENT_SECRET_KEY': 'synthetic-secret',
                       'AI_TENCENT_COS_ENABLED': 'true', 'AI_TENCENT_COS_BUCKET': 'fixture-1250000000',
                       'AI_TENCENT_COS_REGION': 'ap-guangzhou'}.items():
        monkeypatch.setenv(key, value)
    payload = b'synthetic source'
    digest = hashlib.sha256(payload).hexdigest()
    reference = DocumentReference(sourceType='image', mediaType='image/png', objectKey='source',
                                  sizeBytes=len(payload), sha256=digest)
    files = FakeObjectStore({'source': payload})
    runtime = cast(Any, SimpleNamespace(store=InMemoryStore(), execution_info=SimpleNamespace(thread_id='t', run_id='r')))
    monkeypatch.setattr(tencent, 'get_object_store', lambda: files)
    monkeypatch.setattr(tencent, 'guard', AsyncMock())
    monkeypatch.setattr(tencent, 'run_remaining', AsyncMock(return_value=60))
    monkeypatch.setattr(tencent, 'upload_source', AsyncMock())
    monkeypatch.setattr(tencent, 'delete_source', AsyncMock())
    monkeypatch.setattr(tencent, 'download_result', AsyncMock(return_value=b'archive'))
    request = AsyncMock(side_effect=[{'TaskId': 'job', 'RequestId': 'submit'},
                                    {'Status': 'Success', 'ResultUrl': 'https://fixture.cos.ap-guangzhou.myqcloud.com/result.zip',
                                     'SuccessPageNum': 1, 'FailPageNum': 0}])
    monkeypatch.setattr(tencent, 'request', request)
    return reference, files, runtime


async def test_cos_opt_in_uses_only_file_url_and_reuses_local_result(cos_job):
    reference, files, runtime = cos_job
    result = await tencent.parse_job(reference, runtime)
    submitted = provider.request.await_args_list[0].args[1]
    assert 'FileBase64' not in submitted
    url = urlsplit(submitted['FileUrl'])
    assert url.scheme == 'https' and url.hostname == 'fixture-1250000000.cos.ap-guangzhou.myqcloud.com'
    assert url.path.endswith(reference.sha256)
    assert parse_qs(url.query)['q-header-list'] == ['host']
    assert not result['resultValidated'] and not result['staging']['deleted']
    async with tencent.validate_result(result, runtime, key='source'):
        pass
    assert result['staging']['deleted'] and 'q-signature' not in json.dumps(result)
    assert files.blobs['source'] == b'synthetic source'
    assert await tencent.parse_job(reference, runtime) == result
    assert provider.upload_source.await_count == provider.delete_source.await_count == 1
    assert provider.request.await_count == 2


async def test_upload_receipt_precedes_network_and_submit_intent_precedes_paid_call(cos_job):
    reference, _, runtime = cos_job
    async def upload(*_):
        record = await runtime.store.aget(namespace('t', 'tencent_jobs'), 'source')
        assert record.value['status'] == 'STAGING' and record.value['staging']['sha256'] == reference.sha256
    original = provider.request.side_effect
    async def request(action, *_):
        record = await runtime.store.aget(namespace('t', 'tencent_jobs'), 'source')
        if action.startswith('Submit'):
            assert record.value['status'] == 'SUBMITTING' and 'taskId' not in record.value
        return next(original)
    provider.upload_source.side_effect = upload
    provider.request.side_effect = request
    await tencent.parse_job(reference, runtime)


async def test_uncertain_upload_can_retry_without_repeating_paid_submission(cos_job):
    reference, _, runtime = cos_job
    provider.upload_source.side_effect = [DocumentProcessingError(502, 'upload lost', 'TENCENT_COS_UPLOAD_FAILED'), None]
    with pytest.raises(DocumentProcessingError, match='upload lost'):
        await tencent.parse_job(reference, runtime)
    provider.request.assert_not_awaited()
    record = await runtime.store.aget(namespace('t', 'tencent_jobs'), 'source')
    assert record.value['status'] == 'STAGING'
    await tencent.parse_job(reference, runtime)
    assert provider.upload_source.await_count == 2 and provider.request.await_count == 2
    assert provider.upload_source.await_args_list[0].args[0]['objectKey'] == provider.upload_source.await_args_list[1].args[0]['objectKey']
    assert provider.upload_source.await_args_list[0].args[1] == provider.upload_source.await_args_list[1].args[1]


async def test_unknown_paid_submission_keeps_source_and_never_uploads_or_submits_again(cos_job):
    reference, _, runtime = cos_job
    provider.request.side_effect = TimeoutError('lost submit acknowledgment')
    with pytest.raises(TimeoutError):
        await tencent.parse_job(reference, runtime)
    with pytest.raises(DocumentProcessingError) as error:
        await tencent.parse_job(reference, runtime)
    assert error.value.code == 'TENCENT_SUBMISSION_UNKNOWN'
    assert provider.request.await_count == provider.upload_source.await_count == 1
    provider.delete_source.assert_not_awaited()


async def test_cleanup_failure_keeps_saved_result_and_retries_only_cleanup(cos_job):
    reference, _, runtime = cos_job
    provider.delete_source.side_effect = [DocumentProcessingError(502, 'cleanup failed', 'TENCENT_COS_CLEANUP_FAILED'), None]
    downloaded = await tencent.parse_job(reference, runtime)
    with pytest.raises(DocumentProcessingError, match='COS cleanup failed'):
        async with tencent.validate_result(downloaded, runtime, key='source'):
            pass
    result = (await runtime.store.aget(namespace('t', 'tencent_jobs'), 'source')).value
    assert result['resultValidated'] and result['staging']['cleanupError'] == 'TENCENT_COS_CLEANUP_FAILED'
    result = await tencent.parse_job(reference, runtime)
    assert result['staging']['deleted'] and 'cleanupError' not in result['staging']
    assert provider.request.await_count == 2 and provider.upload_source.await_count == 1


async def test_invalid_download_keeps_cos_source_until_result_validation(cos_job):
    reference, files, runtime = cos_job
    downloaded = await tencent.parse_job(reference, runtime)
    invalid_ref = downloaded['resultRef']
    with pytest.raises(DocumentProcessingError):
        async with tencent.validate_result(downloaded, runtime, key='source'):
            raise DocumentProcessingError(502, 'Invalid JSON', 'TENCENT_RESULT_INVALID')
    provider.delete_source.assert_not_awaited()
    provider.request.side_effect = [{'Status': 'Success', 'ResultUrl': 'result', 'SuccessPageNum': 1, 'FailPageNum': 0}]
    provider.download_result.return_value = b'recovered archive'
    recovered = await tencent.parse_job(reference, runtime)
    provider.delete_source.assert_not_awaited()
    async with tencent.validate_result(recovered, runtime, key='source'):
        pass
    assert recovered['resultValidated'] and recovered['staging']['deleted']
    assert invalid_ref in recovered['invalidResultRefs'] and files.blobs[invalid_ref['objectKey']] == b'archive'
    assert provider.upload_source.await_count == provider.delete_source.await_count == 1
    assert [call.args[0] for call in provider.request.await_args_list] == [
        'SubmitMultimodalDocParseJob', 'DescribeMultimodalDocParseJob', 'DescribeMultimodalDocParseJob']


async def test_disabled_cos_does_not_upload_even_when_bucket_is_configured(cos_job, monkeypatch):
    reference, _, runtime = cos_job
    monkeypatch.setenv('AI_TENCENT_COS_ENABLED', 'false')
    await tencent.parse_job(reference, runtime)
    data = provider.request.await_args_list[0].args[1]
    assert 'FileBase64' in data and 'FileUrl' not in data
    provider.upload_source.assert_not_awaited()
    provider.delete_source.assert_not_awaited()


async def test_enabled_cos_without_bucket_fails_before_paid_work(cos_job, monkeypatch):
    reference, _, runtime = cos_job
    monkeypatch.delenv('AI_TENCENT_COS_BUCKET')
    monkeypatch.delenv('AI_TENCENT_COS_REGION')
    assert not config.load().parser_configured
    with pytest.raises(DocumentProcessingError) as error:
        await tencent.parse_job(reference, runtime)
    assert error.value.code == 'TENCENT_COS_NOT_CONFIGURED'
    provider.request.assert_not_awaited()
    provider.upload_source.assert_not_awaited()


@pytest.mark.parametrize('bucket,region', [('https://example.invalid', 'ap-guangzhou'), ('fixture-1250000000', 'evil.invalid'),
                                          ('fixture-1250000000', ''), ('', 'ap-guangzhou')])
def test_staging_configuration_rejects_urls_and_partial_settings(cos_job, monkeypatch, bucket, region):
    monkeypatch.setenv('AI_TENCENT_COS_BUCKET', bucket)
    monkeypatch.setenv('AI_TENCENT_COS_REGION', region)
    with pytest.raises(ValueError, match='AI_TENCENT_COS'):
        config.load()


def test_transport_limits_and_output_formats_are_fixed_by_source(cos_job):
    settings = config.load()
    assert tencent.submission_limit('text', settings) == 10 * 1024**2
    assert tencent.submission_limit('xlsx', settings) == 10 * 1024**2
    assert tencent.submission_limit('image', settings) == 30 * 1024**2
    assert tencent.submission_limit('pdf', settings) == 150 * 1024**2
    assert tencent.submission_limit('pdf', replace(settings, tencent_cos_enabled=False)) == 8 * 1024**2
    assert {key for key, value in tencent.RESULT_TYPES.items() if value == 2} == {'text', 'markdown'}
    assert all(value == 9 for key, value in tencent.RESULT_TYPES.items() if key not in {'text', 'markdown'})


@pytest.mark.parametrize('outcome', ['success', 'redirect', 'checksum', 'unavailable'])
async def test_cos_http_upload_signs_private_exact_bytes_and_rejects_unsafe_outcomes(cos_job, monkeypatch, outcome):
    reference, files, _ = cos_job
    settings = config.load()
    staging = tencent_staging.staging_object(settings, 't', 'source', reference.sha256)
    seen = []
    def respond(request):
        seen.append(request)
        assert request.url.host == 'fixture-1250000000.cos.ap-guangzhou.myqcloud.com'
        assert request.method == 'PUT' and request.content == files.blobs['source']
        assert request.headers['x-cos-acl'] == 'private'
        assert request.headers['x-cos-server-side-encryption'] == 'AES256'
        assert 'content-md5;' in request.headers['authorization']
        if outcome == 'unavailable':
            raise httpx.ConnectError('private-secret-body', request=request)
        return httpx.Response(302 if outcome == 'redirect' else 200,
                              headers={'Location': 'https://untrusted.invalid', 'ETag': 'bad' if outcome == 'checksum' else '"'+hashlib.md5(request.content, usedforsecurity=False).hexdigest()+'"'})
    original = httpx.AsyncClient
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(respond), **kwargs))
    if outcome == 'success':
        await tencent_staging.upload_source(staging, files.blobs['source'], reference.mediaType, settings)
    else:
        with pytest.raises(DocumentProcessingError) as error:
            await tencent_staging.upload_source(staging, files.blobs['source'], reference.mediaType, settings)
        assert error.value.code == 'TENCENT_COS_UPLOAD_FAILED' and 'private-secret-body' not in str(error.value)
    assert len(seen) == 1


async def test_delete_and_signed_url_are_confined_to_owned_prefix(cos_job, monkeypatch):
    reference, _, _ = cos_job
    settings = config.load()
    staging = tencent_staging.staging_object(settings, 't', 'source', reference.sha256)
    seen = []
    def respond(request):
        seen.append(request)
        assert request.method == 'DELETE' and request.url.path.startswith('/practiq-import/')
        return httpx.Response(204)
    original = httpx.AsyncClient
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(respond), **kwargs))
    await tencent_staging.delete_source(staging, settings)
    for invalid in [{**staging, 'objectKey': 'user-data/keep'}, {**staging, 'bucket': 'other-1250000000'},
                    {**staging, 'objectKey': staging['objectKey'].replace(reference.sha256, '0'*64)}]:
        with pytest.raises(DocumentProcessingError) as error:
            await tencent_staging.delete_source(invalid, settings)
        assert error.value.code == 'TENCENT_COS_CONFLICT'
        with pytest.raises(DocumentProcessingError):
            tencent_staging.source_url(invalid, settings)
    assert len(seen) == 1


async def test_cos_accepts_an_intact_source_above_base64_limit(cos_job):
    reference, files, runtime = cos_job
    payload = b'x' * (8 * 1024**2 + 1)
    files.blobs['source'] = payload
    reference = reference.model_copy(update={'sizeBytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest()})
    await tencent.parse_job(reference, runtime)
    assert provider.upload_source.await_args.args[1] == payload
    assert 'FileUrl' in provider.request.await_args_list[0].args[1]
    assert 'FileBase64' not in provider.request.await_args_list[0].args[1]


def test_cos_is_disabled_by_default_and_requires_explicit_boolean(cos_job, monkeypatch):
    monkeypatch.delenv('AI_TENCENT_COS_ENABLED')
    assert not config.load().tencent_cos_enabled and config.load().parser_configured
    monkeypatch.setenv('AI_TENCENT_COS_ENABLED', '1')
    with pytest.raises(ValueError, match='AI_TENCENT_COS_ENABLED'):
        config.load()


async def test_capabilities_report_the_enabled_transport_limit(cos_job, monkeypatch):
    from practiq_ai.webapp import import_capabilities
    capabilities = await import_capabilities()
    assert capabilities.parserConfigured and capabilities.parserInputMaxBytes == 150 * 1024**2
    monkeypatch.setenv('AI_TENCENT_COS_ENABLED', 'false')
    capabilities = await import_capabilities()
    assert capabilities.parserConfigured and capabilities.parserInputMaxBytes == 8 * 1024**2


@pytest.mark.usefixtures('disposable_databases')
async def test_cleanup_failure_keeps_prepare_incomplete_until_explicit_resume(monkeypatch):
    import base64
    from uuid import uuid4

    from practiq_ai import task_api
    from practiq_ai.contracts import DocumentTaskControl, DocumentTaskCreate
    from tests.db_support import setup_api

    service, reference, model = await setup_api(monkeypatch)
    for key, value in {'AI_TENCENT_COS_ENABLED':'true','AI_TENCENT_COS_BUCKET':'fixture-1250000000','AI_TENCENT_COS_REGION':'ap-guangzhou'}.items():
        monkeypatch.setenv(key, value)
    original_request = tencent.request
    calls = []
    async def request(action, data, settings):
        calls.append(action)
        if action == 'SubmitMultimodalDocParseJob':
            assert 'FileUrl' in data and 'FileBase64' not in data
            files = cast(FakeObjectStore, task_api.get_object_store())
            data = {**data, 'FileBase64':base64.b64encode(files.blobs[reference['objectKey']]).decode()}
        return await original_request(action, data, settings)
    monkeypatch.setattr(tencent, 'request', request)
    upload = AsyncMock()
    delete = AsyncMock(side_effect=[DocumentProcessingError(502,'temporary cleanup failure','TENCENT_COS_CLEANUP_FAILED'),None])
    monkeypatch.setattr(tencent, 'upload_source', upload)
    monkeypatch.setattr(tencent, 'delete_source', delete)
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(),document=DocumentReference.model_validate(reference)))
    await service.wait_idle()
    failed = await task_api.get_task(created['threadId'])
    assert failed['state'] == 'FAILED' and failed['blocking'] == ['TENCENT_COS_CLEANUP_FAILED']
    assert failed['parserJobs'][0]['resultSaved'] and not model.calls
    await task_api.review_task(created['threadId'])
    assert delete.await_count == 1
    await task_api.control_task(created['threadId'],DocumentTaskControl(requestId=uuid4(),action='resume',checkpointId=failed['checkpointId']))
    await service.wait_idle()
    assert (await task_api.get_task(created['threadId']))['state'] == 'COMPLETED'
    assert len(model.calls) == upload.await_count == 1 and delete.await_count == 2
    assert calls == ['SubmitMultimodalDocParseJob','DescribeMultimodalDocParseJob']


@pytest.mark.usefixtures('disposable_databases')
async def test_query_rejection_resumes_saved_task_without_another_submission(monkeypatch):
    from uuid import uuid4

    from practiq_ai import task_api
    from practiq_ai.contracts import DocumentTaskControl, DocumentTaskCreate
    from tests.db_support import setup_api
    service, reference, model = await setup_api(monkeypatch)
    original = tencent.request
    actions = []
    async def request(action, data, settings):
        actions.append(action)
        if action == 'DescribeMultimodalDocParseJob' and actions.count(action) == 1:
            raise tencent.RequestRejected('AuthFailure.SignatureFailure', 'query-request')
        return await original(action, data, settings)
    monkeypatch.setattr(tencent, 'request', request)
    created = await task_api.create_task(DocumentTaskCreate(requestId=uuid4(), document=DocumentReference.model_validate(reference)))
    await service.wait_idle()
    failed = await task_api.get_task(created['threadId'])
    assert failed['state'] == 'FAILED' and failed['blocking'] == ['TENCENT_QUERY_REJECTED']
    assert failed['allowedActions'] == ['resume'] and failed['parserJobs'][0]['taskId'] and not model.calls
    await task_api.control_task(created['threadId'], DocumentTaskControl(requestId=uuid4(), action='resume', checkpointId=failed['checkpointId']))
    await service.wait_idle()
    assert (await task_api.get_task(created['threadId']))['state'] == 'COMPLETED'
    assert actions.count('SubmitMultimodalDocParseJob') == 1 and len(model.calls) == 1
