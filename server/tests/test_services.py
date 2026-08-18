"""Service-level unit tests not requiring a database."""

import base64
from datetime import datetime, timedelta, timezone

import pytest

from server import envelope
from server.auth.runtime import User
from server.services import imports as imports_svc
from server.services import imports_upload
from server.services import media as media_svc
from server.services import users as users_svc
from server.services.practice import grade_practice_answer
from tests.fakes import FakeCursor, FakePool


def _user(membership: str = 'free', role: str = 'user') -> User:
    return User(id=1, username='u', email=None, is_active=True, role=role, membership=membership)


class _MembershipCursor:
    def __init__(self, membership: str, trial_ends_at=None):
        self.membership = membership
        self.trial_ends_at = trial_ends_at

    async def fetchone(self):
        return (self.membership, self.trial_ends_at)


class _MembershipConnection:
    def __init__(self, membership: str, trial_ends_at=None):
        self.membership = membership
        self.trial_ends_at = trial_ends_at

    async def execute(self, *_args):
        return _MembershipCursor(self.membership, self.trial_ends_at)


async def test_pro_entitlement_has_no_role_bypass():
    await users_svc.require_pro_entitlement(_MembershipConnection('pro'), _user('pro'), 'AI')
    for role in ('user', 'admin'):
        with pytest.raises(envelope.APIError) as exc_info:
            await users_svc.require_pro_entitlement(
                _MembershipConnection('free'), _user('free', role), 'AI'
            )
        assert exc_info.value.code == 'PRO_REQUIRED'


async def test_pro_entitlement_accepts_organization_and_active_trial():
    await users_svc.require_pro_entitlement(
        _MembershipConnection('organization'), _user('organization'), 'AI'
    )
    future = datetime.now(timezone.utc) + timedelta(days=1)
    await users_svc.require_pro_entitlement(
        _MembershipConnection('free', future), _user('free'), 'AI'
    )


async def test_pro_entitlement_rejects_expired_trial():
    past = datetime.now(timezone.utc) - timedelta(days=1)
    with pytest.raises(envelope.APIError) as exc_info:
        await users_svc.require_pro_entitlement(
            _MembershipConnection('free', past), _user('free'), 'AI'
        )
    assert exc_info.value.code == 'PRO_REQUIRED'


async def test_organization_entitlement():
    await users_svc.require_organization_entitlement(
        _MembershipConnection('organization'), _user('organization'), 'Study groups'
    )
    for membership_value, trial in (
        ('pro', None),
        ('free', datetime.now(timezone.utc) + timedelta(days=1)),
    ):
        with pytest.raises(envelope.APIError) as exc_info:
            await users_svc.require_organization_entitlement(
                _MembershipConnection(membership_value, trial), _user(membership_value), 'Study groups'
            )
        assert exc_info.value.code == 'ORGANIZATION_REQUIRED'


def test_llm_provider_validation():
    assert users_svc.LLM_PROVIDERS == {'dashscope', 'deepseek', 'moonshot'}
    with pytest.raises(envelope.APIError) as exc_info:
        users_svc._validate_llm_config(
            users_svc.LLMConfig('openai', 'key', 'text', None)
        )
    assert exc_info.value.status == 422
    assert exc_info.value.details[0]['field'] == 'provider'

    with pytest.raises(envelope.APIError) as exc_info:
        users_svc._validate_llm_config(
            users_svc.LLMConfig('deepseek', 'key', 'text', 'vision')
        )
    assert exc_info.value.status == 422
    assert exc_info.value.details[0] == {
        'field': 'visionModel',
        'message': 'DeepSeek does not support vision models',
    }


async def test_require_llm_config_rejects_stored_unknown_provider():
    pool = FakePool([
        ('SELECT membership', FakeCursor([('pro', None)])),
        ('SELECT llm_provider', FakeCursor([('openai', 'key', 'text', None)])),
    ])
    with pytest.raises(envelope.APIError) as exc_info:
        await users_svc.require_llm_config(pool, _user('pro'), 'secret', 'AI')
    assert exc_info.value.status == 422


async def test_save_llm_config_rejects_unknown_before_database():
    pool = FakePool()
    with pytest.raises(envelope.APIError):
        await users_svc.save_llm_config(
            pool,
            _user('pro'),
            'secret',
            users_svc.LLMConfig('gemini', 'key', 'text', None),
        )
    assert pool.record == []


