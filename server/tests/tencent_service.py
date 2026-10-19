"""E2E-only Uvicorn entrypoint with a durable synthetic Tencent boundary."""

import base64
import hashlib
import json
import os
import zipfile
from io import BytesIO
from pathlib import Path

from practiq_ai import tencent
from practiq_ai.webapp import app
from tests.support import ocr_text_page

__all__ = ["app"]

root = Path(os.environ["PRACTIQ_TEST_TENCENT_DIR"])
root.mkdir(parents=True, exist_ok=True)


async def request(action, data, config):
    if action == "SubmitMultimodalDocParseJob":
        payload = base64.b64decode(data["FileBase64"])
        identifier = hashlib.sha256(payload).hexdigest()
        if data["FileType"] in {5, 6}:
            page = ocr_text_page(payload.decode("utf-8-sig"))
        else:
            page = ocr_text_page("Synthetic recovery question", figures=[{"bbox": [0.1, 0.1, 0.8, 0.8]}])
        buffer = BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            if data["ResultType"] == 2:
                archive.writestr("fixture_md_full.md", payload.decode("utf-8-sig"))
            else:
                archive.writestr("fixture_ocr_page0.json", json.dumps(page))
        (root / (identifier + ".zip")).write_bytes(buffer.getvalue())
        result = {"TaskId": identifier, "RequestId": identifier}
    else:
        identifier = data["TaskId"]
        result = {"Status": "Success", "RequestId": identifier, "SuccessPageNum": 1, "FailPageNum": 0,
                  "ResultUrl": "https://fixture.cos.ap-guangzhou.myqcloud.com/" + identifier}
    with (root / "calls.jsonl").open("a") as log:
        log.write(json.dumps({"action": action, "taskId": identifier}) + "\n")
        log.flush()
        os.fsync(log.fileno())
    return result


async def download(url):
    return (root / (url.rsplit("/", 1)[1] + ".zip")).read_bytes()


tencent.request = request
tencent.download_result = download
