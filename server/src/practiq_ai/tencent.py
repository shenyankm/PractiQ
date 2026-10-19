"""Tencent asynchronous document jobs; durable intent precedes paid submission."""

import asyncio
import base64
import hashlib
import hmac
import json
import re
import time
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit

import httpx
from langgraph.runtime import Runtime
from pydantic import BaseModel, Field, StrictInt, ValidationError

from .config import Config, load
from .contracts import (
    OFFICE_SOURCE_TYPES,
    ArtifactReference,
    DocumentReference,
    DocumentSourceType,
)
from .errors import DocumentProcessingError
from .execution import guard, namespace, run_remaining, store_put
from .storage import get_object_store
from .temporary import preparation
from .tencent_staging import delete_source, source_url, staging_object, upload_source

HOST = "ocr.tencentcloudapi.com"
BASE64_LIMIT = 8 * 1024 * 1024
URL_LIMIT = 150 * 1024 * 1024
RESULT_LIMIT = 100 * 1024 * 1024
FILE_TYPES = {"pdf": 1, "doc": 2, "docx": 2, "ppt": 3, "pptx": 3, "xls": 4, "xlsx": 4, "markdown": 5, "text": 6, "image": 7}
RESULT_TYPES = {kind: 2 if kind in {"text", "markdown"} else 9 for kind in FILE_TYPES}
SOURCE_LIMITS = {kind: (10 if kind in {"text", "markdown", "xls", "xlsx"} else 30 if kind == "image" else 150) * 1024 * 1024
                 for kind in FILE_TYPES}


def submission_limit(kind: DocumentSourceType, config: Config) -> int:
    return min(config.tencent_input_max_bytes, SOURCE_LIMITS[kind], URL_LIMIT if config.tencent_cos_enabled else BASE64_LIMIT)