async def test_llm_metadata_hides_stored_unknown_provider():
    pool = FakePool([
        ('SELECT llm_provider', FakeCursor([('openai', 'text', None, True)])),
    ])
    assert await users_svc.llm_config_metadata(pool, 1) == {
        'provider': None,
        'textModel': None,
        'visionModel': None,
        'configured': False,
    }


# ---------------------------------------------------------- practice grading


def _key(payload) -> dict:
    import json

    return {'id': 1, 'answer_payload': json.dumps(payload)}


def test_grade_choice_answer():
    key = _key({'selected': ['A', 'B']})
    assert grade_practice_answer('choice', key, {'selected': ['B', 'A']}) is True
    assert grade_practice_answer('choice', key, {'selected': ['A']}) is False


def test_grade_true_false_answer():
    key = _key({'value': True})
    assert grade_practice_answer('true_false', key, {'value': True}) is True
    assert grade_practice_answer('true_false', key, {'value': False}) is False
    assert grade_practice_answer('true_false', key, {'value': 'yes'}) is None


def test_grade_fill_blank_answer():
    key = _key({'value': ['Paris', ' France ']})
    assert grade_practice_answer('fill_blank', key, {'value': ['paris', 'france']}) is True
    assert grade_practice_answer('fill_blank', key, {'value': ['paris']}) is False
    assert grade_practice_answer('fill_blank', key, {'value': ['lyon', 'france']}) is False


def test_grade_without_key_returns_none():
    assert grade_practice_answer('choice', None, {'selected': ['A']}) is None


# ------------------------------------------------------- imports validation


def test_normalize_import_source_type():
    assert imports_svc.normalize_import_source_type('TXT') == 'txt'
    assert imports_svc.normalize_import_source_type('text') == 'txt'
    assert imports_svc.normalize_import_source_type('') == 'txt'
    assert imports_svc.normalize_import_source_type('docx') == 'docx'
    assert imports_svc.normalize_import_source_type('pdf') == 'pdf'
    assert imports_svc.normalize_import_source_type('csv') == 'csv'
    assert imports_svc.normalize_import_source_type('md') == 'md'
    assert imports_svc.normalize_import_source_type('image') == 'image'
    with pytest.raises(envelope.APIError) as exc_info:
        imports_svc.normalize_import_source_type('xls')
    assert exc_info.value.code == 'UNSUPPORTED_SOURCE_TYPE'


def test_decode_import_job_removes_internal_error_payload():
    assert imports_svc._decode_job(
        '{"id":1,"status":"failed","error_payload":{"secret":"x"}}'
    ) == {'id': 1, 'status': 'failed'}


def test_cancel_rejects_persisting_job():
    with pytest.raises(envelope.APIError) as exc_info:
        imports_svc._ensure_import_job_queue_action_allowed(
            {'status': 'processing', 'stage': 'persisting'}, 'cancel'
        )
    assert exc_info.value.status == 409
    assert exc_info.value.code == 'IMPORT_CANCEL_NOT_ALLOWED'


@pytest.mark.parametrize(
    ('action', 'status'), (('retry', 'failed'), ('cancel', 'queued'))
)
async def test_queue_transitions_delete_stale_checkpoints_in_transaction(
    action, status
):
    pool = FakePool([
        ('SELECT row_to_json(updated)', FakeCursor([
            ('{"id":99,"status":"queued","overall_progress_percent":0}',),
        ])),
    ])
    transition = imports_svc._queue_transition_for_action(action)
    await imports_svc._apply_import_queue_transition(
        pool, {'id': 99, 'status': status}, transition
    )

    deletes = [(sql, params) for sql, params in pool.record if 'DELETE FROM checkpoint' in sql]
    assert [sql.split()[2] for sql, _ in deletes] == [
        'checkpoint_writes', 'checkpoint_blobs', 'checkpoints'
    ]
    assert all(params == ('import:99',) for _, params in deletes)
    update_sql = pool.record[0][0]
    assert "stage <> 'persisting'" in update_sql


