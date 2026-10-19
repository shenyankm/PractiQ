"""Private COS source staging; local storage remains authoritative."""

import base64
import hashlib
import hmac
import re
import time
from typing import Any
from urllib.parse import parse_qsl, quote, urlencode

import httpx

from .config import Config
from .errors import DocumentProcessingError

PREFIX = "practiq-import/"


def staging_object(config: Config, thread_id: str, unit: str, digest: str) -> dict[str, Any]:
    if not config.tencent_cos_bucket or not config.tencent_cos_region:
        raise DocumentProcessingError(503, "Configure a private Tencent COS bucket and region", "TENCENT_COS_NOT_CONFIGURED")
    identity = hashlib.sha256(f"{thread_id}/{unit}".encode()).hexdigest()
    return {"bucket": config.tencent_cos_bucket, "region": config.tencent_cos_region,
            "objectKey": f"{PREFIX}{identity}/{digest}", "sha256": digest, "deleted": False}


def _target(record: dict[str, Any], config: Config) -> tuple[str, str]:
    bucket, region, key = record.get("bucket"), record.get("region"), record.get("objectKey")
    if (bucket != config.tencent_cos_bucket or region != config.tencent_cos_region
            or not isinstance(key, str) or not re.fullmatch(r"practiq-import/[0-9a-f]{64}/[0-9a-f]{64}", key)
            or key.rsplit("/", 1)[-1] != record.get("sha256")):
        raise DocumentProcessingError(409, "COS staging reference does not belong to this source deployment", "TENCENT_COS_CONFLICT")
    return f"{bucket}.cos.{region}.myqcloud.com", "/" + key


def authorization(method: str, path: str, headers: dict[str, str], config: Config, start: int, ttl: int) -> str:
    """COS V5 signs selected headers and the exact object path; no query inputs."""
    key_time = f"{start};{start + ttl}"
    values = {quote(key.lower(), safe=""): quote(value, safe="") for key, value in headers.items()}
    names = sorted(values)
    canonical = f"{method.lower()}\n{path}\n\n" + "&".join(f"{key}={values[key]}" for key in names) + "\n"
    signing_key = hmac.new(config.tencent_secret_key.encode(), key_time.encode(), "sha1").hexdigest()
    string = f"sha1\n{key_time}\n{hashlib.sha1(canonical.encode()).hexdigest()}\n"
    signature = hmac.new(signing_key.encode(), string.encode(), "sha1").hexdigest()
    return (f"q-sign-algorithm=sha1&q-ak={config.tencent_secret_id}&q-sign-time={key_time}&q-key-time={key_time}"
            f"&q-header-list={';'.join(names)}&q-url-param-list=&q-signature={signature}")


def source_url(record: dict[str, Any], config: Config) -> str:
    host, path = _target(record, config)
    signed = authorization("GET", path, {"host": host}, config, int(time.time()) - 30, 3630)
    return f"https://{host}{path}?{urlencode(parse_qsl(signed, keep_blank_values=True))}"


async def upload_source(record: dict[str, Any], payload: bytes, media_type: str, config: Config) -> None:
    host, path = _target(record, config)
    if hashlib.sha256(payload).hexdigest() != record["sha256"]:
        raise DocumentProcessingError(409, "COS source checksum mismatch", "DOCUMENT_CHECKSUM_MISMATCH")
    headers = {"host": host, "content-type": media_type, "content-length": str(len(payload)),
               "content-md5": base64.b64encode(hashlib.md5(payload, usedforsecurity=False).digest()).decode(),
               "x-cos-acl": "private", "x-cos-server-side-encryption": "AES256"}
    headers["Authorization"] = authorization("PUT", path, headers, config, int(time.time()) - 30, 330)
    try:
        async with (httpx.AsyncClient(timeout=120, trust_env=False, follow_redirects=False) as client,
                    client.stream("PUT", f"https://{host}{path}", headers=headers, content=payload) as response):
            response.raise_for_status()
            if response.is_redirect:
                raise ValueError("Redirect refused")
            if response.headers.get("etag", "").strip('"') != hashlib.md5(payload, usedforsecurity=False).hexdigest():
                raise ValueError("COS returned an unexpected source checksum")
    except (httpx.HTTPError, ValueError) as exc:
        raise DocumentProcessingError(502, "Private COS source upload failed", "TENCENT_COS_UPLOAD_FAILED") from exc


async def delete_source(record: dict[str, Any], config: Config) -> None:
    host, path = _target(record, config)
    headers = {"host": host}
    headers["Authorization"] = authorization("DELETE", path, headers, config, int(time.time()) - 30, 330)
    try:
        async with (httpx.AsyncClient(timeout=30, trust_env=False, follow_redirects=False) as client,
                    client.stream("DELETE", f"https://{host}{path}", headers=headers) as response):
            response.raise_for_status()
            if response.is_redirect:
                raise ValueError("Redirect refused")
    except (httpx.HTTPError, ValueError) as exc:
        raise DocumentProcessingError(502, "Private COS source cleanup failed", "TENCENT_COS_CLEANUP_FAILED") from exc
