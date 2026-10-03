"""Compare grading image validation and event-loop delays without model calls."""
import argparse
import asyncio
import base64
import hashlib
import io
import json
import os
import statistics
import time
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

from PIL import Image

from practiq_ai.grading import GradeRequest, GradeWireRequest, digest_payload

with patch.dict(os.environ, AI_SERVICE_TOKEN="synthetic-benchmark", AI_READ_ONLY="1", AI_DESKTOP_MODE="1"):
    from practiq_ai import webapp


async def image_message(request: GradeRequest) -> dict:
    # Replace the model/database stage only; use the production image verifier.
    urls = await asyncio.to_thread(lambda: [image.verified_url() for image in request.images])
    return {"images": urls}


async def probe(request: GradeWireRequest, expected_url: str, threaded: bool) -> dict:
    gaps: list[float] = []
    running = True

    async def heartbeat() -> None:
        previous = time.perf_counter()
        while running:
            await asyncio.sleep(0.001)
            current = time.perf_counter()
            gaps.append((current - previous) * 1000)
            previous = current

    ticker = asyncio.create_task(heartbeat())
    await asyncio.sleep(0.002)
    started = time.perf_counter()
    try:
        if threaded:
            with patch.object(webapp, "grade", image_message):
                response = await webapp.subjective_grade(request)
        else:
            verified = request.verified_request()
            # The former implementation verified again while building the message.
            for image in verified.images:
                image._verified_input = None
            response = {"images": [image.verified_url() for image in verified.images]}
        elapsed = (time.perf_counter() - started) * 1000
        assert response["images"] == [expected_url]
        await asyncio.sleep(0.002)
    finally:
        running = False
        await ticker
    return {"durationMs": elapsed, "maxHeartbeatGapMs": max(gaps)}


async def run(width: int, height: int, rounds: int) -> dict:
    with Image.frombytes("RGB", (width, height), os.urandom(width * height * 3)) as image:
        buffer = io.BytesIO()
        image.save(buffer, format="PNG", compress_level=0)
    raw = buffer.getvalue()
    image_data = "data:image/png;base64," + base64.b64encode(raw).decode()
    inner = json.dumps({
        "question": {"stem": "Identify the image", "answerMode": "short_answer", "answerPayload": {"text": "Image"}},
        "answer": "Image", "maxCents": 500,
        "images": [{"sha256": hashlib.sha256(raw).hexdigest(), "data": image_data}],
    })
    assert len(raw) <= 20 * 1024 * 1024 and len(inner.encode()) <= 32 * 1024 * 1024
    request = GradeWireRequest(requestId=uuid4(), inputDigest=digest_payload(inner), payload=inner)
    report: dict = {
        "imageBytes": len(raw), "payloadBytes": len(inner.encode()), "dimensions": [width, height],
        "rounds": rounds, "modelCalls": 0, "outputsEqual": True,
        "scope": "Inner payload validation and model image assembly. After calls the production endpoint with a message stub. Excludes HTTP outer JSON, authentication/admission, database and model; CPython GIL may still delay the heartbeat.",
    }
    samples: dict[str, list[dict]] = {"before": [], "after": []}
    for _ in range(rounds):
        for name, threaded in (("before", False), ("after", True)):
            samples[name].append(await probe(request, image_data, threaded))
    for name, rows in samples.items():
        report[name] = {
            "samples": rows,
            "medianDurationMs": statistics.median(row["durationMs"] for row in rows),
            "medianMaxHeartbeatGapMs": statistics.median(row["maxHeartbeatGapMs"] for row in rows),
        }
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--width", type=int, default=3000)
    parser.add_argument("--height", type=int, default=2000)
    args = parser.parse_args()
    if not 1 <= args.rounds <= 100:
        parser.error("--rounds must be between 1 and 100")
    if min(args.width, args.height) < 1 or args.width * args.height > 6_500_000:
        parser.error("Positive dimensions with at most 6,500,000 RGB pixels keep the synthetic PNG within the image byte limit")
    report = asyncio.run(run(args.width, args.height, args.rounds))
    content = json.dumps(report, indent=2) + "\n"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(content, encoding="utf-8")
    print(content, end="")


if __name__ == "__main__":
    main()