async def test_failure_payload_keeps_only_exception_type():
    pool = FakePool([
        ('INSERT INTO question_import_job_events', FakeCursor([
            ('{"id":7}',),
        ])),
        ("status = 'failed'", FakeCursor([
            ('{"id":99,"status":"failed","error_payload":{"hidden":"x"}}',),
        ])),
    ])
    result = await imports_svc.record_import_job_failure(
        pool, 99, 1, 'FAILED', RuntimeError('api-key-secret')
    )
    payload = pool.record[1][1][2]
    assert 'RuntimeError' in payload
    assert 'api-key-secret' not in payload
    assert 'error_payload' not in result


def test_decode_bounded_import_base64():
    payload = base64.b64encode(b'hello').decode()
    assert imports_svc.decode_bounded_import_base64(payload, 100) == b'hello'
    with pytest.raises(envelope.APIError) as exc_info:
        imports_svc.decode_bounded_import_base64('!!!invalid!!!', 100)
    assert exc_info.value.code == 'INVALID_FILE_CONTENT'
    with pytest.raises(envelope.APIError) as exc_info:
        imports_svc.decode_bounded_import_base64(base64.b64encode(b'x' * 200).decode(), 100)
    assert exc_info.value.code == 'FILE_TOO_LARGE'
    with pytest.raises(envelope.APIError) as exc_info:
        imports_svc.decode_bounded_import_base64(base64.b64encode(b'').decode(), 100)
    assert exc_info.value.code == 'EMPTY_FILE'


def test_validate_txt_payload():
    imports_svc.validate_import_source_payload('.txt', 'text/plain', '题目一'.encode(), 'a.txt')
    with pytest.raises(envelope.APIError) as exc_info:
        imports_svc.validate_import_source_payload('.txt', 'text/plain', b'\xff\xfe invalid', 'a.txt')
    assert exc_info.value.code == 'INVALID_FILE_CONTENT'
    with pytest.raises(envelope.APIError):
        imports_svc.validate_import_source_payload('.txt', 'text/plain', b'a\x00b', 'a.txt')
    with pytest.raises(envelope.APIError) as exc_info:
        imports_svc.validate_import_source_payload('.txt', 'text/plain', b'   ', 'a.txt')
    assert exc_info.value.code == 'EMPTY_FILE'


def test_validate_docx_payload():
    imports_svc.validate_import_source_payload('.docx', imports_svc.DOCX_MIME_TYPE, b'PK\x03\x04rest', 'a.docx')
    with pytest.raises(envelope.APIError) as exc_info:
        imports_svc.validate_import_source_payload('.docx', imports_svc.DOCX_MIME_TYPE, b'not-a-zip', 'a.docx')
    assert exc_info.value.code == 'UNSUPPORTED_FILE_TYPE'


def test_validate_pdf_payload():
    imports_svc.validate_import_source_payload('.pdf', imports_svc.PDF_MIME_TYPE, b'%PDF-1.7 body', 'a.pdf')
    with pytest.raises(envelope.APIError) as exc_info:
        imports_svc.validate_import_source_payload('.pdf', imports_svc.PDF_MIME_TYPE, b'not-a-pdf', 'a.pdf')
    assert exc_info.value.code == 'UNSUPPORTED_FILE_TYPE'
    with pytest.raises(envelope.APIError) as exc_info:
        imports_svc.validate_import_source_payload('.pdf', 'text/plain', b'%PDF-1.7 body', 'a.pdf')
    assert exc_info.value.code == 'UNSUPPORTED_FILE_TYPE'


def test_validate_xlsx_payload():
    imports_svc.validate_import_source_payload('.xlsx', imports_svc.XLSX_MIME_TYPE, b'PK\x03\x04rest', 'a.xlsx')
    with pytest.raises(envelope.APIError) as exc_info:
        imports_svc.validate_import_source_payload('.xlsx', imports_svc.XLSX_MIME_TYPE, b'not-a-zip', 'a.xlsx')
    assert exc_info.value.code == 'UNSUPPORTED_FILE_TYPE'
    with pytest.raises(envelope.APIError) as exc_info:
        imports_svc.validate_import_source_payload('.xlsx', imports_svc.DOCX_MIME_TYPE, b'PK\x03\x04rest', 'a.xlsx')
    assert exc_info.value.code == 'UNSUPPORTED_FILE_TYPE'