class RequestRejected(DocumentProcessingError):
    def __init__(self, code: str, request_id: Any):
        super().__init__(502, f"Tencent rejected the request ({code})", "TENCENT_REQUEST_REJECTED")
        self.request_id = request_id if isinstance(request_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", request_id) else None


class JobResult(BaseModel):
    Status: str
    RequestId: str | None = Field(default=None, max_length=128)
    ResultUrl: str | None = Field(default=None, max_length=16_384)
    FailedPages: list[dict[str, Any]] = Field(default_factory=list, max_length=300)
    SuccessPageNum: StrictInt | None = Field(default=None, ge=0, le=300)
    FailPageNum: StrictInt | None = Field(default=None, ge=0, le=300)


def signed_headers(action: str, payload: bytes, config: Config, timestamp: int) -> dict[str, str]:
    """Sign the exact JSON bytes, using the request timestamp's UTC date."""
    date = datetime.fromtimestamp(timestamp, UTC).strftime("%Y-%m-%d")
    signed = "content-type;host;x-tc-action"
    canonical = (f"POST\n/\n\ncontent-type:application/json\nhost:{HOST}\n"
                 f"x-tc-action:{action.lower()}\n\n{signed}\n{hashlib.sha256(payload).hexdigest()}")
    scope = f"{date}/ocr/tc3_request"
    string = f"TC3-HMAC-SHA256\n{timestamp}\n{scope}\n{hashlib.sha256(canonical.encode()).hexdigest()}"
    key = ("TC3" + config.tencent_secret_key).encode()
    for part in (date, "ocr", "tc3_request"):
        key = hmac.digest(key, part.encode(), "sha256")
    signature = hmac.new(key, string.encode(), "sha256").hexdigest()
    return {"Content-Type": "application/json", "Host": HOST, "X-TC-Action": action,
            "X-TC-Version": "2018-11-19", "X-TC-Timestamp": str(timestamp),
            "Authorization": f"TC3-HMAC-SHA256 Credential={config.tencent_secret_id}/{scope}, "
                             f"SignedHeaders={signed}, Signature={signature}"}


async def request(action: str, data: dict[str, Any], config: Config) -> dict[str, Any]:
    if not config.tencent_secret_id or not config.tencent_secret_key:
        raise DocumentProcessingError(503, "Configure Tencent document parsing credentials", "TENCENT_NOT_CONFIGURED")
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()
    try:
        async with httpx.AsyncClient(timeout=60, trust_env=False, follow_redirects=False) as client:
            async with client.stream("POST", f"https://{HOST}/", content=payload,
                                     headers=signed_headers(action, payload, config, int(time.time()))) as response:
                response.raise_for_status()
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(body) + len(chunk) > 65_536:
                        raise ValueError("API response exceeds its limit")
                    body.extend(chunk)
            result = json.loads(body)["Response"]
            if not isinstance(result, dict):
                raise TypeError("Invalid API envelope")
    except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
        # Exception strings may contain signed URLs or raw document content.
        raise DocumentProcessingError(502, "Tencent API response is unavailable or invalid", "TENCENT_API_UNAVAILABLE") from exc
    if error := result.get("Error"):
        code = error.get("Code", "Unknown") if isinstance(error, dict) else "Unknown"
        code = code if isinstance(code, str) and re.fullmatch(r"[A-Za-z0-9_.]{1,128}", code) else "Unknown"
        raise RequestRejected(code, result.get("RequestId"))
    return result


def validate_result_url(value: Any) -> str:
    """Only Tencent COS result hosts; never follow provider-supplied redirects."""
    if not isinstance(value, str):
        raise DocumentProcessingError(502, "Tencent result URL is missing", "TENCENT_RESULT_INVALID")
    try:
        url = urlsplit(value)
        valid = (url.scheme == "https" and url.hostname and not url.username and not url.password and not url.fragment
                 and url.port in {None, 443}
                 and re.fullmatch(r"[a-z0-9-]+\.cos\.[a-z0-9-]+\.myqcloud\.com", url.hostname))
    except ValueError:
        valid = False
    if not valid:
        raise DocumentProcessingError(502, "Tencent result URL is outside the allowed storage hosts", "TENCENT_RESULT_INVALID")
    return value


async def download_result(url: Any) -> bytes:
    url = validate_result_url(url)
    try:
        async with (httpx.AsyncClient(timeout=120, trust_env=False, follow_redirects=False) as client,
                    client.stream("GET", url) as response):
            response.raise_for_status()
            if response.is_redirect:
                raise ValueError("Redirect refused")
            output = bytearray()
            async for chunk in response.aiter_bytes():
                if len(output) + len(chunk) > RESULT_LIMIT:
                    raise ValueError("Result exceeds byte limit")
                output.extend(chunk)
            return bytes(output)
    except (httpx.HTTPError, ValueError) as exc:
        raise DocumentProcessingError(502, "Tencent result download failed", "TENCENT_DOWNLOAD_FAILED") from exc


async def _cleanup_source(record: dict[str, Any], runtime: Runtime[Any], key: str, config: Config) -> None:
    staging = record.get("staging")
    if not staging or staging.get("deleted"):
        return
    try:
        await delete_source(staging, config)
    except DocumentProcessingError as exc:
        staging["cleanupError"] = exc.code
    else:
        staging["deleted"] = True
        staging.pop("cleanupError", None)
    await store_put(runtime, "tencent_jobs", key, record)
    if staging.get("cleanupError"):
        raise DocumentProcessingError(502, "COS cleanup failed; explicitly resume to retry cleanup without resubmitting recognition", "TENCENT_COS_CLEANUP_FAILED")


async def parse_job(reference: ArtifactReference, runtime: Runtime[Any], *, key: str = "source",
                    source_type: DocumentSourceType | None = None, source_sha256: str | None = None) -> dict[str, Any]:
    """Resume a known job; an unacknowledged submission is never replayed."""
    config = load()
    source_type = source_type or (reference.sourceType if isinstance(reference, DocumentReference) else None)
    info = runtime.execution_info
    if runtime.store is None or info is None or info.thread_id is None:
        raise DocumentProcessingError(503, "Tencent parsing requires a persistent Store", "EXECUTION_STORE_REQUIRED")
    if not config.tencent_secret_id or not config.tencent_secret_key:
        raise DocumentProcessingError(503, "Configure Tencent document parsing credentials", "TENCENT_NOT_CONFIGURED")
    store = await asyncio.to_thread(get_object_store)
    previous = await runtime.store.aget(namespace(info.thread_id, "tencent_jobs"), key, refresh_ttl=False)
    record: dict[str, Any] | None = dict(previous.value) if previous else None
    if record and record.get("sourceSha256") != reference.sha256:
        raise DocumentProcessingError(409, "Tencent job belongs to another source", "TENCENT_JOB_CONFLICT")
    if record and record.get("resultRef"):
        await store.get_verified(ArtifactReference.model_validate(record["resultRef"]))
        await _cleanup_source(record, runtime, key, config)
        return record
    if record and record.get("status") == "REJECTED":
        await _cleanup_source(record, runtime, key, config)
        raise DocumentProcessingError(502, "Tencent rejected the original submission; explicitly parse again after correcting the cause",
                                      "TENCENT_REQUEST_REJECTED")
    if record is None or record.get("status") == "STAGING":
        payload = await store.get_verified(reference)
        if source_type not in FILE_TYPES:
            raise DocumentProcessingError(422, "Source type has no Tencent document mapping", "TENCENT_SOURCE_UNSUPPORTED")
        if len(payload) > submission_limit(source_type, config):
            raise DocumentProcessingError(413, "Split the source before Tencent submission", "TENCENT_SOURCE_TOO_LARGE")
        await guard(runtime)
        data: dict[str, Any] = {"FileType": FILE_TYPES[source_type], "ResultType": RESULT_TYPES[source_type],
                                "EnableSubImg": RESULT_TYPES[source_type] == 9, "TaskType": 0}
        if source_type in OFFICE_SOURCE_TYPES:
            data["FileEndPageNumber"] = config.max_document_pages
        if config.tencent_cos_enabled:
            staging = staging_object(config, info.thread_id, key, reference.sha256)
            if record is None:
                record = {"sourceSha256": reference.sha256, "status": "STAGING", "staging": staging,
                          "resultType": RESULT_TYPES[source_type]}
                await store_put(runtime, "tencent_jobs", key, record)
            elif record.get("staging") != staging:
                raise DocumentProcessingError(409, "COS staging belongs to another deployment", "TENCENT_COS_CONFLICT")
            await upload_source(staging, payload, reference.mediaType, config)
            await guard(runtime)
            data["FileUrl"] = source_url(staging, config)
        else:
            if record is not None:
                raise DocumentProcessingError(409, "COS staging cannot resume in local-only mode", "TENCENT_COS_CONFLICT")
            record = {"sourceSha256": reference.sha256, "resultType": RESULT_TYPES[source_type]}
            data["FileBase64"] = base64.b64encode(payload).decode()
        record.update(status="SUBMITTING", submittedAt=datetime.now(UTC).isoformat())
        await store_put(runtime, "tencent_jobs", key, record)
        try:
            result = await request("SubmitMultimodalDocParseJob", data, config)
        except DocumentProcessingError as exc:
            if exc.code == "TENCENT_REQUEST_REJECTED":
                record["status"] = "REJECTED"
                if isinstance(exc, RequestRejected):
                    record["requestId"] = exc.request_id
                await store_put(runtime, "tencent_jobs", key, record)
                await _cleanup_source(record, runtime, key, config)
            raise
        task_id = result.get("TaskId")
        if not isinstance(task_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", task_id):
            raise DocumentProcessingError(502, "Tencent submission returned no valid task ID", "TENCENT_SUBMISSION_UNKNOWN")
        request_id = result.get("RequestId")
        if request_id is not None and (not isinstance(request_id, str) or len(request_id) > 128):
            request_id = None
        record.update(taskId=task_id, requestId=request_id, status="Created")
        await store_put(runtime, "tencent_jobs", key, record)
    if not record.get("taskId"):
        raise DocumentProcessingError(409, "Previous Tencent submission has an unknown outcome; do not resubmit automatically",
                                      "TENCENT_SUBMISSION_UNKNOWN")
    while True:
        await guard(runtime)
        remaining = await run_remaining(runtime)
        try:
            result = JobResult.model_validate(await request("DescribeMultimodalDocParseJob", {"TaskId": record["taskId"]}, config)).model_dump()
        except ValidationError as exc:
            raise DocumentProcessingError(502, "Tencent returned invalid job metadata", "TENCENT_RESULT_INVALID") from exc
        status = result.get("Status")
        if status not in {"Created", "Processing", "Success", "Failed", "Unknown"}:
            raise DocumentProcessingError(502, "Tencent returned an invalid task status", "TENCENT_RESULT_INVALID")
        record.update(status=status, queryRequestId=result.get("RequestId"))
        if status == "Success":
            for name in ("FailedPages", "SuccessPageNum", "FailPageNum"):
                record[name] = result.get(name)
        await store_put(runtime, "tencent_jobs", key, record)
        if status == "Success":
            # Download bytes and the immutable copy coexist until storage completes.
            async with preparation(RESULT_LIMIT * 2):
                payload = await download_result(result.get("ResultUrl"))
                artifact = await store.put_artifact(payload, source_sha256=source_sha256 or reference.sha256,
                                                    kind="tencent-result", index=0, media_type="application/octet-stream")
            record["resultRef"] = artifact.model_dump(mode="json")
            await store_put(runtime, "tencent_jobs", key, record)
            await _cleanup_source(record, runtime, key, config)
            return record
        if status in {"Failed", "Unknown"}:
            if status == "Failed":
                await _cleanup_source(record, runtime, key, config)
            raise DocumentProcessingError(502, f"Tencent document job is {status}; the original task ID is retained",
                                          "TENCENT_JOB_FAILED" if status == "Failed" else "TENCENT_JOB_UNKNOWN")
        await asyncio.sleep(min(3, remaining))