def test_validate_import_artifact_content_pdf_xlsx():
    pdf_b64 = base64.b64encode(b'%PDF-1.7 body').decode()
    imports_svc._validate_import_artifact_content(
        'pdf', {'fileBase64': pdf_b64, 'mimeType': imports_svc.PDF_MIME_TYPE}
    )
    xlsx_b64 = base64.b64encode(b'PK\x03\x04rest').decode()
    imports_svc._validate_import_artifact_content('xlsx', {'fileBase64': xlsx_b64})
    with pytest.raises(envelope.APIError) as exc_info:
        imports_svc._validate_import_artifact_content('pdf', {})
    assert exc_info.value.code == 'FILE_REQUIRED'
    with pytest.raises(envelope.APIError) as exc_info:
        imports_svc._validate_import_artifact_content('xlsx', {'fileBase64': pdf_b64})
    assert exc_info.value.code == 'UNSUPPORTED_FILE_TYPE'


def test_resolve_import_file_extension_pdf_xlsx():
    assert imports_upload._resolve_import_file_extension('a.pdf', '') == '.pdf'
    assert imports_upload._resolve_import_file_extension('a.xlsx', '') == '.xlsx'
    assert imports_upload._resolve_import_file_extension('a.csv', '') == '.csv'
    assert imports_upload._resolve_import_file_extension('a.md', '') == '.md'
    assert imports_upload._resolve_import_file_extension('a.png', '') == '.png'
    assert imports_upload._resolve_import_file_extension('blob', imports_svc.PDF_MIME_TYPE) == '.pdf'
    assert imports_upload._resolve_import_file_extension('blob', imports_svc.XLSX_MIME_TYPE) == '.xlsx'
    assert imports_upload._resolve_import_file_extension('blob', 'image/jpeg') == '.jpeg'
    with pytest.raises(envelope.APIError) as exc_info:
        imports_upload._resolve_import_file_extension('a.xls', '')
    assert exc_info.value.code == 'UNSUPPORTED_FILE_TYPE'


def test_build_import_source_artifact_content_binary_types():
    stored = imports_upload._StoredImportSource(
        relative_path='imports/1/2/source.pdf',
        object_url='oss://practiq/imports/1/2/source.pdf',
        original_name='a.pdf',
        mime_type=imports_svc.PDF_MIME_TYPE,
        size_bytes=12,
    )
    content = imports_upload._build_import_source_artifact_content(stored, 'pdf', b'%PDF-1.7body')
    assert base64.b64decode(content['fileBase64']) == b'%PDF-1.7body'
    assert 'text' not in content


async def test_list_import_events_after_uses_ascending_cursor():
    pool = FakePool([
        ('FROM question_import_job_events', FakeCursor([
            ('{"id":2,"status":"processing"}',),
            ('{"id":3,"status":"completed"}',),
        ])),
    ])
    events = await imports_svc.list_import_job_events_after(pool, 99, 1)
    assert [event['id'] for event in events] == [2, 3]
    sql, params = pool.record[0]
    assert 'id > %s' in sql and 'ORDER BY id' in sql and 'LIMIT 100' in sql
    assert params == (99, 1)


async def test_import_event_cursor_must_belong_to_job():
    exists = FakePool([('SELECT 1 FROM question_import_job_events', FakeCursor([(1,)]))])
    missing = FakePool([('SELECT 1 FROM question_import_job_events', FakeCursor([]))])
    assert await imports_svc.import_job_event_exists(exists, 99, 7) is True
    assert await imports_svc.import_job_event_exists(missing, 99, 7) is False


# ------------------------------------------------------------ media sniffing


def test_detect_image_content_type():
    assert media_svc._detect_image_content_type(b'\x89PNG\r\n\x1a\n....') == 'image/png'
    assert media_svc._detect_image_content_type(b'\xff\xd8\xff\xe0....') == 'image/jpeg'
    assert media_svc._detect_image_content_type(b'GIF89a....') == 'image/gif'
    assert media_svc._detect_image_content_type(b'RIFF\x00\x00\x00\x00WEBP....') == 'image/webp'
    assert media_svc._detect_image_content_type(b'plain text') == 'application/octet-stream'
